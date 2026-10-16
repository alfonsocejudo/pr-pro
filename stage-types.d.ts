// stage-types.d.ts — typed contract for this workflow's stage modules.
//
// WRITTEN BY THE APP on every workflow save; hand edits are overwritten.
// Import from a stage file with a TYPE-ONLY import — Bun erases it at
// load time, so stage modules stay runtime-self-contained:
//
//   import type { StageContext, StageOutcome } from "../stage-types";
//
//   export default function createStage() {
//     return {
//       name: "my-stage",
//       async run(ctx: StageContext, config: StageRunConfig): Promise<StageOutcome> {
//         ...
//         return { status: "continue" };
//       },
//     } satisfies Stage;
//   }
//
// A regular (value) import of app code is refused by the sandbox — only
// the types travel.

/** Console log level. */
export type StageLogLevel = "info" | "success" | "error" | "warn";

/** Whose problem an `error` line is. `"configuration"`: the app works and
 *  the setup doesn't — the remedy is a Config surface the message names.
 *  `"verdict"`: the stage judged the work and stopped — the remedy is on
 *  the ticket. Neither is offered as an error report to the developers;
 *  an unclassified error line is. */
export type LogFault = "configuration" | "verdict";

/** Write one line to the stage's Execution Console thread. `fault`
 *  classifies an `error` line — see `LogFault`. */
export type StageLogger = (message: string, level?: StageLogLevel, fault?: LogFault) => void;

/** Token usage chunk for the dashboard's live burn meter. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

/** Kanban lifecycle column of a ticket. */
export type TicketLifecycleStatus =
  | "attention"
  | "backlog"
  | "queue"
  | "processing"
  | "paused"
  | "merged"
  | "done";

/** Where one acceptance criterion stands after a stage judged it. */
export type AcceptanceCriterionStatus = "pending" | "passed" | "failed";

/** One operator-authored acceptance criterion on a ticket — the rubric a
 *  reviewing stage judges the work against. */
export interface AcceptanceCriterion {
  text: string;
  status: AcceptanceCriterionStatus;
  /** How the criterion is checked: through the booted app, a call, or a
   *  stored row. Absent reads as `"ui-flow"`. */
  verifiedThrough?: "ui-flow" | "api-call" | "data-state";
}

/** A file attached to a ticket comment at its upstream source. */
export interface TicketCommentAttachment {
  src: string;
  caption?: string;
}

/** One row of the app's own comment log on a ticket it owns end-to-end
 *  — a stage's summary, a lifecycle note, an operator's remark. */
export interface TicketComment {
  author: string;
  body: string;
  at: string;
  attachments?: TicketCommentAttachment[];
  editable?: boolean;
}

/** One comment already on the ticket at its upstream tracker, plain
 *  text, as the scan read it. */
export interface UpstreamComment {
  author: string;
  body: string;
  at: string;
}

/** One transition in the ticket's kanban history — which column it moved
 *  to, and when. */
export interface TicketStatusHistoryEntry {
  status: TicketLifecycleStatus;
  reason: string;
  at: string;
}

/** One unit of work flowing through the pipeline. A pre-run producer
 *  stage mints these onto `state.tickets`; per-ticket stages receive the
 *  active one as `ctx.ticket` / `ctx.state.ticket`. */
