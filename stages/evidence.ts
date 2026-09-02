// Evidence — the substantiation pass between review and delivery. The
// Correctness and Quality stages' reports are agents' opinions; this
// stage sends a separate, skeptical agent into the same repo to verify
// every finding in both and attach the proof — re-run the failing
// checks, confirm the cited code, reproduce the failure scenarios and
// hang/crash triggers. Findings that don't hold are dropped (and
// noted), so what reaches the PR thread is one merged report where
// every claim carries its own receipt. The Publish stage posts the
// result.
//
// It also reads the pull request's existing discussion
// (`existingComments`, from the Discussion stage) — the report it writes
// is the comment that lands on that thread, so it has to read as the
// next turn in the conversation: attributions the reviewers credited to
// a human stay credited, and a repeat round says what moved since the
// last one instead of restating it.
//
// Runs in the ticket's pinned repo, same non-destructive contract as the
// review: checkout-requiring work happens in a temporary worktree on the
// PR's source branch, removed when the pass ends.
//
// For UI-affecting PRs the agent also captures before/after screenshots
// into the run's evidence directory (ctx.evidence — outside the
// worktree, so nothing lands in the PR's diff). The reported filenames
// are validated here against the actual directory before they're
// trusted: bare names, allowlisted image extensions, regular files,
// size/count caps. Validated shots ride `reviewScreenshots` to the
// Publish stage, which shows them in the preview and uploads them to
// the PR thread.
//
// The `post-unverified` recovery action is the pass's failure hatch:
// it forwards the reviewer's report to Publish marked unverified, and
// salvages any validated before/after captures from the failed run's
// evidence directory so the visual proof still ships.
import { lstat, readdir } from "node:fs/promises";
import { basename } from "node:path";
// Type-only imports — erased when the stage loads; stage-types.d.ts
// (app-written, next to workflow.json) carries the contract, and
// review-preview.ts owns the shot record both delivery stages share.
import type { Stage, StageContext, StageOutcome } from "../stage-types";
import { MACHINE_LOOP_MS, createStatePacer } from "./machine-pacing";
import { blockedReason, reviewVerdict, unreadableVerdictWarning } from "./review-verdict";
import type { ReviewShot } from "./review-preview.ts";

const MAX_SCREENSHOTS = 8;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** Reason a candidate screenshot file fails the on-disk checks, or null
 *  when it's a regular image file within the size cap. Shared between
 *  the live pass (agent-reported names) and the recovery salvage
 *  (directory scan). */
async function screenshotFileProblem(evidenceDir: string, file: string): Promise<string | null> {
  let info;
  try {
    info = await lstat(`${evidenceDir}/${file}`);
  } catch {
    return "not in the evidence directory";
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SCREENSHOT_BYTES) {
    return "not a regular file under 5 MB";
  }
  return null;
}

