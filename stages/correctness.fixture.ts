// Fixture twin — skips the agent call for Test mode. It writes a canned
// review report to the same outputs (ctx.writes) so the Evidence stage
// and the dashboard see the shape a live review produces.
const CANNED_REPORT = `**REQUEST CHANGES** — one red check and one correctness defect.

## Check results

- \`lint\` — green
- \`typecheck\` — green
- \`test\` — **red**: \`expected 2 to equal 3\` in \`fixture.spec.ts\`

## Findings

1. **src/example.ts:42** — the retry counter resets inside the loop, so a
   flaky call retries forever. Reproduce: any call that fails twice.

## Skipped passes

- Adversarial security — no trust boundary touched (fixture diff renders
  no external data).`;

// Type-only import — erased when the stage loads; stage-types.d.ts
// (app-written, next to workflow.json) carries the contract.
import type { Stage, StageContext, StageOutcome } from "../stage-types";
import { MACHINE_LOOP_MS, createStatePacer, pause } from "./machine-pacing";
import { reviewVerdict } from "./review-verdict";

// One full pass of the reading choreography in stages/correctness.svg — six
// marks made and cleared in turn, 1.6s apart, down the proof. A live review
// holds `inspecting` for as long as the agent runs, so the cycle repeats
// there; the fixture has to hold it deliberately or the machine only ever
// shows the cycle's first beat.
const INSPECT_CYCLE_MS = 9600;

// The verdict the canned report opens with, as the machine state
// stages/correctness.svg reacts to — read through the same parser the live
// stage uses, so editing CANNED_REPORT moves the artwork with it and the
// twin can't drift from its live counterpart.
const VERDICT_STATE = reviewVerdict(CANNED_REPORT) ?? "verdict-unclear";

export default function createStage() {
  return {
    name: "correctness",
    version: "4",
    async run(ctx: StageContext): Promise<StageOutcome> {
      // Pace the Test run by this stage's configured fixture delay (Config
      // tab → Test → Stage delay), so the dashboard steps through visibly.
      await ctx.sleep();
      ctx.log("Fixture run — skipping the agent call.");
      // Walk the machine through the same beats a live review shows:
      // the freshness check, the walkaround, and the verdict.
      const pacer = createStatePacer(ctx.machine, ctx.signal);
      await pacer.showState("preflight-check");
      await pacer.showState("inspecting");
      await pause(INSPECT_CYCLE_MS, ctx.signal);
      // Report a plausible stand-in for the live agent call's token usage
      // so Test runs move the dashboard's token meter the way live runs
      // do. Adjust the bases to taste.
      const jitter = () => 1 + (Math.random() - 0.5) * 0.2;
      const inputTokens = Math.round(4000 * jitter());
      const outputTokens = Math.round(600 * jitter());
      ctx.reportTokens({
        inputTokens,
        outputTokens,
        cachedInputTokens: 0,
        totalTokens: inputTokens + outputTokens,
      });
      if (ctx.writes.length > 0) {
        for (const key of ctx.writes) ctx.state[key] = CANNED_REPORT;
      } else {
        const outputs = (ctx.state.agentOutput ?? {}) as Record<string, string>;
        outputs[ctx.stageId] = CANNED_REPORT;
        ctx.state.agentOutput = outputs;
      }
      await pacer.showState(VERDICT_STATE);
      await pacer.settle(MACHINE_LOOP_MS);
      return { status: "continue" };
    },
  } satisfies Stage;
}
