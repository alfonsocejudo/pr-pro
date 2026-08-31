// PR Scan — turns each selected repo's open pull requests into review
// tickets for the downstream stages. Repos are picked in this stage's
// Settings (the gear above the machine). Each selected repo resolves
// through its bound account (set in the repo's edit dialog, General →
// Local repositories); which provider project the repo names is read
// from the folder's own git remotes at call time. The app makes the
// signed provider calls itself — this code never sees a credential.
//
// One ticket per open, non-draft PR. Dedup keys on the ticket's
// `revision` — the PR's head commit sha — so each revision of the code is
// reviewed once and a new push re-queues it on the next scan. Activity that
// leaves the branch alone (a comment, a label, an assignee change) does not,
// which is what keeps the review this workflow posts from re-queuing the
// PR it was posted on.
//
// The Authors setting narrows the scan to certain PR authors:
// comma-separated usernames, matched case-insensitively (a leading "@"
// is tolerated). Empty means every author.
//
// The Lookback setting narrows the scan by date: only PRs updated
// within the last N days are ticketed. It keys on the PR's last-update
// time — the same field dedup keys on — so an old PR with a fresh push
// re-enters the window. 0 means no date limit.
//
// The Since / Until settings bound that same last-update time with
// fixed calendar dates — useful for auditing a specific period's PRs.
// Both ends are inclusive whole days (Until runs through the end of the
// picked day, UTC); either side may be empty. All three date settings
// combine: an PR must satisfy every bound that is set.

// Type-only import — erased when the stage loads, so this file stays
// runtime-self-contained; stage-types.d.ts (app-written, next to
// workflow.json) carries the contract.
import type {
  MergeRequestSummary,
  Stage,
  StageContext,
  StageOutcome,
  StageRunConfig,
  Ticket,
} from "../stage-types";

import { createStatePacer, MACHINE_LOOP_MS } from "./machine-pacing.ts";

/** Parse the Authors setting into normalized usernames. */
function parseAuthorFilter(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^@/, "").toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** Whether an PR's author passes the parsed filter (empty filter = all). */
function authorMatches(author: string | undefined, filter: readonly string[]): boolean {
  if (filter.length === 0) return true;
  return filter.includes((author ?? "").trim().replace(/^@/, "").toLowerCase());
}

