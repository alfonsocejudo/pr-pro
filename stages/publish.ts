// Publish — delivers the verified review to the PR thread, behind an
// operator preview. The dialog (shared with the fixture twin via
// ./review-preview.ts) shows exactly what will be posted — a
// Formatted/Edit toggle renders the markdown or the editable source
// text — and waits for the operator to confirm; a cancel collects an
// optional reason and drops the ticket as an operator decision, not an
// error. Once confirmed, the `verifiedReview` report the Evidence stage
// produced is posted as a comment on the ticket's pull request through
// the repo's bound connection (ctx.connections.request). These tickets
// are minted by the pr-scan stage, not a TicketSource, so
// ctx.postTicketComment has no source to match — the provider API is the
// write path.
//
// Delivery is load-bearing: a review that never reaches the PR thread
// may as well not have run, so any provider failure aborts the ticket
// and parks it at Attention with the report still in the run summary.
// From there the `retry-post` recovery action re-sends it. The failure
// modes that strand a finished review — an expired token, a revoked
// scope, the host down — are all fixed outside the app, and the review
// itself survives them intact on the attention sidecar.
import { readScreenshots, runPreviewGate, type ReviewShot } from "./review-preview.ts";
// Type-only import — erased when the stage loads; stage-types.d.ts
// (app-written, next to workflow.json) carries the contract.
import type {
  Connection,
  RecoveryRunContext,
  RepoConfig,
  Stage,
  StageConnectionsAccess,
  StageContext,
  StageLogger,
  StageOutcome,
  Ticket,
} from "../stage-types";
import { MACHINE_LOOP_MS, createStatePacer } from "./machine-pacing";

/** What posting a review needs from its caller. Both a live `StageContext`
 *  and a `RecoveryRunContext` satisfy it, so one delivery path serves the
 *  stage and its retry action. */
interface DeliveryContext {
  readonly log: StageLogger;
  readonly connections: StageConnectionsAccess;
}

/** Provider-specific comment endpoint for the PR the ticket points at.
 *  Each provider both locates the PR from its web URL — the number comes
 *  back so a caller can read the thread it is about to post to — and
 *  shapes the comment payload its API expects. */
function commentRequest(
  provider: Connection["provider"],
  sourceUrl: string,
  body: string,
): { path: string; body: unknown; number: number } | null {
  if (provider === "gitlab") {
    // https://host/group/subgroup/project/-/merge_requests/42
    const m = sourceUrl.match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/);
    if (!m) return null;
    return {
      path: `/projects/${encodeURIComponent(m[1])}/merge_requests/${m[2]}/notes`,
      body: { body },
      number: Number(m[2]),
    };
  }
  if (provider === "github") {
    // https://github.com/owner/repo/pull/42 — PR comments ride the issues API.
    const m = sourceUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m) return null;
    return {
      path: `/repos/${m[1]}/${m[2]}/issues/${m[3]}/comments`,
      body: { body },
      number: Number(m[3]),
    };
  }
  if (provider === "bitbucket") {
    // https://bitbucket.org/workspace/repo/pull-requests/42
    const m = sourceUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/);
    if (!m) return null;
    return {
      path: `/repositories/${m[1]}/${m[2]}/pullrequests/${m[3]}/comments`,
      body: { content: { raw: body } },
      number: Number(m[3]),
    };
  }
  return null;
}

/** The repo the ticket is pinned to and the account bound to it — the pair
 *  every post travels through. Returns the operator-facing reason instead
 *  when either is missing. */
function resolveTarget(
  ticket: Ticket,
  repos: readonly RepoConfig[],
  connections: StageConnectionsAccess,
): { repo: RepoConfig; connection: Connection } | { error: string } {
  const repo = repos.find((r) => r.name === ticket.pinnedRepo);
  const connection = repo ? connections.list().find((c) => c.id === repo.connectionId) : undefined;
  if (!repo || !connection) {
    return {
      error: `Repo "${ticket.pinnedRepo}" has no bound account to post the review with — set one under General → Local repositories.`,
    };
  }
  return { repo, connection };
}

/**
 * Upload the evidence screenshots to the PR's project through the
 * provider-agnostic facade (ctx.connections.uploadCommentImage — each
 * provider's delivery strategy lives in the app's connector, not here)
 * and return a markdown "## Screenshots" section embedding them. Takes
 * the shots the preview confirmed, so an image the operator unchecked
 * never leaves the machine. Upload failures skip the affected image with
 * a Console note — the review text is the load-bearing payload, the
 * images are enhancement.
 */
