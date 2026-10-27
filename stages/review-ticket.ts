// A review ticket's snapshot of its pull request. PR Scan takes it when
// it mints the ticket, and Correctness takes it again when the ticket
// reaches it: a ticket waits in the queue as long as the operator leaves
// it there, and the pull request moves meanwhile — a push changes its
// head commit, a parent merged with its branch deleted retargets it — so
// a review cut from the scan's snapshot checks out a commit the author
// has moved past and diffs against a branch that no longer exists. Both
// snapshots come from here so they cannot disagree about what a ticket
// says of its pull request.

// Type-only import — erased when the stage loads; stage-types.d.ts
// (app-written, next to workflow.json) carries the contract.
import type { MergeRequestSummary, Ticket } from "../stage-types";

/** The fields a ticket's text is built from. */
export type PullRequestText = Pick<
  MergeRequestSummary,
  "sourceBranch" | "targetBranch" | "webUrl" | "author" | "description"
>;

/** The fields that move while a ticket waits. `key`, `status`, `source`,
 *  `pinnedRepo`, `created` and the scan's own stamps stay the ticket's. */
export type PullRequestSnapshot = Pick<
  Ticket,
  "summary" | "description" | "labels" | "updated" | "revision" | "sourceUrl" | "baseBranchHints"
>;

/**
 * A ticket's description. Markdown — the dashboard's ticket card renders
 * it, so the header fields are a list (single newlines inside a markdown
 * paragraph collapse) and the PR body sits under a rule.
 */
export function describePullRequest(repoName: string, pr: PullRequestText): string {
  return [
    `Code-review the open pull request below. Read the full diff of`,
    `\`${pr.sourceBranch}\` against \`${pr.targetBranch}\` and report findings.`,
    ``,
    `- **PR:** ${pr.webUrl}`,
    `- **Repo:** ${repoName}`,
    `- **Author:** ${pr.author || "(unknown)"}`,
    `- **Source branch:** \`${pr.sourceBranch}\``,
    `- **Target branch:** \`${pr.targetBranch}\``,
    ``,
    `---`,
    ``,
    pr.description || "*(no PR description)*",
  ].join("\n");
}

/**
 * What a ticket carries of the pull request as it stands. `revision` is
 * the head commit — the dedup identity and the commit the review checks
 * out; a provider that omits the sha leaves the ticket's own in place.
 */
export function pullRequestSnapshot(
  repoName: string,
  pr: MergeRequestSummary,
  prior?: Pick<Ticket, "revision">,
): PullRequestSnapshot {
  return {
    summary: `Review: ${pr.title}`,
    description: describePullRequest(repoName, pr),
    labels: pr.labels,
    updated: pr.updatedAt,
    revision: pr.headSha || prior?.revision,
    sourceUrl: pr.webUrl,
    baseBranchHints: [pr.targetBranch],
  };
}

/**
 * How the pull request moved since the ticket's snapshot, as a sentence
 * for the Console, or null when it did not. Two facts count: the head
 * commit the checkout is cut at and the target branch the diff is taken
 * against. A title or body edit moves nothing the review is cut from.
 */
export function pullRequestMoved(
  ticket: Pick<Ticket, "revision" | "baseBranchHints">,
  pr: Pick<MergeRequestSummary, "headSha" | "targetBranch">,
): string | null {
  const moves: string[] = [];
  if (pr.headSha && ticket.revision && pr.headSha !== ticket.revision) {
    moves.push(`its head moved from ${ticket.revision.slice(0, 7)} to ${pr.headSha.slice(0, 7)}`);
  }
  const target = ticket.baseBranchHints?.[0];
  if (target && pr.targetBranch !== target) {
    moves.push(`its target branch changed from ${target} to ${pr.targetBranch}`);
  }
  return moves.length > 0 ? moves.join(" and ") : null;
}
