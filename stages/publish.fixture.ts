// Fixture twin — runs the same operator preview gate as the live Publish
// stage (shared via ./review-preview.ts) so Test mode demonstrates the
// Formatted/Edit dialog and both cancel paths, then logs instead of
// posting. Test mode makes no provider calls.
import { readScreenshots, runPreviewGate } from "./review-preview.ts";
// Type-only import — erased when the stage loads; stage-types.d.ts
// (app-written, next to workflow.json) carries the contract.
import type { Stage, StageContext, StageOutcome } from "../stage-types";
import { MACHINE_LOOP_MS, createStatePacer } from "./machine-pacing";

export default function createStage() {
  return {
    name: "publish",
    version: "3",
    async run(ctx: StageContext): Promise<StageOutcome> {
      // Pace the Test run by this stage's configured fixture delay (Config
      // tab → Test → Stage delay), so the dashboard steps through visibly.
      await ctx.sleep();
      // Walk the machine through the same beats the live twin shows.
      const pacer = createStatePacer(ctx.machine, ctx.signal);
      const ticket = ctx.state.ticket;
      const review = ctx.state.verifiedReview;
      if (!ticket || typeof review !== "string" || review.trim().length === 0) {
        ctx.log("Fixture run — no verified review to preview.", "warn");
        return { status: "continue" };
      }
      // Same unattended skip as the live twin — a 24/7-launched Test run
      // steps through without blocking on the dialog.
      await pacer.showState("cueing");
      if (ctx.state.unattended === true) {
        ctx.log("Unattended run — skipping the preview dialog.");
      } else {
        await pacer.showState("previewing");
        // Same screenshots the evidence fixture seeded, so the preview's
        // Screenshots section renders in Test mode exactly as live.
        const screenshots = readScreenshots(ctx.state);
        const decision = await runPreviewGate(ctx, ticket, review, screenshots.shots);
        if (!decision.confirmed) return decision.outcome;
        ctx.log(
          `Fixture run — the live stage attaches ${decision.shots.length} of ${screenshots.shots.length} screenshots.`,
        );
        // Mirrors the live twin: an edit in Test mode is what the run
        // summary carries, so the two behave the same when the operator
        // rewrites the draft.
        ctx.state.verifiedReview = decision.review;
      }
      await pacer.showState("transmitting");
      ctx.log(
        `Fixture run — the live stage posts the confirmed review to ${ticket?.sourceUrl ?? "the PR thread"}.`,
        "success",
      );
      await pacer.showState("on-air");
      await pacer.settle(MACHINE_LOOP_MS);
      return { status: "continue" };
    },
  } satisfies Stage;
}