async function uploadScreenshotsSection(
  ctx: DeliveryContext,
  connection: Connection,
  repoPath: string,
  screenshots: { dir: string; shots: readonly ReviewShot[] },
): Promise<string> {
  const { dir, shots } = screenshots;
  if (shots.length === 0 || !dir || !repoPath) return "";
  const lines: string[] = [];
  for (const s of shots) {
    let uploaded;
    try {
      uploaded = await ctx.connections.uploadCommentImage(
        connection.id,
        repoPath,
        `${dir}/${s.file}`,
      );
    } catch (err) {
      ctx.log(
        `Skipping screenshot ${s.file} — upload failed: ${err instanceof Error ? err.message : String(err)}`,
        "warn",
      );
      continue;
    }
    const label = `${s.phase === "before" ? "Before" : "After"}${s.caption ? ` — ${s.caption}` : ""}`;
    lines.push(`**${label}**\n\n${uploaded.markdown}`);
  }
  if (lines.length === 0) return "";
  return `\n\n## Screenshots\n\n${lines.join("\n\n")}`;
}

/**
 * Post the review to the PR thread: upload the screenshots riding along,
 * fold them into the comment body, and send it through the repo's bound
 * account. Returns null on success, or the operator-facing failure
 * reason. Each send owns its uploads, so the attachment links in the
 * comment are the ones this send minted.
 */
async function deliverReview(
  ctx: DeliveryContext,
  args: {
    connection: Connection;
    repoPath: string;
    sourceUrl: string;
    review: string;
    screenshots: { dir: string; shots: readonly ReviewShot[] };
  },
): Promise<string | null> {
  const { connection, repoPath, sourceUrl, review, screenshots } = args;
  const screenshotsSection = await uploadScreenshotsSection(ctx, connection, repoPath, screenshots);
  const req = commentRequest(connection.provider, sourceUrl, review + screenshotsSection);
  if (!req) return `Can't derive a ${connection.provider} comment endpoint from ${sourceUrl}.`;
  ctx.log(`Posting the review to ${sourceUrl}…`);
  const res = await ctx.connections.request(connection.id, {
    method: "POST",
    path: req.path,
    body: req.body,
  });
  if (res.ok) return null;
  const detail = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
  return `Posting the review failed (HTTP ${res.status}): ${(detail ?? "").slice(0, 300)}`;
}

/** How much of the review's opening identifies it on the thread. Long
 *  enough that two distinct reviews of the same PR can't collide, short
 *  enough to survive whatever the provider does to a long comment body. */
const POSTED_MATCH_CHARS = 400;

/** The review's opening, whitespace-collapsed, as it is compared against
 *  what the thread already carries. */
function postedFingerprint(review: string): string {
  return review.trim().replace(/\s+/g, " ").slice(0, POSTED_MATCH_CHARS);
}

/**
 * Whether the thread already carries this review. A post can reach the
 * provider and still come back a failure, and the operator can click
 * Recover twice, so the retry reads the thread before adding to it. The
 * comparison is on the opening of the review text: screenshot links are
 * minted per upload, so only the prose is stable across sends. A thread
 * that can't be read counts as not carrying it — delivery is the point of
 * the action, and a missing review costs more than a repeated one.
 */
async function alreadyPosted(
  ctx: DeliveryContext,
  args: { connection: Connection; repoPath: string; prNumber: number; review: string },
): Promise<boolean> {
  const { connection, repoPath, prNumber, review } = args;
  if (!repoPath || !Number.isFinite(prNumber)) return false;
  let comments;
  try {
    comments = await ctx.connections.listMergeRequestComments(connection.id, repoPath, prNumber);
  } catch (err) {
    ctx.log(
      `Couldn't read the thread to check for an earlier post: ${err instanceof Error ? err.message : String(err)}`,
      "warn",
    );
    return false;
  }
  const fingerprint = postedFingerprint(review);
  return comments.some((c) => postedFingerprint(c.body) === fingerprint);
}

