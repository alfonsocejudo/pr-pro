// Fixture twin — runs in Test mode with no side effects. Test mode makes
// no provider calls, so this twin mints canned PR-shaped tickets in the
// same shape the live stage produces from real open pull requests.
// Type-only import — erased when the stage loads; stage-types.d.ts
// (app-written, next to workflow.json) carries the contract.
import type { Stage, StageContext, StageOutcome, StageRunConfig } from "../stage-types";

export default function createStage() {
  return {
    name: "pr-scan",
    version: "1",
    async run(ctx: StageContext, config: StageRunConfig): Promise<StageOutcome> {
      // Pace the Test run by this stage's configured fixture delay (Config
      // tab → Test → Stage delay), so the dashboard steps through visibly.
      await ctx.sleep();

      // Use the first selected repo's name when one is picked so the
      // stand-ins read like the live output; fall back to a placeholder.
      const selected: string[] = config.settings.repos ?? [];
      const repoName = selected[0] ?? "sample-repo";
      const repoIsReal = ctx.repos.some((r) => r.name === repoName);

      // Same Authors semantics as the live stage: comma-separated
      // usernames, case-insensitive, leading "@" tolerated, empty = all.
      const authorsRaw: string = config.settings.authors ?? "";
      const authorFilter = authorsRaw
        .split(",")
        .map((entry) => entry.trim().replace(/^@/, "").toLowerCase())
        .filter((entry) => entry.length > 0);
      const authorMatches = (author: string) =>
        authorFilter.length === 0 || authorFilter.includes(author.toLowerCase());

      // Same date-window semantics as the live stage: Lookback (last N
      // days), Since, and Until all bound the PR's last-update time, and
      // every bound that is set must pass. Until covers its whole UTC day.
      // The stand-ins carry staggered ages so the settings are observable
      // in Test mode.
      const lookbackDays: number = config.settings.lookback ?? 0;
      const cutoffMs = lookbackDays > 0 ? Date.now() - lookbackDays * 86_400_000 : null;
      const sinceRaw: string = config.settings.since ?? "";
      const untilRaw: string = config.settings.until ?? "";
      const sinceMs = sinceRaw ? Date.parse(sinceRaw) : null;
      const untilMs = untilRaw ? Date.parse(untilRaw) + 86_400_000 : null;
      const inDateWindow = (pr: { updatedAt: string }) => {
        const updated = new Date(pr.updatedAt).getTime();
        if (cutoffMs !== null && updated < cutoffMs) return false;
        if (sinceMs !== null && updated < sinceMs) return false;
        if (untilMs !== null && updated >= untilMs) return false;
        return true;
      };
      const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

      const fakePrs = [
        {
          number: 101,
          title: "Add retry logic to the sync worker",
          author: "alice",
          sourceBranch: "feat/sync-retries",
          targetBranch: "main",
          body: "Retries transient failures with exponential backoff.",
          createdAt: daysAgo(3),
          updatedAt: daysAgo(0),
          headSha: "1a2b3c4d5e6f7081920a1b2c3d4e5f6071829304",
        },
        {
          number: 102,
          title: "Fix null crash on empty profile",
          author: "bob",
          sourceBranch: "fix/empty-profile",
          targetBranch: "main",
          body: "Guards the profile loader against a missing avatar record.",
          createdAt: daysAgo(60),
          updatedAt: daysAgo(45),
          headSha: "9f8e7d6c5b4a3021304f5e6d7c8b9a0112233445",
        },
      ];

      // The same machine states the live stage sets, paced by the Test-mode
      // delay so the mailroom-clerk artwork (stages/pr-scan.svg) steps through
      // its beats where an operator can watch them.
      ctx.machine.setState("scanning-repo");
      await ctx.sleep();

      const open = fakePrs.filter((pr) => authorMatches(pr.author)).filter(inDateWindow);
      if (open.length < fakePrs.length) {
        ctx.machine.setState("sorting");
        await ctx.sleep();
      }
      if (open.length > 0) {
        ctx.machine.setState("ticketing");
        await ctx.sleep();
      }
      ctx.state.tickets = open.map((pr) => ({
        key: `${repoName}#${pr.number}`,
        summary: `Review: ${pr.title}`,
        // Markdown, mirroring the live stage's description shape.
        description: [
          `Code-review the open pull request below. Read the full diff of`,
          `\`${pr.sourceBranch}\` against \`${pr.targetBranch}\` and report findings.`,
          ``,
          `- **PR:** https://example.com/${repoName}/pull/${pr.number}`,
          `- **Repo:** ${repoName}`,
          `- **Author:** ${pr.author}`,
          `- **Source branch:** \`${pr.sourceBranch}\``,
          `- **Target branch:** \`${pr.targetBranch}\``,
          ``,
          `---`,
          ``,
          pr.body,
        ].join("\n"),
        ticketType: "Code Review",
        priority: "medium",
        labels: ["test"],
        status: "queue",
        assignee: null,
        created: pr.createdAt,
        updated: pr.updatedAt,
        // Same dedup identity the live stage stamps — the head commit under
        // review. Fixture runs wire no seen store, so nothing filters on it
        // here; the field is part of the ticket shape a PR review mints.
        revision: pr.headSha,
        source: "pr-scan",
        sourceUrl: `https://example.com/${repoName}/pull/${pr.number}`,
        // Pin only when the name resolves to a configured repo — a
        // placeholder pin would break a mixed-mode run's live stages.
        ...(repoIsReal ? { pinnedRepo: repoName } : {}),
        baseBranchHints: [pr.targetBranch],
      }));
      ctx.log(`Fixture run — minted ${ctx.state.tickets.length} stand-in review ticket(s).`);
      return { status: "continue" };
    },
  } satisfies Stage;
}