const PROMPT = `You are the evidence pass of a code-review pipeline. Two reviewers produced the reports below about the pull request described in the ticket — a correctness/security review, and a quality report (duplication, maintainability, hang/crash robustness). Your job is to adversarially verify both: assume every finding is wrong until the repo proves it right, and produce the one final report where each surviving claim carries its own captured proof.

## Ground rules

- The checkout you start in belongs to the operator — leave it untouched. Fetch the PR's branches (\`git fetch <remote> <source-branch> <target-branch>\`; the remote is usually \`origin\`), create a temporary worktree on the source branch (\`git worktree add <tmpdir> <remote>/<source-branch>\`), and do all verification work there. Remove the worktree (\`git worktree remove --force <tmpdir>\`) before you finish, even when the pass fails.
- Verify, don't re-review. You judge the reviewer's claims against the repo; you do not hunt for new findings. The one exception: if verifying a finding exposes that its description is wrong but an adjacent real defect exists, correct the finding and mark the correction.
- Your report is posted as a comment on the pull request's thread, and that thread's existing comments are included below. Write the next turn in that conversation: keep every attribution the reviewers credited to a person, and when an earlier round of this review is already on the thread, lead with what changed since it rather than repeating it. A finding the discussion already refuted is dropped unless you can answer the refutation with evidence.

## For each finding in the reports

1. **Confirm the citation.** Open the cited file:line. Does the code exist and do what the finding says it does? A citation that doesn't match the code kills the finding.
2. **Reproduce the failure.** Run the concrete scenario the finding describes — execute the failing command, feed the hostile input, hit the boundary condition, trigger the hang or crash (under a timeout so a real hang can't stall this pass). Capture the command and the relevant output excerpt.
3. **Re-run red checks.** For every check the report calls red, re-run the exact command and capture the failing excerpt. A check that passes on re-run is reported as not reproduced.

Quality findings verify the same way, with the demonstration matched to the claim: a duplication finding needs the existing exported symbol shown to cover the diff's use, a maintainability finding needs the cited structure to actually be in the diff, a hang/crash finding needs the trigger reproduced or the defective path shown line by line.

## Screenshots

When the diff changes user-visible UI and the repo can run it (a dev server plus a browser harness — Playwright, Cypress, or similar), capture before/after screenshots of the affected screens:

- **before** — the target branch without the PR (check out the merge base in a second temporary worktree).
- **after** — the PR's source branch.

Save them as PNG files with bare filenames prefixed \`before-\` / \`after-\` into the evidence directory named under "## Evidence directory" below — it lives outside the worktrees, so nothing you save there can leak into the PR. Report every capture in the \`screenshots\` output field as a JSON array of \`{"file", "phase": "before"|"after", "caption"}\`. When screenshots don't apply (no UI change, or nothing runnable), return \`[]\` — never fabricate captures.

## Report

The \`verifiedReview\` output field carries the verified review, in markdown, ready to post to the PR thread verbatim; the \`screenshots\` output field carries the JSON array described above. Those filenames are checked against the evidence directory before anything is trusted, and the survivors travel to the Publish step as \`reviewScreenshots\` — so report only captures you actually saved. The review:

- Verdict first, on its own line: **APPROVE**, **REQUEST CHANGES**, or **BLOCKED**, with a one-sentence reason. BLOCKED is for a pass you could not carry out at all — the branches would not fetch, the worktree would not build, the diff was not there to inspect. An unreviewable pull request is neither approved nor rejected, so a BLOCKED report stops after the reason, with the exact command and output that blocked you, and reports nothing about the change. Otherwise re-derive it from the findings that survived across both reports — surviving Critical/High quality findings justify REQUEST CHANGES the same way correctness defects do. If verification killed the findings the original verdict rested on, the verdict changes with them, with a note saying so.
- Check results that reproduced, each with the exact command and failing excerpt.
- Surviving correctness findings ranked most-severe first, each with file:line, the defect, and the captured evidence (command + output, or the exact code demonstrating it).
- A **Quality** section with the surviving quality findings, same ranking and evidence discipline. Omit the section when none survived.
- A **Prior feedback** section carrying through what the reports said about the thread's existing concerns — each one with where it now stands (fixed / still open, at file:line / answered) and its original author credited. Omit the section when the thread carried none.
- A **Did not reproduce** section listing every dropped finding from either report with one line on why it failed verification. Omit the section when nothing was dropped.

No preamble before the verdict and no closing summary after the last section.`;

/** What the prompt asks the verdict line to say, for the warning. */
const VERDICT_SHAPE = "APPROVE, REQUEST CHANGES, or BLOCKED";

