// A shared helper, not a stage: workflow.json never names this file, and it
// exports no stage factory. Keep its name clear of any machine id — the
// editor writes a machine's starter to stages/<machineId>.ts, so a machine
// whose label slugified to this filename would point the manifest here.
//
// Every review stage in this workflow opens its report with a verdict on
// its own line, and each machine's artwork reacts to which one it was.
// Matching that line is normalization plus an anchored test, not a
// substring scan: the agent wraps the verdict in whatever markdown it
// likes and spells it however it likes, and the reason follows on the
// same line.
//
// A substring scan gets both directions wrong. Loose enough to catch
// "REQUESTING CHANGES", it also catches "no changes requested" inside an
// approval; tight enough to avoid that, it misses every spelling but one.
// Anchoring the test to the start of the normalized line settles it — the
// verdict leads, the reason follows.
//
// A line that opens with neither verdict is not a verdict, and these
// return `null` rather than the benign outcome. Reporting an unreadable
// review as an approval (or as clean) is the one failure mode that must
// not be silent: the stage still saves the report, but its machine shows
// no call and the stage says why.
//
// Every report also has a third opening available to it: BLOCKED, for a
// pass the agent could not carry out at all — the branches would not
// fetch, the worktree would not build. That is not a verdict on the
// change, and `blockedReason` reads it out so the stage can fail rather
// than save a non-review as a finished one. An agent offered only the
// two real verdicts fits an unreviewable pull request into whichever
// one sounds more cautious, and the stage then reports it as reviewed.

/**
 * The report's first line, upper-cased with every run of non-letters
 * collapsed to a single space and an optional leading `VERDICT` label
 * dropped — so `**REQUEST CHANGES** — the retry defect…`,
 * `Verdict: request changes`, and `**2 QUALITY FINDINGS**` all normalize
 * to a bare leading verdict.
 *
 * `trim()` before the split is what makes this the first *non-empty*
 * line: leading blank lines go with it.
 */
function normalizeVerdictLine(report: string): string {
  const line = report.trim().split("\n", 1)[0] ?? "";
  return line
    .toUpperCase()
    .replace(/[^A-Z]+/g, " ")
    .trim()
    .replace(/^VERDICT /, "");
}

/**
 * The reason a report gives for being BLOCKED, or `null` when the report
 * opens with anything else. The reason is the rest of the first line
 * with the markdown wrapping and the verdict word stripped; a bare
 * BLOCKED with nothing after it comes back as the word itself, so the
 * caller always has something to show.
 */
export function blockedReason(report: string): string | null {
  if (!/^BLOCKED\b/.test(normalizeVerdictLine(report))) return null;
  const line = report.trim().split("\n", 1)[0] ?? "";
  const reason = line
    .replace(/^[\s*_#>`-]+/, "")
    .replace(/^verdict\s*:?\s*/i, "")
    .replace(/^blocked/i, "")
    .replace(/^[\s*_:—–-]*/, "")
    .trim();
  return reason.length > 0 ? reason : "BLOCKED";
}

/**
 * Which verdict a correctness or evidence report opens with, or `null`
 * when it opens with neither — BLOCKED included, which `blockedReason`
 * reads separately. Both spellings of a rejection count —
 * "request changes" and "changes requested", singular or plural,
 * "requests"/"requesting" included.
 */
export function reviewVerdict(report: string): "approved" | "changes-requested" | null {
  const verdict = normalizeVerdictLine(report);
  if (/^(REQUESTS?(ING)? CHANGES?|CHANGES? REQUESTED)\b/.test(verdict)) return "changes-requested";
  if (/^APPROVED?\b/.test(verdict)) return "approved";
  return null;
}

/**
 * Which opening line a quality report carries, or `null` when it carries
 * neither. The findings line leads with a count (`**2 QUALITY
 * FINDINGS**`); the digits normalize away, so the test looks for the
 * word. "No findings" is a clean report however it is worded.
 */
export function qualityVerdict(report: string): "clean" | "findings" | null {
  const verdict = normalizeVerdictLine(report);
  if (/^(CLEAN|NO (QUALITY )?FINDINGS?)\b/.test(verdict)) return "clean";
  if (/^(QUALITY )?FINDINGS?\b/.test(verdict)) return "findings";
  return null;
}

/** What a stage logs when its agent's report opens with no verdict. */
export function unreadableVerdictWarning(expected: string): string {
  return `The report's first line is not a verdict — expected ${expected}. The report is saved and the run continues; the machine shows no call.`;
}
