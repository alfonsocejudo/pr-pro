// AI agent stage — edit this file to change what it does.
//
// Runs a CLI agent (whichever one is picked for this stage in the dashboard)
// with the prompt below. The agent works in the ticket's own
// repository when its producer pinned one, else the active project's
// folder. Pass { cwd } to ctx.runAgent to override.
// Inside the ticket loop the stage runs once per ticket and that ticket
// rides along under the prompt; before or after the loop it runs once for
// the whole run, with no ticket to send.
//
// Inputs, outputs, and settings are set in the editor, not here — inputs
// and outputs are Shared Data fields picked from the workflow's list. Each
// input is appended to the prompt under its own "## <name>" heading
// (ctx.reads), so the agent sees the data another stage produced. Each
// setting (a tunable knob) is added under a "## Setting: <name>" heading
// with its current value (config.settings), so the agent follows it — the
// prefix keeps a setting distinct from an input with the same name.
// Outputs (ctx.writes) are where the reply lands, so a later stage can take
// them as inputs. With one output, the agent's entire final message is
// saved under that name. With several, the agent is asked for a structured
// reply — a JSON object with one string value per output — and each value
// is saved under its own name, so tell the prompt what belongs in each
// field. With no outputs set, the message is kept under
// ctx.state.agentOutput[thisStageId]. Edit PROMPT to change what the agent
// is asked to do.
//
// Recovery (optional). If this stage fails and parks a ticket at Attention,
// add a `recoveryActions` array alongside `name` and `run` below to give
// the operator one-click "Recover" buttons. The recovery ctx has no agent
// (no ctx.runAgent) — an action stands in for the failed agent by writing a
// fallback answer onto ctx.state, then the pipeline resumes right after this
// stage. Keep each action self-contained — it must not close over anything
// from createStage(), because the Recover menu reads these with stub inputs.
//
//   recoveryActions: [
//     {
//       id: "continue-with-fallback",
//       label: "Continue with a fallback answer",
//       hint: "Save a safe default for this step's output and resume the run",
//       matches: (failure) =>
//         failure.failedStage === "quality" && failure.failureKind !== "filter",
//       async run(ctx) {
//         // ctx gives you { state, repos, log, signal, failure }. Seed the
//         // same slot the live run fills — your declared Output(s) by name,
//         // or ctx.state.agentOutput["quality"] when none are set.
//         ctx.state["yourOutputName"] = "a safe default answer";
//         ctx.log("Recovered with a fallback answer.", "success");
//       },
//     },
//   ],
//
// The import below is type-only — erased when the stage loads, so this
// file stays self-contained at run time. `stage-types.d.ts` (written by
// the app next to workflow.json) is what gives your editor IntelliSense
// on ctx and config.
import type { Stage, StageContext, StageOutcome, StageRunConfig } from "../stage-types";
import { MACHINE_LOOP_MS, createStatePacer } from "./machine-pacing";
import { blockedReason, qualityVerdict, unreadableVerdictWarning } from "./review-verdict";

const PROMPT = "You are the quality reviewer in a code-review pipeline. Your job is the lenses the correctness review doesn't cover: duplication, maintainability, and runtime robustness. Verify every claim against the actual code; report findings with evidence — file:line and the concrete consequence — never vibes. A plausible-but-wrong finding is worse than none.\n\n## Your inputs\n\nEverything you need is spliced in below, each block under a heading naming\nthe field it came from.\n\n- **`correctnessFindings`** — the correctness and security review of this\n  pull request, which already ran. It is there so you don't repeat it.\n- **`existingComments`** — the discussion already on the pull request:\n  every comment a person left, oldest first, each marked as a plain thread\n  comment or as a review thread that is resolved or still open.\n\n## Ground rules\n\n- The checkout you start in belongs to the operator — leave it untouched. Fetch the PR's branches (`git fetch <remote> <source-branch> <target-branch>`; the remote is usually `origin`), create a temporary worktree on the source branch (`git worktree add <tmpdir> <remote>/<source-branch>`), and do all checkout-requiring work there. Remove the worktree (`git worktree remove --force <tmpdir>`) before you finish, even when the pass fails.\n- The review target is the full diff of the source branch against its merge base with the target branch (`git diff <remote>/<target>...<remote>/<source>`), plus enough surrounding code to judge it in context.\n- Before judging anything, survey the repo's own engineering referents — README, docs/, contributing guides, style guides — for anything that defines how this repo judges quality. Whatever exists overrides your taste. Note what you found and used.\n- Do not repeat a finding the correctness review already reported; if you disagree with one, that belongs in its verification, not here.\n- Read the pull request's existing discussion below before you judge anything. Someone may have raised a maintainability or robustness concern already, the author may have answered it, and an earlier round of this same review may be sitting on the thread. Your report joins that conversation instead of restarting it.\n\n## The passes, in order\n\n1. **Reuse audit.** Compare what the diff builds against what the repo already exports: work that duplicates an existing abstraction instead of using it, and structural copy-paste inside the diff, are findings. Name the existing symbol the diff should have used, or the copies that should collapse into one.\n2. **Maintainability.** Judge the diff's readability and structure at Moderate severity and above: names that mislead about behavior, functions doing several unrelated things, deeply nested control flow that flattens cleanly, dead or unreachable branches, magic values that recur without a name. Style nits below Moderate — formatting, import order, taste-level phrasing — are not findings; the repo's own lint owns those.\n3. **Freeze & crash analysis.** Hunt for ways the changed code can hang or die at runtime: deadlocks and lock-order inversions, infinite loops and unbounded recursion, unbounded queue or memory growth, blocking work on a UI or main thread, network or subprocess calls with no timeout or cancellation, unhandled exceptions or promise rejections on paths the diff introduces. Each finding names the trigger — the input, state, or timing that produces the hang or crash.\n4. **Prior feedback.** Walk the existing discussion for concerns in your three lenses and check each against the current code. One already addressed is closed — say so in one line and drop it. One still live is a finding, credited to whoever raised it (\"raised by @user, still open at file:line\") rather than presented as your own. One the author answered convincingly is closed; one they answered unconvincingly stays open, with the answer quoted and the reason it doesn't hold. Correctness and security concerns on the thread belong to the correctness review — leave them alone.\n\n## Report\n\nYour entire final message is the quality report, in markdown; after verification it is merged into the review comment posted to the PR thread:\n\n- One line first: **CLEAN** (no findings at Moderate+ severity), **N QUALITY FINDINGS**, or **BLOCKED**, with a one-sentence summary. BLOCKED is for a pass you could not carry out at all — the branches would not fetch, the worktree would not build, the diff was not there to inspect. An unreviewable pull request is neither approved nor rejected, so a BLOCKED report stops after the reason, with the exact command and output that blocked you, and reports nothing about the change.\n- Findings ranked most-severe first, each with file:line, a severity (Critical / High / Moderate), the issue in one sentence, and the evidence — the existing symbol being duplicated, the trigger scenario for a hang or crash, or the structural problem and its cleaner shape. Mark any finding the thread already carries as previously raised, naming who raised it — never restate an open finding as a new discovery.\n- A **Prior feedback** section: each in-scope concern from the existing discussion with one line on where it now stands (addressed / still open / answered). Omit the section when the thread carried none.\n- Which repo referents you used, in one line.\n\nNo preamble before the first line and no closing summary after the last finding.";

