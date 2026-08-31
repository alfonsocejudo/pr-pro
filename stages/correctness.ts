// Correctness — an adversarial verifier pass over one open PR per ticket.
// The PR's author is the implementer; this stage is the separate judge.
// Its scope is correctness and security: executable checks, bug hunt,
// adversarial security, test discipline. Duplication, maintainability,
// and freeze/crash robustness belong to the Quality stage that runs
// next; the two stages split the review so neither report repeats the
// other's findings.
// The methodology is the reviewed repo's own: whatever engineering
// referents the repo carries (a threat model, a definition of done, a
// gate registry, per-package export catalogs) are authoritative, and its
// executable checks are run as part of the review — so the stage adapts
// to any repo and degrades to a plain adversarial diff review on one
// that carries none of them.
//
// The agent runs in the ticket's pinned repo (the PR's home, bound by
// pr-scan). It never dirties the operator's checkout: all
// checkout-requiring work happens in a temporary git worktree on the PR's
// source branch, removed when the review ends.
//
// A ticket is a snapshot of the PR at scan time, and the queue can
// outlive it — the PR may merge, close, or turn draft while the ticket
// waits. The stage re-checks the provider's open-PR list at review time
// and filters any ticket whose PR is absent from it or marked draft, so
// only open, reviewable PRs reach the agent.
//
// The Discussion stage runs first and hands over the comments already on
// the pull request as `existingComments`; the prompt makes that thread
// binding — a finding somebody already raised is reported as still open,
// not rediscovered, and a claim the thread already refuted has to answer
// the refutation.
//
// The final message is the review report; the manifest routes it to the
// `correctnessFindings` shared field, which the Evidence stage posts to the PR
// thread verbatim — so the prompt requires comment-ready markdown.
const PROMPT = `You are the verifier in a two-role code-review loop: someone else implemented the pull request described below, and your job is to judge it adversarially. Verify every claim against the actual code; report findings with evidence — file:line and a concrete failure scenario — never vibes. A plausible-but-wrong finding is worse than none.

## Ground rules

- The checkout you start in belongs to the operator — leave it untouched. Fetch the PR's branches (\`git fetch <remote> <source-branch> <target-branch>\`; the remote is usually \`origin\`), create a temporary worktree on the source branch (\`git worktree add <tmpdir> <remote>/<source-branch>\`), and do all checkout-requiring work there. Remove the worktree (\`git worktree remove --force <tmpdir>\`) before you finish, even when the review fails.
- The review target is the full diff of the source branch against its merge base with the target branch (\`git diff <remote>/<target>...<remote>/<source>\`), plus enough surrounding code to judge it in context.
- Before judging anything, survey the repo's own engineering referents — README, docs/, contributing guides — for anything that defines how this repo judges work: a threat model, a definition of done, a gate or check registry, generated export catalogs, architecture decision records. Whatever exists overrides your taste. Note what you found and used.
- Your scope is correctness and security. Duplication, maintainability, and hang/crash robustness are a separate quality pass's job — do not report them here.
- Read the pull request's existing discussion — the \`existingComments\` block below — before you judge anything, and treat it as part of the record. Someone else may have raised a defect already, the author may have answered one, and an earlier round of this same review may be sitting on the thread. Your report joins that conversation instead of restarting it.

## The passes, in order

1. **Checks.** Run the repo's own executable quality checks in the worktree — whatever it defines: a dedicated all-checks script, lint/typecheck/test scripts, CI job commands reproducible locally. Install dependencies if needed. Every red check is a finding: name the check, the exact command, and the failing output excerpt. A repo with no runnable checks gets a note saying so, not an invented substitute.
2. **Bug hunt.** Hunt for correctness defects in the diff: broken logic, unhandled states, races, wrong boundary behavior, regressions in the surrounding code the diff interacts with. Each finding names file:line, states the defect in one sentence, and gives the concrete inputs or state that produce the wrong behavior.
3. **Adversarial security.** Mandatory when the diff touches a trust boundary — anything that ingests, renders, or ships data from outside the repo's control, or that the repo's own threat model names. Attack the change: hostile strings through every ingestion path, DOM/HTML sinks, injection primitives, data crossing a boundary it shouldn't. Skipping this pass requires an explicit "no trust boundary touched" note with the reasoning.
4. **Test discipline.** New behavior with no test, tests that cannot fail, and tests asserting the implementation rather than the required behavior are findings. A green-but-meaningless suite is the exact failure mode this review exists to catch.
5. **Prior feedback.** Walk the existing discussion and check each correctness or security concern in it against the current code. One already fixed is closed — say so in one line and drop it. One still live is a finding, credited to whoever raised it ("raised by @user, still open at file:line") rather than presented as your own. One the author answered convincingly is closed too; one they answered unconvincingly stays open, with the answer quoted and the reason it doesn't hold. Feedback outside your scope — duplication, maintainability, hang/crash risk — belongs to the quality pass; leave it alone.

## Report

Your entire final message is the review report, in markdown, ready to post to the PR thread verbatim:

- Verdict first, on its own line: **APPROVE** or **REQUEST CHANGES**, with a one-sentence reason.
- Check results: which checks ran, red or green, with the failing excerpt for each red one.
- Findings ranked most-severe first, each with file:line, the defect, and the failure scenario or attack that demonstrates it. Mark any finding the thread already carries as previously raised, naming who raised it — never restate an open finding as a new discovery.
- A **Prior feedback** section: each correctness or security concern from the existing discussion with one line on where it now stands (fixed / still open / answered). Omit the section when the thread carried none.
- Any skipped pass, with the reason it was skipped.

No preamble before the verdict and no closing summary after the last finding.`;

