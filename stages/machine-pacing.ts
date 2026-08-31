// Machine artwork is wall-clock work. A stage that finishes in
// milliseconds flips its machine to "done" before anything on screen has
// moved, and states set back-to-back overwrite each other faster than the
// art can play a single beat. These helpers hold each state long enough to
// read, and keep a stage on screen for at least one pass of its loop.
//
// MACHINE_LOOP_MS is the animation duration the artwork under stages/*.svg
// is authored at. Holding a state for one full loop means every state shows
// a complete pass rather than cutting its character off mid-gesture — keep
// the two in step if either changes.

/** One pass of a machine's animation loop, in milliseconds. */
export const MACHINE_LOOP_MS = 1800;

/**
 * Resolves after `ms`, or at once if the run is stopped. Never swallows the
 * stop — the stage's next provider call still throws, this just doesn't
 * sleep through it.
 */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Drives one stage's machine states at a pace the artwork can play. */
export interface StatePacer {
  /**
   * Move the machine on, holding the state it is leaving for a full loop
   * first. Re-setting the state the machine is already in is a no-op:
   * re-applying a state restarts that state's CSS animations, so a stage
   * that announces the same state per repo (or per comment) would otherwise
   * make its machine stutter.
   */
  showState(state: string): Promise<void>;
  /**
   * Hold the stage open until it has been on screen for `minTotalMs` and the
   * current state has had its full loop. Call once, immediately before
   * returning the outcome.
   */
  settle(minTotalMs: number): Promise<void>;
}

export function createStatePacer(
  machine: { setState(state: string): void },
  signal: AbortSignal,
): StatePacer {
  const startedAt = Date.now();
  let shownAt = 0;
  let showing = "";
  return {
    async showState(state) {
      if (state === showing) return;
      if (shownAt > 0) await pause(MACHINE_LOOP_MS - (Date.now() - shownAt), signal);
      machine.setState(state);
      showing = state;
      shownAt = Date.now();
    },
    settle(minTotalMs) {
      const sinceStart = minTotalMs - (Date.now() - startedAt);
      const sinceState = shownAt > 0 ? MACHINE_LOOP_MS - (Date.now() - shownAt) : 0;
      return pause(Math.max(sinceStart, sinceState), signal);
    },
  };
}