export interface Ticket {
  key: string;
  summary: string;
  description: string;
  ticketType: string;
  priority: string;
  labels: string[];
  status: TicketLifecycleStatus;
  upstreamStatus?: string;
  assignee: string | null;
  /** ISO timestamps. `updated` is the dedup fallback when no
   *  `revision` is set. */
  created: string;
  updated: string;
  /** Opaque marker of the revision of work this ticket stands for — a
   *  reviewed pull request's `headSha`, for instance. Dedup prefers it
   *  over `updated` and compares it by equality, so upstream activity
   *  that leaves the work untouched (a comment, a label) doesn't re-queue
   *  an already-processed ticket while a real change does. Leave unset
   *  when the only version signal is a modification time. */
  revision?: string;
  /** The operator asked for this ticket to run again even though the app
   *  already processed its current version. Set it when a scan setting
   *  offers a re-run option; dedup passes a flagged ticket through and
   *  records the same marker on completion. Leave unset for normal dedup. */
  reprocess?: boolean;
  /** Producing source's name — a scanner sets its own marker here. */
  source: string;
  /** Canonical upstream URL (MR/issue page), when one exists. */
  sourceUrl?: string;
  /** The identifier the tracker addresses the record by, when the
   *  connection's ticket-name template made `key` something else. A
   *  scanner that names tickets its own way sets this to what its
   *  per-ticket calls take; the app sends it back through those calls. */
  upstreamId?: string;
  /** The code host project the ticket was filed on: the host as its
   *  connection names it (`github.com`, a GitLab origin) and the path
   *  there. A scanner reading a code host's issue list sets it; the app
   *  routes the ticket to the configured repo whose remote points at that
   *  project on that host. */
  upstreamProject?: { host: string; path: string };
  /** Configured repo `name` this ticket is pinned to, bypassing the matcher. */
  pinnedRepo?: string;
  /** Operator-chosen base branch for the ticket's work; overrides hints and the repo default. */
  baseBranch?: string;
  baseBranchHints?: string[];
  /** The merge commit a landing stage put on the base branch for this
   *  ticket's work. Set with the flip to `merged`; the publish that
   *  pushes the base branch flips the ticket to `done` once the remote
   *  holds this commit. Read-only for a stage. */
  mergeCommit?: string;
  /** The ticket's acceptance criteria. A tracker ticket's checklist under
   *  an "Acceptance criteria" heading lands here at scan time, and leaves
   *  `description`: a prompt that shows the ticket renders both. */
  acceptanceCriteria?: AcceptanceCriterion[];
  statusHistory?: TicketStatusHistoryEntry[];
  dependsOn?: string[];
  comments?: TicketComment[];
  /** The tracker's existing comments, oldest first, newest few kept.
   *  Read once per ticket after the scan; `renderTicketForPrompt`
   *  inlines them beside the description. */
  upstreamComments?: UpstreamComment[];
  orderIndex?: number;
  /** Facts your pre-run stage learned about this ticket, carried to the
   *  per-ticket stages that need them. The values are opaque — nothing
   *  reads, interprets, or displays them; the workflow that writes a key
   *  is the workflow that reads it. The bag itself must be a JSON
   *  object: a ticket whose `workflowData` is anything else fails
   *  validation on read and never reaches the board.
   *
   *  This is the channel from a scan to the run that works the ticket.
   *  They are separate runs: `ctx.state` written by a pre-run stage
   *  belongs to the scan, and a Start seeds a fresh bag from the ticket
   *  buffer. Shared Data passes work between stages *inside* one run;
   *  this crosses between them. */
  workflowData?: Record<string, unknown>;
}

/** One entry of the app's repo registry (General → Local repositories). */
export interface RepoConfig {
  name: string;
  path: string;
  srcRoot: string;
  defaultBranch: string;
  /** Id of the Connection bound to this repo — set only when several
   *  connections reach the host its remote names, to pick among them.
   *  Absent, the repo publishes through the connection for that host. */
  connectionId?: string;
  keywords?: string[];
  excludeFromRouting?: boolean;
}

/** A connection's provider. The three VCS hosts publish and read merge
 *  requests; `google` and `anthropic` are API-key AI providers. */
export type Provider = "github" | "gitlab" | "bitbucket" | "google" | "anthropic";

/** Identity-only record of a saved connection — tokens never appear here. */
export interface Connection {
  id: string;
  label: string;
  identity: string;
  provider: Provider;
  host: string;
  clientId?: string;
  tokenKind?: "api-token" | "access-token";
}