// Type-only import — erased when the stage loads; stage-types.d.ts
// (app-written, next to workflow.json) carries the contract.
import type { Stage, StageContext, StageOutcome, StageRunConfig } from "../stage-types";
import { MACHINE_LOOP_MS, createStatePacer } from "./machine-pacing";
import { reviewVerdict, unreadableVerdictWarning } from "./review-verdict";

/** What the prompt asks the verdict line to say, for the warning. */
const VERDICT_SHAPE = "APPROVE or REQUEST CHANGES";

export default function createStage() {
  return {
    name: "correctness",
    version: "7",
    async run(ctx: StageContext, config: StageRunConfig): Promise<StageOutcome> {
      let prompt = PROMPT;
      const ticket = ctx.state.ticket;
      // Machine states drive the artwork in stages/correctness.svg: the
      // examiner squares the proof to see it is still his to read, works
      // down it with a red pen, and ends on the APPROVE / CHANGES the
      // verdict line calls.
      const pacer = createStatePacer(ctx.machine, ctx.signal);
      // Show the verdict the report's first line calls, and hold it for a
      // loop. A report that opens with no verdict shows none: the review is
      // saved, but nothing here claims it passed.
      const settleOnVerdict = async (report: string) => {
        const verdict = reviewVerdict(report);
        if (verdict) {
          await pacer.showState(verdict);
        } else {
          ctx.log(unreadableVerdictWarning(VERDICT_SHAPE), "warn");
          await pacer.showState("verdict-unclear");
        }
        await pacer.settle(MACHINE_LOOP_MS);
      };
      if (ticket) {
        prompt += `

## Ticket ${ticket.key}: ${ticket.summary}

${ticket.description ?? ""}`;
      }
      // Append each declared input (ctx.reads) as a labeled block.
      for (const key of ctx.reads) {
        const value = ctx.state[key];
        if (value === undefined) continue;
        const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        prompt += `

## ${key}

${rendered}`;
      }
      // Append each setting (tunable) and its current value. Settings live in
      // config.settings; the heading prefix keeps them apart from inputs.
      for (const [name, value] of Object.entries(config?.settings ?? {})) {
        const rendered = typeof value === "string" ? value : JSON.stringify(value);
        prompt += `

## Setting: ${name}

${rendered}`;
      }

      // The PR's home repo — pr-scan pins every ticket to the repo the PR
      // belongs to, and the review must run there. The default runAgent cwd
      // (the run's targeted repo, else the project folder) is not that repo
      // on a multi-ticket scan, so the pin resolves explicitly.
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
      const cwd = repo?.path;

      // Freshness check — the ticket carries the PR's state as of scan
      // time. Confirm the PR is still on the provider's open list (and
      // not draft) before spending a review on it; a merged or closed PR
      // filters the ticket out of the run. The check is best-effort: a
      // provider error logs a warning and the review proceeds, since the
      // agent works from the local git remotes either way.
      if (repo && ticket) {
        const prNumber = Number(ticket.key.slice(ticket.key.lastIndexOf("#") + 1));
        const connection = ctx.connections
          .list()
          .find((c) => c.id === repo.connectionId);
        if (connection && Number.isFinite(prNumber)) {
          await pacer.showState("preflight-check");
          let openPrs: readonly { number: number; draft: boolean }[] | null = null;
          try {
            openPrs = await ctx.connections.listOpenMergeRequests(connection.id, repo.path, {
              signal: ctx.signal,
            });
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") throw err;
            ctx.log(
              `Could not confirm PR #${prNumber} is still open — ${err instanceof Error ? err.message : String(err)}. Reviewing anyway.`,
              "warn",
            );
          }
          if (openPrs) {
            const pr = openPrs.find((m) => m.number === prNumber);
            if (!pr) {
              await pacer.showState("pr-settled");
              await pacer.settle(MACHINE_LOOP_MS);
              return {
                status: "filter",
                reason: "pr-settled",
                message: `PR #${prNumber} in ${repo.name} is already merged or closed — skipping the review.`,
              };
            }
            if (pr.draft) {
              await pacer.showState("pr-draft");
              await pacer.settle(MACHINE_LOOP_MS);
              return {
                status: "filter",
                reason: "pr-draft",
                message: `PR #${prNumber} in ${repo.name} is marked draft — skipping the review until it is ready.`,
              };
            }
          }
        }
      }

      ctx.log(`Reviewing ${ticket?.key ?? "the run"}${repo ? ` in ${repo.name}` : ""}…`);
      await pacer.showState("inspecting");

      // Several outputs: request a structured reply — one string value per
      // output field — and save each value under its own name.
      if (ctx.writes.length > 1) {
        const { text, outputs } = await ctx.runAgent({ prompt, outputs: ctx.writes, cwd });
        for (const key of ctx.writes) ctx.state[key] = outputs[key];
        ctx.log("Saved the review under " + ctx.writes.join(", ") + ".", "success");
        await settleOnVerdict(text);
        return { status: "continue" };
      }
      // One output (the wired shape: `correctnessFindings`): the entire final
      // message is the review report. With none set, keep it under this
      // stage's own slot in agentOutput.
      const { text } = await ctx.runAgent({ prompt, cwd });
      if (ctx.writes.length === 1) {
        ctx.state[ctx.writes[0]] = text;
      } else {
        const outputs = (ctx.state.agentOutput ?? {}) as Record<string, string>;
        outputs[ctx.stageId] = text;
        ctx.state.agentOutput = outputs;
      }
      ctx.log(text.trim().slice(0, 600) || "The agent finished without a message.", "success");
      // The verdict is a held beat, not a resting look — the runner emits
      // its own terminal machine:state as soon as this returns.
      await settleOnVerdict(text);
      return { status: "continue" };
    },
  } satisfies Stage;
}