export default function createStage() {
  return {
    name: "pr-scan",
    version: "1",
    async run(ctx: StageContext, config: StageRunConfig): Promise<StageOutcome> {
      const selected: string[] = config.settings.repos ?? [];
      if (selected.length === 0) {
        // An empty selection is an operator-config error — fail the stage
        // so the machine reflects it.
        return {
          status: "abort",
          error: new Error("No repos selected — pick repos to scan in this stage's Settings."),
        };
      }

      const pacer = createStatePacer(ctx.machine, ctx.signal);

      const authorFilter = parseAuthorFilter(config.settings.authors);
      if (authorFilter.length > 0) {
        ctx.log(`Reviewing PRs by: ${authorFilter.join(", ")}`, "info");
      }

      const lookbackDays: number = config.settings.lookback ?? 0;
      const cutoffMs = lookbackDays > 0 ? Date.now() - lookbackDays * 86_400_000 : null;
      if (cutoffMs !== null) {
        ctx.log(`Reviewing PRs updated in the last ${lookbackDays} day(s).`, "info");
      }

      // Fixed date bounds ride the same last-update time as Lookback. A
      // picked date is a whole UTC day: Since starts at its midnight,
      // Until includes everything before the following midnight.
      const sinceRaw: string = config.settings.since ?? "";
      const untilRaw: string = config.settings.until ?? "";
      const sinceMs = sinceRaw ? Date.parse(sinceRaw) : null;
      const untilMs = untilRaw ? Date.parse(untilRaw) + 86_400_000 : null;
      if (sinceMs !== null || untilMs !== null) {
        const bounds = [
          ...(sinceRaw ? [`from ${sinceRaw}`] : []),
          ...(untilRaw ? [`through ${untilRaw}`] : []),
        ];
        ctx.log(`Reviewing PRs updated ${bounds.join(" ")}.`, "info");
      }
      if (sinceMs !== null && untilMs !== null && sinceMs >= untilMs) {
        ctx.log(`The date range is empty — "since" is after "until", so no PRs will match.`, "warn");
      }

      /** Whether an PR's last-update time passes every date bound that is set. */
      const inDateWindow = (pr: MergeRequestSummary): boolean => {
        const updated = new Date(pr.updatedAt).getTime();
        if (cutoffMs !== null && updated < cutoffMs) return false;
        if (sinceMs !== null && updated < sinceMs) return false;
        if (untilMs !== null && updated >= untilMs) return false;
        return true;
      };

      const connections = ctx.connections.list();
      const tickets: Ticket[] = [];
      // Totals across every repo, so the sorting and ticketing beats play
      // once for the scan rather than once per repo.
      let dropped = 0;
      // Repos that made it past every skip and actually got their PRs
      // listed. Selected repos that all fall through is an operator-config
      // error, not a clean empty scan — the stage aborts on it below.
      let scannedRepos = 0;
      for (const name of selected) {
        // Machine states drive the mailroom-clerk artwork (stages/pr-scan.svg):
        // the pigeonhole wall lights a column per repo, discarded mail drops
        // into the bin, and minted tickets stack in the out-tray. The runner
        // owns the surrounding "active" / "complete" / "failed" bracket.
        await pacer.showState("scanning-repo");
        const repo = ctx.repos.find((r) => r.name === name);
        if (!repo) {
          ctx.log(`Repo "${name}" is not in the configured repo list — skipping.`, "warn");
          await pacer.showState("repo-skipped");
          continue;
        }
        const connection = connections.find((c) => c.id === repo.connectionId);
        if (!connection) {
          ctx.log(
            `Skipping repo "${repo.name}" — it has no "Publish to" account. Edit the repo under General → Local repositories and set one; if the list is empty, connect a GitHub, GitLab, or Bitbucket account in the Connections tab first.`,
            "warn",
          );
          await pacer.showState("repo-skipped");
          continue;
        }

        // The provider project is resolved from the repo folder's git
        // remotes at call time; a folder with no remote on the account's
        // host throws with the fix in the message — skip that repo, keep
        // scanning the rest.
        let prs: readonly MergeRequestSummary[];
        try {
          prs = await ctx.connections.listOpenMergeRequests(connection.id, repo.path);
        } catch (err) {
          ctx.log(
            `Skipping repo "${repo.name}" — ${err instanceof Error ? err.message : String(err)}`,
            "warn",
          );
          await pacer.showState("repo-skipped");
          continue;
        }
        scannedRepos += 1;
        const nonDraft = prs.filter((pr) => !pr.draft);
        const drafts = prs.length - nonDraft.length;
        const byAuthor = nonDraft.filter((pr) => authorMatches(pr.author, authorFilter));
        const otherAuthors = nonDraft.length - byAuthor.length;
        const open = byAuthor.filter(inDateWindow);
        const outOfRange = byAuthor.length - open.length;
        for (const pr of open) {
          tickets.push({
            key: `${repo.name}#${pr.number}`,
            summary: `Review: ${pr.title}`,
            // Markdown — the dashboard's ticket card renders it, so the
            // header fields are a list (single newlines inside a markdown
            // paragraph collapse) and the PR body sits under a rule.
            description: [
              `Code-review the open pull request below. Read the full diff of`,
              `\`${pr.sourceBranch}\` against \`${pr.targetBranch}\` and report findings.`,
              ``,
              `- **PR:** ${pr.webUrl}`,
              `- **Repo:** ${repo.name}`,
              `- **Author:** ${pr.author || "(unknown)"}`,
              `- **Source branch:** \`${pr.sourceBranch}\``,
              `- **Target branch:** \`${pr.targetBranch}\``,
              ``,
              `---`,
              ``,
              pr.description || "*(no PR description)*",
            ].join("\n"),
            ticketType: "Code Review",
            priority: "medium",
            labels: pr.labels,
            status: "queue",
            assignee: null,
            created: pr.createdAt,
            updated: pr.updatedAt,
            // Dedup identity: the head commit under review. A push moves it
            // and the PR comes back for another look; a comment or a label
            // edit doesn't, so a reviewed PR stays reviewed.
            revision: pr.headSha,
            source: "pr-scan",
            sourceUrl: pr.webUrl,
            // Binds the work to the repo the PR belongs to — no matching
            // heuristics downstream.
            pinnedRepo: repo.name,
            baseBranchHints: [pr.targetBranch],
          });
        }
        const skipNotes = [
          ...(drafts > 0 ? [`${drafts} draft${drafts === 1 ? "" : "s"}`] : []),
          ...(otherAuthors > 0 ? [`${otherAuthors} by other authors`] : []),
          ...(outOfRange > 0 ? [`${outOfRange} outside the date window`] : []),
        ];
        dropped += drafts + otherAuthors + outOfRange;
        const skipNote = skipNotes.length > 0 ? ` (${skipNotes.join(", ")} skipped)` : "";
        ctx.log(`${repo.name}: ${open.length} open PR(s)${skipNote}`, "success");
      }

      if (scannedRepos === 0) {
        // Every selected repo was skipped — an operator-config error. The
        // abort fails the stage on the machine; the per-repo warnings above
        // name each repo's fix.
        return {
          status: "abort",
          error: new Error(
            `None of the ${selected.length} selected repo(s) could be scanned — see the warnings above for what each one needs.`,
          ),
        };
      }

      if (dropped > 0) await pacer.showState("sorting");
      if (tickets.length > 0) await pacer.showState("ticketing");

      // Two full passes, so the clerk visibly works more than one envelope.
      await pacer.settle(MACHINE_LOOP_MS * 2);

      ctx.state.tickets = tickets;
      ctx.log(
        `Created ${tickets.length} review ticket(s).`,
        tickets.length > 0 ? "success" : "info",
      );
      return { status: "continue" };
    },
  } satisfies Stage;
}