export default function createStage() {
  return {
    name: "publish",
    version: "5",
    // Declaring the publish target is what puts this stage's connection in
    // front of the app's credential check — on Start, and on a recovery
    // that resumes here — so a credential that needs re-authorizing stops
    // the operator at the button instead of after the whole review has run.
    preflight: { requiresPublishTarget: true },
    async run(ctx: StageContext): Promise<StageOutcome> {
      const ticket = ctx.state.ticket;
      // Machine states drive the artwork in stages/publish.svg: the review
      // is cued on preview, held there while the operator can still stop
      // it, then taken to program when the fader comes down.
      const pacer = createStatePacer(ctx.machine, ctx.signal);
      const review = ctx.state.verifiedReview;
      if (typeof review !== "string" || review.trim().length === 0) {
        return {
          status: "abort",
          error: new Error(
            "No review to deliver — the Evidence stage wrote nothing to verifiedReview.",
          ),
        };
      }
      if (!ticket?.sourceUrl) {
        return {
          status: "abort",
          error: new Error("The ticket has no PR URL to comment on."),
        };
      }

      const target = resolveTarget(ticket, ctx.repos, ctx.connections);
      if ("error" in target) {
        return { status: "abort", error: new Error(target.error) };
      }
      const { repo, connection } = target;

      // Derivability check up front: a URL shape no provider endpoint can
      // be built from aborts before the operator is shown a preview.
      if (!commentRequest(connection.provider, ticket.sourceUrl, review)) {
        return {
          status: "abort",
          error: new Error(
            `Can't derive a ${connection.provider} comment endpoint from ${ticket.sourceUrl}.`,
          ),
        };
      }

      const screenshots = readScreenshots(ctx.state);
      // Endpoint derived, shots read, line selected — the post is cued.
      await pacer.showState("cueing");

      // What actually gets posted: the Evidence stage's text and shots,
      // or the operator's edit and screenshot selection from the preview.
      let posting = review;
      let shots: readonly ReviewShot[] = screenshots.shots;

      // A 24/7-launched run has no operator to confirm the preview — the
      // Evidence stage's verification is the gate on unattended runs.
      if (ctx.state.unattended === true) {
        ctx.log("Unattended run — posting without operator confirmation.");
      } else {
        // Held by a person, not a timer: this is the one state in the
        // workflow that can sit still for minutes.
        await pacer.showState("previewing");
        const decision = await runPreviewGate(ctx, ticket, review, screenshots.shots);
        if (!decision.confirmed) return decision.outcome;
        posting = decision.review;
        shots = decision.shots;
        // `verifiedReview` and `reviewScreenshots` are what the run summary
        // reports, what the skip-posting recovery leaves behind, and what
        // the retry re-sends — so they hold the exact text and images the
        // operator confirmed.
        ctx.state.verifiedReview = posting;
        ctx.state.reviewScreenshots = { dir: screenshots.dir, shots };
      }

      // Uploads happen only after confirmation (or unattended) — nothing
      // reaches the provider while the operator can still cancel.
      await pacer.showState("transmitting");
      const failure = await deliverReview(ctx, {
        connection,
        repoPath: repo.path,
        sourceUrl: ticket.sourceUrl,
        review: posting,
        screenshots: { dir: screenshots.dir, shots },
      });
      if (failure) return { status: "abort", error: new Error(failure) };

      ctx.log(`Review posted to ${ticket.key}.`, "success");
      // Out, and nothing to recall. A held beat, not a resting look — the
      // runner emits its own terminal machine:state as soon as this returns.
      await pacer.showState("on-air");
      await pacer.settle(MACHINE_LOOP_MS);
      return { status: "continue" };
    },
    recoveryActions: [
      {
        id: "retry-post",
        label: "Post the review again",
        hint: "Send the same review again — for a post that did not go through, after fixing the account the repo posts with",
        matches: (failure) => failure.failedStage === "publish" && failure.failureKind !== "filter",
        async run(ctx: RecoveryRunContext) {
          // The failed run's shared state rides in on ctx.state via the
          // attention sidecar's snapshot: `verifiedReview` is the text the
          // operator confirmed in the preview, `reviewScreenshots` the
          // images they left checked. This action re-sends exactly that.
          // A recovery run has no machine to open a dialog on, and the
          // review the operator approved stands as approved.
          const ticket = ctx.ticket;
          const review =
            typeof ctx.state.verifiedReview === "string" ? ctx.state.verifiedReview.trim() : "";
          if (review.length === 0) {
            throw new Error("Nothing to post — the failed run left no review behind.");
          }
          if (!ticket.sourceUrl) throw new Error("The ticket has no PR URL to comment on.");

          const target = resolveTarget(ticket, ctx.repos, ctx.connections);
          if ("error" in target) throw new Error(target.error);
          const { repo, connection } = target;

          const req = commentRequest(connection.provider, ticket.sourceUrl, review);
          if (!req) {
            throw new Error(
              `Can't derive a ${connection.provider} comment endpoint from ${ticket.sourceUrl}.`,
            );
          }

          if (
            await alreadyPosted(ctx, {
              connection,
              repoPath: repo.path,
              prNumber: req.number,
              review,
            })
          ) {
            ctx.log("The review is already on the thread — nothing re-posted.", "success");
            return;
          }

          const failure = await deliverReview(ctx, {
            connection,
            repoPath: repo.path,
            sourceUrl: ticket.sourceUrl,
            review,
            screenshots: readScreenshots(ctx.state),
          });
          // A throw re-parks the ticket with a fresh sidecar, so a retry
          // that fails again lands the operator back on this same button.
          if (failure) throw new Error(failure);
          ctx.log(`Review posted to ${ticket.key}.`, "success");
        },
      },
      {
        id: "skip-delivery",
        label: "Continue without posting",
        hint: "Leave the review in the run summary only and resume the run",
        matches: (failure) => failure.failedStage === "publish" && failure.failureKind !== "filter",
        async run(ctx) {
          ctx.log(
            "Skipped posting to the PR — the review stays in the run summary's verifiedReview.",
            "warn",
          );
        },
      },
    ],
  } satisfies Stage;
}