export default function createStage() {
  return {
    name: "evidence",
    version: "10",
    async run(ctx: StageContext): Promise<StageOutcome> {
      const ticket = ctx.state.ticket;
      // Machine states drive the artwork in stages/evidence.svg: claims go
      // through the bath and up on the line, the one that does not
      // reproduce coming up blank, and the shift ends on the verdict the
      // verified review calls.
      const pacer = createStatePacer(ctx.machine, ctx.signal);
      const findings = ctx.state.correctnessFindings;
      if (typeof findings !== "string" || findings.trim().length === 0) {
        return {
          status: "abort",
          error: new Error(
            "Nothing to verify — the Correctness stage wrote nothing to correctnessFindings.",
          ),
        };
      }

      let prompt = PROMPT;
      if (ticket) {
        prompt += `

## Ticket ${ticket.key}: ${ticket.summary}

${ticket.description ?? ""}`;
      }
      const evidenceDir = await ctx.evidence.dir();
      prompt += `

## Evidence directory

${evidenceDir}`;
      // The PR's own thread — optional so a rewired workflow that drops
      // the Discussion stage still verifies the reports alone.
      const discussion = ctx.state.existingComments;
      if (typeof discussion === "string" && discussion.trim().length > 0) {
        prompt += `

## The discussion already on this pull request

${discussion}`;
      }
      prompt += `

## The correctness review to verify

${findings}`;
      // The Quality stage's report — optional so a rewired workflow that
      // drops the stage still verifies the correctness review alone.
      const quality = ctx.state.qualityFindings;
      if (typeof quality === "string" && quality.trim().length > 0) {
        prompt += `

## The quality report to verify

${quality}`;
      }

      // The PR's home repo — the verification must run where the review ran.
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

      ctx.log(`Verifying the review of ${ticket?.key ?? "the run"}…`);
      await pacer.showState("developing");
      const { outputs } = await ctx.runAgent({
        prompt,
        cwd: repo?.path,
        outputs: ["verifiedReview", "screenshots"],
      });
      const review = outputs.verifiedReview ?? "";
      // A BLOCKED report is a verification that did not happen. Nothing
      // is saved, so Publish has nothing to post, and the stage fails with
      // the agent's reason — the "post-unverified" recovery below is then
      // the operator's call.
      const blocked = blockedReason(review);
      if (blocked) {
        ctx.log(review.trim().slice(0, 600), "warn");
        return {
          status: "abort",
          error: new Error(
            `The evidence pass on ${ticket?.key ?? "the pull request"} could not run — ${blocked}`,
          ),
        };
      }
      ctx.state.verifiedReview = review;

      // The screenshot list is untrusted agent output — validate every
      // entry against the actual evidence directory before anything
      // downstream renders or uploads it.
      let reported: Array<{ file?: unknown; phase?: unknown; caption?: unknown } | null> = [];
      try {
        const parsed = JSON.parse(outputs.screenshots ?? "[]");
        if (Array.isArray(parsed)) reported = parsed;
      } catch {
        ctx.log("The agent's screenshots field wasn't valid JSON — ignoring it.", "warn");
      }
      const shots: ReviewShot[] = [];
      for (const entry of reported) {
        if (shots.length >= MAX_SCREENSHOTS) break;
        const file = typeof entry?.file === "string" ? entry.file : "";
        const phase = entry?.phase === "before" || entry?.phase === "after" ? entry.phase : null;
        if (!file || !phase || basename(file) !== file || !IMAGE_EXT.test(file)) {
          ctx.log(`Rejected reported screenshot ${file || "(unnamed)"} — bad name or phase.`, "warn");
          continue;
        }
        const problem = await screenshotFileProblem(evidenceDir, file);
        if (problem) {
          ctx.log(`Rejected reported screenshot ${file} — ${problem}.`, "warn");
          continue;
        }
        shots.push({
          file,
          phase,
          ...(typeof entry?.caption === "string" && entry.caption ? { caption: entry.caption } : {}),
          // Server-relative path a dialog Image node loads this capture from.
          apiPath: ctx.evidence.imagePath(file),
        });
      }
      ctx.state.reviewScreenshots = { dir: evidenceDir, shots };
      if (shots.length > 0) {
        ctx.log(`Captured ${shots.length} screenshot(s) as review evidence.`, "success");
      }

      ctx.log(review.trim().slice(0, 600) || "The agent finished without a message.", "success");
      // The verdict is a held beat, not a resting look — the runner emits
      // its own terminal machine:state as soon as this returns.
      // A verified review that opens with no verdict shows none: it is saved
      // and posted, but nothing here claims it passed.
      const verdict = reviewVerdict(review);
      if (verdict) {
        await pacer.showState(verdict);
      } else {
        ctx.log(unreadableVerdictWarning(VERDICT_SHAPE), "warn");
        await pacer.showState("verdict-unclear");
      }
      await pacer.settle(MACHINE_LOOP_MS);
      return { status: "continue" };
    },
    recoveryActions: [
      {
        id: "post-unverified",
        label: "Continue with the unverified review",
        hint: "Skip verification — the Publish stage posts the reviewers' reports as-is, marked unverified, along with any screenshots the failed pass captured",
        matches: (failure) =>
          failure.failedStage === "evidence" && failure.failureKind !== "filter",
        async run(ctx) {
          // The failed run's shared state rides in on ctx.state via the
          // attention sidecar's snapshot, so both reviewers' reports are
          // readable here even though this is a fresh run.
          const raw = ctx.state.correctnessFindings;
          const rawQuality = ctx.state.qualityFindings;
          const parts = [
            ...(typeof raw === "string" && raw.trim().length > 0 ? [raw] : []),
            ...(typeof rawQuality === "string" && rawQuality.trim().length > 0
              ? [`## Quality\n\n${rawQuality}`]
              : []),
          ];
          ctx.state.verifiedReview =
            parts.length > 0
              ? `> ⚠ Posted without the evidence pass — findings below are the reviewers' claims, unverified.\n\n${parts.join("\n\n")}`
              : "";
          ctx.log("Passing the unverified review through to Publish.", "warn");

          // Salvage any before/after captures already on disk —
          // ctx.evidence is bound to the FAILED run's evidence directory,
          // and the capture step precedes the report step in the pass, so
          // a late failure often leaves a complete set behind. Same
          // validation caps as the live path; captions live only in the
          // agent's report, so salvaged shots carry none.
          if (!ctx.evidence) return;
          const dir = await ctx.evidence.dir();
          let files: string[];
          try {
            files = await readdir(dir);
          } catch {
            return;
          }
          const ordered = files
            .filter((f) => f.startsWith("before-"))
            .sort()
            .concat(files.filter((f) => f.startsWith("after-")).sort());
          const shots: ReviewShot[] = [];
          for (const file of ordered) {
            if (shots.length >= MAX_SCREENSHOTS) break;
            if (basename(file) !== file || !IMAGE_EXT.test(file)) continue;
            if (await screenshotFileProblem(dir, file)) continue;
            shots.push({
              file,
              phase: file.startsWith("before-") ? "before" : "after",
              apiPath: ctx.evidence.imagePath(file),
            });
          }
          ctx.state.reviewScreenshots = { dir, shots };
          if (shots.length > 0) {
            ctx.log(`Salvaged ${shots.length} screenshot(s) from the failed evidence pass.`);
          }
        },
      },
    ],
  } satisfies Stage;
}
