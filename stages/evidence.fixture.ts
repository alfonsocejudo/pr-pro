// Fixture twin — skips the agent call for Test mode. It writes a canned
// verified report to `verifiedReview`, and seeds two 1×1 demo PNGs into
// the run's evidence store as before/after screenshots, so the Publish
// preview's Screenshots section renders real images in Test mode.
import { writeFile } from "node:fs/promises";
// Type-only imports — erased when the stage loads; stage-types.d.ts
// (app-written, next to workflow.json) carries the contract, and
// review-preview.ts owns the shot record both delivery stages share.
import type { Stage, StageContext, StageOutcome } from "../stage-types";
import { MACHINE_LOOP_MS, createStatePacer, pause } from "./machine-pacing";
import { reviewVerdict } from "./review-verdict";
import type { ReviewShot } from "./review-preview.ts";

// Smallest valid PNG (1×1) — a stand-in for a real capture.
const DEMO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const CANNED_VERIFIED_REPORT = `**REQUEST CHANGES** — the red check, the retry defect, and the duplication all reproduced.

## Check results (reproduced)

- \`test\` — **red**: \`bun test fixture.spec.ts\` → \`expected 2 to equal 3\`

## Findings (verified)

1. **src/example.ts:42** — the retry counter resets inside the loop, so a
   flaky call retries forever. Evidence: \`bun run repro-retry.ts\` looped
   past 50 attempts before the harness killed it.

## Quality

1. **High — src/example.ts:57** — \`retryWithBackoff\` duplicates
   \`lib/retry.ts\`'s \`withRetry\`. Evidence: \`withRetry\`'s signature
   covers every call site in the diff.

## Did not reproduce

- "unused import in src/util.ts" — the import is consumed on line 9.
- "polling loop has no timeout" (quality) — the loop cap on line 61
  bounds it at 30 iterations.`;

// One full pass of the darkroom choreography in stages/evidence.svg — each
// claim through the bath and up on the line, one of them coming up blank. A
// live pass holds `developing` for as long as the agent runs, so the cycle
// repeats there; the fixture has to hold it deliberately or the machine only
// ever shows the cycle's first beat.
const DEVELOP_CYCLE_MS = 7200;

// The verdict the canned review opens with, as the machine state
// stages/evidence.svg reacts to — kept in step with CANNED_VERIFIED_REPORT so
// editing the review moves the artwork with it.
const VERDICT_STATE = reviewVerdict(CANNED_VERIFIED_REPORT) ?? "verdict-unclear";

export default function createStage() {
  return {
    name: "evidence",
    version: "6",
    async run(ctx: StageContext): Promise<StageOutcome> {
      // Pace the Test run by this stage's configured fixture delay (Config
      // tab → Test → Stage delay), so the dashboard steps through visibly.
      await ctx.sleep();
      ctx.log("Fixture run — skipping the verification agent call.");
      // Walk the machine through the same beats a live pass shows: the
      // darkroom choreography, then the verdict.
      const pacer = createStatePacer(ctx.machine, ctx.signal);
      await pacer.showState("developing");
      await pause(DEVELOP_CYCLE_MS, ctx.signal);
      // Report a plausible stand-in for the live agent call's token usage
      // so Test runs move the dashboard's token meter the way live runs do.
      const jitter = () => 1 + (Math.random() - 0.5) * 0.2;
      const inputTokens = Math.round(3000 * jitter());
      const outputTokens = Math.round(500 * jitter());
      ctx.reportTokens({
        inputTokens,
        outputTokens,
        cachedInputTokens: 0,
        totalTokens: inputTokens + outputTokens,
      });
      ctx.state.verifiedReview = CANNED_VERIFIED_REPORT;
      const dir = await ctx.evidence.dir();
      const shots: ReviewShot[] = [];
      for (const [file, phase, caption] of [
        ["before-retry-loop.png", "before", "retry loop spinning"],
        ["after-retry-loop.png", "after", "retry capped at 3"],
      ] as const) {
        await writeFile(`${dir}/${file}`, DEMO_PNG);
        shots.push({ file, phase, caption, apiPath: ctx.evidence.imagePath(file) });
      }
      ctx.state.reviewScreenshots = { dir, shots };
      await pacer.showState(VERDICT_STATE);
      await pacer.settle(MACHINE_LOOP_MS);
      return { status: "continue" };
    },
  } satisfies Stage;
}
