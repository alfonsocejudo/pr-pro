// Fixture twin — runs in Test mode with no side effects. Test mode makes
// no provider calls, so this twin renders a canned discussion through the
// live stage's own renderer: the block the review stages see in a Test
// run has exactly the shape a real thread produces, including an
// unresolved review thread and a prior round of this workflow's own
// review for the reviewers to notice.
import { renderDiscussion } from "./discussion.ts";
import { createStatePacer, MACHINE_LOOP_MS } from "./machine-pacing.ts";
// Type-only import — erased when the stage loads; stage-types.d.ts
// (app-written, next to workflow.json) carries the contract.
import type { MergeRequestComment, Stage, StageContext, StageOutcome } from "../stage-types";

const CANNED: MergeRequestComment[] = [
  {
    author: "carol",
    body: "Nice cleanup. One thing: the retry loop needs a ceiling before this merges.",
    createdAt: "2026-08-12T09:14:00Z",
    resolvable: true,
    resolved: false,
  },
  {
    author: "expecto-centum",
    body: "**REQUEST CHANGES** — one red check and one correctness defect.\n\n1. **src/example.ts:42** — the retry counter resets inside the loop.",
    createdAt: "2026-08-12T18:02:00Z",
    resolvable: false,
    resolved: false,
  },
  {
    author: "alice",
    body: "Fixed the counter in the latest push — the ceiling is still open.",
    createdAt: "2026-08-13T08:30:00Z",
    resolvable: false,
    resolved: false,
  },
];

export default function createStage() {
  return {
    name: "discussion",
    version: "1",
    async run(ctx: StageContext): Promise<StageOutcome> {
      // Pace the Test run by this stage's configured fixture delay (Config
      // tab → Test → Stage delay), so the dashboard steps through visibly.
      await ctx.sleep();
      // The same machine states the live stage sets, so the secretary
      // artwork (stages/discussion.svg) plays its beats in Test mode too.
      const pacer = createStatePacer(ctx.machine, ctx.signal);
      await pacer.showState("reading-thread");
      await ctx.sleep();

      ctx.state[ctx.writes[0] ?? "existingComments"] = renderDiscussion(CANNED);
      await pacer.showState(CANNED.length === 0 ? "empty-thread" : "transcribing");
      ctx.log(`Fixture run — ${CANNED.length} stand-in comment(s), 1 in an unresolved thread.`);
      await pacer.settle(MACHINE_LOOP_MS);
      return { status: "continue" };
    },
  } satisfies Stage;
}