/** Provider-agnostic summary of one open merge/pull request. */
export interface MergeRequestSummary {
  number: number;
  title: string;
  description: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  labels: string[];
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  /** Sha of the source branch's head commit — the exact revision under
   *  review. Moves only when the branch does, unlike `updatedAt`, so it's
   *  what a review workflow sets `Ticket.revision` from. Empty string when
   *  the provider omits it. */
  headSha: string;
}

/** One human-authored comment already on a merge/pull request. Provider
 *  system notes are dropped, so every entry is something a person wrote.
 *  `resolvable` marks a code-line review thread; plain timeline comments
 *  are false, and `resolved` says whether a thread was settled. */
export interface MergeRequestComment {
  author: string;
  body: string;
  createdAt: string;
  resolvable: boolean;
  resolved: boolean;
}

/** One authenticated API call through a connection. `path` is relative
 *  to the provider's API base and must start with "/". */
export interface StageConnectionRequest {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  files?: readonly {
    field: string;
    path: string;
    filename?: string;
    contentType?: string;
  }[];
}

/** What `ctx.connections.request` returns: the provider's status and
 *  parsed body, plus the headers (pagination links live there). */
export interface StageConnectionResponse {
  status: number;
  ok: boolean;
  body: unknown;
  headers: Record<string, string>;
}

/** The app's saved connections, without secret access — `request`
 *  resolves the token internally at the moment of use. */
export interface StageConnectionsAccess {
  list(): readonly Connection[];
  /** The connection the repo publishes through, read off the host its
   *  publish remote names (`repo.connectionId` picks among several on
   *  that host); null with no remote or no connection on its host. */
  forRepo(
    repo: { path: string; connectionId?: string | undefined },
    opts?: { signal?: AbortSignal },
  ): Promise<Connection | null>;
  request(connectionId: string, req: StageConnectionRequest): Promise<StageConnectionResponse>;
  listOpenMergeRequests(
    connectionId: string,
    repoPath: string,
    opts?: { signal?: AbortSignal },
  ): Promise<readonly MergeRequestSummary[]>;
  listMergeRequestComments(
    connectionId: string,
    repoPath: string,
    mrNumber: number,
    opts?: { signal?: AbortSignal },
  ): Promise<readonly MergeRequestComment[]>;
  uploadCommentImage(
    connectionId: string,
    repoPath: string,
    filePath: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ url: string; markdown: string }>;
}

/** Handle for driving the stage's UI machine visualization (dialogs ride
 *  `waitFor` round-trips keyed by machine events). */
export interface MachineHandle {
  setState(state: string): void;
  trigger(name: string, payload?: Record<string, unknown>): void;
  waitFor(
    event: string,
    opts?: { timeoutMs?: number },
  ): Promise<Record<string, unknown> | undefined>;
}

/** Arbitrary domain event a stage emits through the runner's SSE stream. */
export interface StageEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Emit a domain event onto the run's SSE stream, for the dashboard or a
 *  machine to react to. */
export type StageEmitter = (event: StageEvent) => void;

/** The ticket's evidence directory — outside any worktree. `dir()`
 *  creates on first call; `imagePath(file)` is the `/api/evidence/...`
 *  path a dialog Image node loads a saved capture from. */
export interface EvidenceStore {
  dir(): Promise<string>;
  imagePath(file: string): string;
}

/** The run's shared-state bag. Fields your stages pass work through are
 *  declared in the editor's Shared Data section (`workflow.json`'s
 *  `sharedData`); access is enforced against this stage's declared
 *  `reads` / `writes` at run time. */
export type WorkflowState = {
  ticket?: Ticket;
  tickets?: Ticket[];
  /** Repo the operator targeted when the run's tickets were created. */
  repoPath?: string;
  /** True on 24/7-launched runs — no operator is at the keyboard. */
  unattended?: boolean;
} & Record<string, unknown>;