/** What the prompt asks the opening line to say, for the warning. */
const VERDICT_SHAPE = "CLEAN, N QUALITY FINDINGS, or BLOCKED";

export default function createStage() {
  return {
    name: "quality",
    version: "2",
    async run(ctx: StageContext, config: StageRunConfig): Promise<StageOutcome> {
      ctx.log("Running the agent…");
      // Machine states drive the artwork in stages/quality.svg: the grader
      // holds the stone against the case the house already owns, reads its
      // facets under the loupe, finds the inclusion that cleaves it later,
      // and ends on the grade the report's opening line calls.
      const pacer = createStatePacer(ctx.machine, ctx.signal);
      // Show what the report's opening line calls, and hold it for a loop.
      // A report that opens with neither shows neither: the pass is saved,
      // but nothing here claims it came back clean.
      const settleOnVerdict = async (report: string) => {
        const verdict = qualityVerdict(report);
        if (verdict) {
          await pacer.showState(verdict);
        } else {
          ctx.log(unreadableVerdictWarning(VERDICT_SHAPE), "warn");
          await pacer.showState("verdict-unclear");
        }
        await pacer.settle(MACHINE_LOOP_MS);
      };
      let prompt = PROMPT;
      const ticket = ctx.state.ticket;
      // A BLOCKED report is a pass that did not happen. Nothing is saved
      // — Evidence has nothing to verify — and the stage fails with the
      // agent's reason, so the failure is the operator's to see and the
      // recovery actions apply.
      const blockedOutcome = (report: string): StageOutcome | null => {
        const reason = blockedReason(report);
        if (!reason) return null;
        ctx.log(report.trim().slice(0, 600), "warn");
        return {
          status: "abort",
          error: new Error(
            `The quality review of ${ticket?.key ?? "the pull request"} could not run — ${reason}`,
          ),
        };
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
      await pacer.showState("grading");

      // Several outputs: request a structured reply — one string value per
      // output field — and save each value under its own name.
      if (ctx.writes.length > 1) {
        const { text, outputs } = await ctx.runAgent({ prompt, outputs: ctx.writes });
        const blocked = blockedOutcome(text);
        if (blocked) return blocked;
        for (const key of ctx.writes) ctx.state[key] = outputs[key];
        ctx.log("Saved the agent's reply under " + ctx.writes.join(", ") + ".", "success");
        await settleOnVerdict(text);
        return { status: "continue" };
      }
      // One output (the wired shape: `qualityFindings`): the entire final
      // message is the quality report. With none set, keep it under this
      // stage's own slot in agentOutput.
      const { text } = await ctx.runAgent({ prompt });
      const blocked = blockedOutcome(text);
      if (blocked) return blocked;
      if (ctx.writes.length === 1) {
        ctx.state[ctx.writes[0]] = text;
      } else {
        const outputs = (ctx.state.agentOutput ?? {}) as Record<string, string>;
        outputs[ctx.stageId] = text;
        ctx.state.agentOutput = outputs;
      }
      ctx.log(text.trim().slice(0, 600) || "The agent finished without a message.", "success");
      // The grade is a held beat, not a resting look — the runner emits its
      // own terminal machine:state as soon as this returns.
      await settleOnVerdict(text);
      return { status: "continue" };
    },
  } satisfies Stage;
}
