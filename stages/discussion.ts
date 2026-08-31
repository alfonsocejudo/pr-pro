// Discussion — reads the comments already on the ticket's pull request
// and renders them as the prompt block every downstream review stage
// splices in. A review that repeats what a human said last week, or that
// re-raises a finding this workflow itself posted on the previous round,
// is noise on the thread; the reviewers can only avoid that if they can
// see the conversation they are joining.
//
// The block carries no heading of its own: each consuming stage labels it,
// so the AI Agent stage downstream can splice it in under the generic
// "## <input name>" heading its scaffold writes.
//
// No LLM and no checkout — one provider read through the repo's bound
// account (ctx.connections.listMergeRequestComments, which resolves the
// project from the repo folder's own git remotes and flattens each
// provider's discussion model into `{author, body, createdAt,
// resolvable, resolved}`). Provider system notes never reach here; the
// facade drops them.
//
// The read is best-effort. A provider failure writes a block that says
// the discussion could not be read, so the reviewers know they are
// working blind instead of assuming an empty thread — and the review
// still runs, since a review with no context beats no review at all.
//
// Ordering is deliberate: this runs before the Correctness stage's
// PR-freshness gate, so a pull request that settled while the ticket
// waited costs one wasted read before that stage filters it.

// Type-only import — erased when the stage loads, so this file stays
// runtime-self-contained; stage-types.d.ts (app-written, next to
// workflow.json) carries the contract.
import type {
  MergeRequestComment,
  Stage,
  StageContext,
  StageOutcome,
} from "../stage-types";

import { createStatePacer, MACHINE_LOOP_MS } from "./machine-pacing.ts";

/**
 * Newest comments kept when a thread runs long. The tail of a
 * conversation is the part still in play, so the drop takes from the
 * front — and the block says how many it dropped rather than quietly
 * shortening the history.
 */
const MAX_COMMENTS = 40;

/** Per-comment body ceiling. Long pastes (stack traces, whole diffs) are
 *  cut with a marker so one comment can't crowd out the rest. */
const MAX_BODY_CHARS = 2000;

/** Render one comment as a labeled block. */
function renderComment(comment: MergeRequestComment): string {
  const thread = comment.resolvable
    ? comment.resolved
      ? "resolved review thread"
      : "UNRESOLVED review thread"
    : "thread comment";
  const body =
    comment.body.length > MAX_BODY_CHARS
      ? `${comment.body.slice(0, MAX_BODY_CHARS)}\n\n…(comment truncated)`
      : comment.body;
  return `### ${comment.author || "(unknown)"} — ${comment.createdAt} — ${thread}\n\n${
    body.trim() || "*(empty comment)*"
  }`;
}

/** The prompt block for a thread that was read successfully. */
export function renderDiscussion(comments: readonly MergeRequestComment[]): string {
  if (comments.length === 0) {
    return "No one has commented on this pull request yet — yours is the first review on the thread.";
  }
  const kept = comments.slice(-MAX_COMMENTS);
  const dropped = comments.length - kept.length;
  const unresolved = kept.filter((c) => c.resolvable && !c.resolved).length;
  const preamble = [
    `${comments.length} comment(s) are already on this pull request, oldest first.`,
    ...(dropped > 0 ? [`The ${dropped} oldest are omitted here.`] : []),
    ...(unresolved > 0
      ? [
          unresolved === 1
            ? `One sits in a review thread nobody has resolved — that feedback is still open.`
            : `${unresolved} sit in review threads nobody has resolved — that feedback is still open.`,
        ]
      : []),
  ].join(" ");
  return `${preamble}

${kept.map(renderComment).join("\n\n")}`;
}

/** The prompt block for a thread the provider wouldn't give up. */
function renderUnreadable(reason: string): string {
  return `The existing discussion could not be read (${reason}). Treat the thread as possibly already carrying feedback: say so when a finding may duplicate someone else's, rather than asserting it is new.`;
}

export default function createStage() {
  return {
    name: "discussion",
    version: "2",
    async run(ctx: StageContext): Promise<StageOutcome> {
      const ticket = ctx.state.ticket;
      const target = ctx.writes[0] ?? "existingComments";
      // Machine states drive the artwork in stages/discussion.svg: the
      // secretary reads along the message board while the provider call is
      // out, then writes the block the reviewers downstream read.
      const pacer = createStatePacer(ctx.machine, ctx.signal);

      const repo = ticket?.pinnedRepo
        ? ctx.repos.find((r) => r.name === ticket.pinnedRepo)
        : undefined;
      if (ticket?.pinnedRepo && !repo) {
        return {
          status: "abort",
          error: new Error(
            `Ticket ${ticket.key} pins repo "${ticket.pinnedRepo}", which is not in the configured repo list.`,
          ),
        };
      }
      // The PR number is the tail of the key pr-scan mints (`<repo>#<n>`),
      // the same parse the Correctness stage's freshness gate uses.
      const prNumber = ticket ? Number(ticket.key.slice(ticket.key.lastIndexOf("#") + 1)) : NaN;
      const connection = repo
        ? ctx.connections.list().find((c) => c.id === repo.connectionId)
        : undefined;

      if (!repo || !connection || !Number.isFinite(prNumber)) {
        const reason = !repo
          ? "the ticket names no configured repo"
          : !connection
            ? `repo "${repo.name}" has no bound account — set one under General → Local repositories`
            : `"${ticket?.key}" carries no pull-request number`;
        ctx.log(`Reviewing without the existing discussion — ${reason}.`, "warn");
        ctx.state[target] = renderUnreadable(reason);
        await pacer.showState("unreachable");
        await pacer.settle(MACHINE_LOOP_MS);
        return { status: "continue" };
      }

      let comments: readonly MergeRequestComment[];
      await pacer.showState("reading-thread");
      try {
        comments = await ctx.connections.listMergeRequestComments(connection.id, repo.path, prNumber, {
          signal: ctx.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        const reason = err instanceof Error ? err.message : String(err);
        ctx.log(`Could not read the discussion on #${prNumber} — ${reason}`, "warn");
        ctx.state[target] = renderUnreadable(reason);
        await pacer.showState("unreachable");
        await pacer.settle(MACHINE_LOOP_MS);
        return { status: "continue" };
      }

      ctx.state[target] = renderDiscussion(comments);
      await pacer.showState(comments.length === 0 ? "empty-thread" : "transcribing");
      const unresolved = comments.filter((c) => c.resolvable && !c.resolved).length;
      ctx.log(
        comments.length === 0
          ? `No existing comments on #${prNumber} — this is the first review on the thread.`
          : `Read ${comments.length} existing comment(s) on #${prNumber}${
              unresolved > 0 ? `, ${unresolved} in unresolved threads` : ""
            }.`,
        "success",
      );
      await pacer.settle(MACHINE_LOOP_MS);
      return { status: "continue" };
    },
  } satisfies Stage;
}