/** One settings bag — this stage's tunables from `workflow.json`, keyed
 *  by tunable name. Values are what the operator set (or the declared
 *  default); the shape is manifest-defined, hence `any`. */
export type StageSettings = Record<string, any>;

/** What `run()` receives as its second argument: settings bags keyed by
 *  section id. Manifest tunables land under `config.settings`. */
export type StageRunConfig = Record<string, StageSettings>;

/**
 * What `run()` receives as its first argument — everything a stage can
 * reach. Data flows through `state`, guarded by the Inputs and Outputs
 * declared for this stage in the editor; work goes out through
 * `runAgent` and `connections`; progress comes back through `log`,
 * `machine`, and `reportTokens`.
 */
export interface StageContext {
  readonly runId: string;
  /** Active workflow's manifest name. */
  readonly workflow: string;
  /** Manifest-resolved id of this stage instance. */
  readonly stageId: string;
  /** The active ticket. A sentinel on pre-run / post-run stages — read
   *  `state.tickets` there instead. */
  readonly ticket: Ticket;
  readonly repos: readonly RepoConfig[];
  /** Fires on operator Skip/Stop — pass it to long waits and re-throw
   *  AbortError. */
  readonly signal: AbortSignal;
  readonly log: StageLogger;
  readonly reportTokens: (delta: TokenUsage) => void;
  /** Fixture pacing: waits the configured Test-mode delay, resolves
   *  immediately live. */
  readonly sleep: () => Promise<void>;
  readonly emit: StageEmitter;
  readonly machine: MachineHandle;
  /** Composite stages label their active AI sub-phase; atomic stages
   *  never call it. */
  readonly setActiveAgent: (slotId: string | null) => Promise<void>;
  /** Run this stage's configured CLI agent. `outputs` requests a
   *  structured reply with one string value per named field. `cwd`
   *  defaults to the run's targeted repo, else the project folder. */
  readonly runAgent: {
    (opts: { prompt: string; cwd?: string; outputs: readonly string[] }): Promise<{
      text: string;
      outputs: Record<string, string>;
    }>;
    (opts: { prompt: string; cwd?: string }): Promise<{ text: string }>;
  };
  readonly evidence: EvidenceStore;
  /** A private checkout for this stage to work in. `at(ref)` gives a
   *  detached worktree of `ref` (a sha, a branch, a remote-tracking
   *  ref) from the ticket's pinned repo unless `repoPath` names
   *  another; the engine removes it when the stage ends, however it
   *  ends. Use it instead of working in the operator's own checkout —
   *  and instead of asking an agent to make one and remember to remove
   *  it, which a cancel breaks. Tracked files only, unless
   *  `installDependencies: true`: then the project's dependencies are
   *  installed from its committed lockfiles before the path is handed
   *  over, for a stage that runs the code rather than reads it. With
   *  `lifetime: "ticket"` the engine keeps the checkout until the
   *  ticket's last stage has ended, and a later stage asking for the
   *  same ref of the same repo with the same install choice gets the
   *  same path — one checkout and one install per ticket. */
  readonly worktree: {
    at(
      ref: string,
      opts?: { repoPath?: string; installDependencies?: boolean; lifetime?: "stage" | "ticket" },
    ): Promise<{ path: string }>;
  };
  readonly connections: StageConnectionsAccess;
  /** Post a plain-text comment to the ticket's upstream source. `false`
   *  (after a Console line) when structurally impossible; provider
   *  failures throw. */
  readonly postTicketComment: (body: string, opts?: { signal?: AbortSignal }) => Promise<boolean>;
  /** This stage's validated data I/O, as wired in the editor. */
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  /** Guarded: reading/writing a key outside declared `reads`/`writes`
   *  throws, naming the key and where to declare it. */
  state: WorkflowState;
}

/** Non-`continue` outcomes stop the ticket: `filter` is a policy
 *  decision, `abort` a failure, `retry` a transient to re-run. */
