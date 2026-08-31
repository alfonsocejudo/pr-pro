// Fixture twin — skips the agent call for Test mode. It writes a canned
// quality report to the same outputs (ctx.writes) so the Evidence stage
// and the dashboard see the shape a live quality pass produces.
const CANNED_REPORT = `**2 QUALITY FINDINGS** — one duplication, one hang risk.

## Findings

1. **High — src/example.ts:57** — the new \`retryWithBackoff\` helper
   duplicates \`lib/retry.ts\`'s \`withRetry\`, which already handles
   backoff and jitter. Use the existing export.
2. **Moderate — src/example.ts:63** — the polling loop has no timeout:
   a server that never returns a terminal status spins it forever.
   Trigger: any request that stays \`pending\`.

Referents used: CONTRIBUTING.md (utility-first rule).`;

// Type-only import — erased when the stage loads; stage-types.d.ts
// (app-written, next to workflow.json) carries the contract.
import type { Stage, StageContext, StageOutcome } from "../stage-types";
import { MACHINE_LOOP_MS, createStatePacer, pause } from "./machine-pacing";
import { qualityVerdict } from "./review-verdict";

// One full pass of the grading choreography in stages/quality.svg — read
// the case, catch the match, work the facets, find the inclusion, mark the
// card. A live pass holds `grading` for as long as the agent runs, so the
// cycle repeats there; the fixture has to hold it deliberately or the
// machine only ever shows the cycle's first beat.
const GRADE_CYCLE_MS = 7200;

// The grade the canned report opens with, as the machine state
// stages/quality.svg reacts to — kept in step with CANNED_REPORT so editing
// the report moves the artwork with it.
const VERDICT_STATE = qualityVerdict(CANNED_REPORT) ?? "verdict-unclear";

export default function createStage() {
  return {
    name: "quality",
    version: "2",
    async run(ctx: StageContext): Promise<StageOutcome> {
      // Pace the Test run by this stage's configured fixture delay (Config
      // tab → Test → Stage delay), so the dashboard steps through visibly.
      await ctx.sleep();
      ctx.log("Fixture run — skipping the agent call.");
      // Walk the machine through the same beats a live pass shows: the
      // grading choreography, then the grade.
      const pacer = createStatePacer(ctx.machine, ctx.signal);
      await pacer.showState("grading");
      await pause(GRADE_CYCLE_MS, ctx.signal);
      // Report a plausible stand-in for the live agent call's token usage
      // so Test runs move the dashboard's token meter the way live runs
      // do. Adjust the bases to taste.
      const jitter = () => 1 + (Math.random() - 0.5) * 0.2;
      const inputTokens = Math.round(3500 * jitter());
      const outputTokens = Math.round(500 * jitter());
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