export type StageOutcome =
  | { readonly status: "continue" }
  | { readonly status: "filter"; readonly reason: string; readonly message?: string }
  | {
      readonly status: "abort";
      readonly error: Error;
      readonly message?: string;
      /** `"configuration"` when the operator fixes it in Config — the run
       *  ends `unconfigured`, or a per-ticket stage's ticket returns to
       *  the queue, unparked, so the stage's recovery actions are not
       *  offered for it — and `"verdict"` when it is the run's judgment
       *  of the ticket. Either keeps the Console's error-report offer off
       *  the line; absent, the abort reads as a defect in the stage. */
      readonly fault?: LogFault;
    }
  | {
      readonly status: "retry";
      readonly after?: number;
      readonly reason: string;
      readonly message?: string;
    };

/** Branch identity recorded when a ticket parks, so recovery can find
 *  the code state the failed run produced. `baseBranch` is the branch
 *  the work merges into, when the failed run picked one. */
export interface BranchSnapshot {
  readonly branch: string;
  readonly sha?: string;
  readonly repoName?: string;
  readonly baseBranch?: string;
}

/** What a recovery action's `matches` predicate sees. Keep predicates
 *  pure — no I/O, no closure over factory state. */
export interface FailureContext {
  readonly workflow: string;
  readonly ticketKey: string;
  readonly failedStage: string;
  readonly failureKind: "filter" | "abort" | "exception" | "capped";
  readonly reason: string;
  readonly at: string;
  readonly branchSnapshot?: BranchSnapshot;
}

/** What a recovery action's `run` receives. `state` is seeded from the
 *  failed run's shared-data snapshot; `evidence` is bound to the FAILED
 *  run's directory so captures it saved can be salvaged. */
export interface RecoveryRunContext {
  readonly workflow: string;
  readonly ticket: Ticket;
  readonly repos: readonly RepoConfig[];
  readonly state: WorkflowState;
  readonly worktree?: { path: string; startRef: string; release(): Promise<void> };
  readonly log: StageLogger;
  readonly signal: AbortSignal;
  readonly failure: FailureContext;
  readonly connections: StageConnectionsAccess;
  readonly ticketsDir?: string;
  readonly evidence?: EvidenceStore;
}

/** Operator-driven recovery for tickets this stage parks at Attention.
 *  `run` substitutes for the failed stage; the pipeline resumes from
 *  the next stage. Must be idempotent. */
export interface RecoveryAction {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly needsWorktree?: boolean;
  matches(failure: FailureContext): boolean;
  run(ctx: RecoveryRunContext): Promise<void>;
}

/** A stage module's loaded shape. `scope`, `reads`, and `writes` are
 *  authoritative in `workflow.json` — omit them here and the manifest's
 *  values apply. */
export interface Stage {
  readonly name: string;
  /** Bump when `run` semantics change materially. Defaults to "1". */
  readonly version?: string;
  readonly scope?: "pre-run" | "per-ticket" | "post-run";
  readonly reads?: readonly string[];
  readonly writes?: readonly string[];
  /** Fixture twins set `true` so dry runs don't mutate external state. */
  readonly readOnly?: boolean;
  readonly preflight?: {
    readonly requiresTicketSource?: boolean;
    readonly requiresRepos?: boolean;
    readonly requiresPublishTarget?: boolean;
  };
  readonly recoveryActions?: readonly RecoveryAction[];
  init?(env: Record<string, string | undefined>): void | Promise<void>;
  dispose?(): void | Promise<void>;
  idempotencyKey?(ctx: StageContext): string;
  run(ctx: StageContext, config: StageRunConfig): Promise<StageOutcome>;
}

/** What the module default-exports (or exports as `createStage`). */
export type StageFactory = (
  env: Record<string, string | undefined>,
) => Stage | Promise<Stage>;
