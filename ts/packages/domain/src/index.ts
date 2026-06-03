import type {
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";

// --- Bounds constants ---

export const PORT_MAX = 65535;
export const ONE_WEEK_MS = 604_800_000;
export const RENDER_INTERVAL_MAX_MS = 60_000;
export const CONCURRENCY_MAX = 1000;
export const MAX_TURNS_MAX = 10_000;
export const ENSEMBLE_SIZE_MAX = 100;

// --- Bounds validators ---

export function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= PORT_MAX;
}

export function isValidTimeoutMs(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= ONE_WEEK_MS;
}

export function isValidNonNegativeTimeoutMs(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= ONE_WEEK_MS;
}

export function isValidIntervalMs(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= ONE_WEEK_MS;
}

export function isValidRenderIntervalMs(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= RENDER_INTERVAL_MAX_MS;
}

export function isValidConcurrency(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= CONCURRENCY_MAX;
}

export function isValidMaxTurns(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_TURNS_MAX;
}

export function isValidEnsembleSize(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= ENSEMBLE_SIZE_MAX;
}

// --- Session protocol types ---

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

// --- Domain types ---

/**
 * Identifies a configured agent backend by name (e.g. `"codex"`, `"claude"`).
 * Matches a key in {@link Settings.agents} and is open-ended because operators define their own.
 */
export type AgentKind = string;

export const TRACKER_KINDS = ["linear", "memory", "local"] as const;

export type TrackerKind = (typeof TRACKER_KINDS)[number];

export const ISSUE_STATE_TYPES = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "triage",
] as const;

export type IssueStateType = (typeof ISSUE_STATE_TYPES)[number];

export const PRIORITY_VALUES = [1, 2, 3, 4] as const;

export type Priority = (typeof PRIORITY_VALUES)[number];

export const CODEX_APPROVAL_POLICY_NAMES = [
  "untrusted",
  "on-failure",
  "on-request",
  "never",
] as const;

export type CodexApprovalPolicyName = (typeof CODEX_APPROVAL_POLICY_NAMES)[number];

export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/**
 * Minimal reference to a related issue - just enough to identify it and check its state.
 * Used for relationships like blockers where the full issue isn't needed.
 */
export interface IssueRef {
  id?: string | undefined;
  identifier?: string | undefined;
  /** Tracker-specific state name (e.g. `"In Progress"`, `"Todo"`). */
  state?: string | undefined;
  /** Category bucket from the tracker: typically `"unstarted" | "started" | "completed" | "canceled" | "backlog" | "triage"`. */
  stateType?: IssueStateType | null | undefined;
}

/**
 * Normalized view of a tracker issue with everything needed to dispatch, prompt, and route it.
 * Produced from raw tracker payloads; the source object is preserved on `raw`.
 */
export interface Issue {
  /** Tracker-internal id (e.g. Linear UUID); stable primary key used everywhere. */
  id: string;
  /** Human-facing short code (e.g. `"ENG-123"`); used in logs, prompts, and UI. */
  identifier: string;
  title: string;
  description?: string | null | undefined;
  /** Display name of the workflow state (e.g. `"In Progress"`). Used as a lookup key for per-state setting overrides. */
  state: string;
  /** Category bucket from the tracker: `"unstarted" | "started" | "completed" | "canceled" | "backlog" | "triage"`. All trackers must provide this. */
  stateType: IssueStateType;
  branchName?: string | null | undefined;
  url?: string | null | undefined;
  priority?: Priority | null | undefined;
  /** ISO-8601 timestamp string as returned by the tracker; not parsed into a Date. */
  createdAt?: string | null | undefined;
  /** ISO-8601 timestamp string as returned by the tracker; not parsed into a Date. */
  updatedAt?: string | null | undefined;
  /** Lower-cased label names; ensemble size is encoded as `ensemble:<n>`. */
  labels: string[];
  blockers: IssueRef[];
  assigneeId?: string | null | undefined;
  /** True when the issue is assigned to the configured worker assignee (or no assignee filter is set). Gates dispatch. */
  assignedToWorker?: boolean | null | undefined;
  /** Untouched tracker payload kept for debugging and downstream consumers; do not rely on its shape. */
  raw?: unknown;
}

/**
 * Rules for which tracker issues this Symphony instance picks up based on label routing.
 * Routing lets multiple instances cooperate on the same project by claiming disjoint label sets.
 */
export interface DispatchSettings {
  /** When true, issues with no label matching `routeLabelPrefix` are eligible for this instance. */
  acceptUnrouted: boolean;
  /**
   * Whitelist of route names (the suffix after `routeLabelPrefix`) this instance handles.
   * `null` accepts any routed issue, `[]` accepts none, a non-empty list accepts only matching routes.
   */
  onlyRoutes: string[] | null;
  /**
   * Label prefix that designates a route. Labels starting with this prefix have the prefix stripped
   * and the remainder (trimmed, lowercased) used as the route name; e.g. `"Symphony:"` turns
   * `Symphony:backend` into route `backend`.
   */
  routeLabelPrefix: string;
}

/**
 * Connection and filtering rules for the issue tracker that feeds work into this instance.
 */
export interface TrackerSettings {
  /** Backend adapter selector. `"memory"` is an in-process fixture used for tests. */
  kind?: TrackerKind | undefined;
  endpoint: string;
  apiKey?: string | undefined;
  /** @deprecated Use `projectSlugs` instead. Single Linear project slug; required when `kind === "linear"`. */
  projectSlug?: string | undefined;
  /** Linear project slugs to monitor. Mutually exclusive with `projectLabels`. */
  projectSlugs?: string[] | undefined;
  /** Linear project labels for dynamic discovery. Mutually exclusive with `projectSlugs`. */
  projectLabels?: string[] | undefined;
  /** Tracker assignee identity (or `$VAR`) used to scope candidate queries to one user. */
  assignee?: string | undefined;
  /** Local tracker board directory (e.g. `.symphony/local`). Used when `kind === "local"`. */
  path?: string | undefined;
  /**
   * Local tracker issue-id prefix (e.g. `"BOARD-"`, `"XXX-"`). Issue files are `<prefix><n>.md`
   * and new ids are minted with this prefix. Defaults to `"BOARD-"`. Used when `kind === "local"`.
   */
  idPrefix?: string | undefined;
  /** Tracker state names considered eligible for dispatch (case-insensitive match). */
  activeStates: string[];
  /** Tracker state names that mark an issue as finished; running agents on these issues are stopped and their workspaces cleaned up. */
  terminalStates: string[];
  dispatch: DispatchSettings;
}

/**
 * Where agent runs execute. With no hosts configured, runs happen on the local machine;
 * with hosts configured, work is sharded over SSH onto remote workers.
 */
export interface WorkerSettings {
  /**
   * SSH destinations in standard OpenSSH form, e.g. `host`, `user@host`, `user@host:2222`,
   * or any `Host` alias resolved via `~/.ssh/config` (or `$SYMPHONY_SSH_CONFIG`).
   * Empty list means runs happen locally.
   */
  sshHosts: string[];
  /** Timeout (ms) for each individual SSH command used in worker setup, execution, and cleanup. */
  sshTimeoutMs: number;
  /**
   * Per-host cap on concurrent agent runs. When every host is at capacity, dispatch waits
   * instead of running locally. Undefined means the global {@link AgentSettings.maxConcurrentAgents} applies per host.
   */
  maxConcurrentAgentsPerHost?: number | undefined;
}

/**
 * Global scheduling knobs shared by every agent backend (independent of which executor runs).
 */
export interface AgentSettings {
  /** Default backend name to launch (e.g. `"codex"`, `"claude"`); must key into {@link Settings.agents}. */
  kind: AgentKind;
  /** Upper bound on concurrent agent runs across the whole instance. */
  maxConcurrentAgents: number;
  /** Maximum back-to-back turns a single worker session may run before exiting and yielding. */
  maxTurns: number;
  /** Cap (ms) on exponential retry backoff between attempts on the same issue. */
  maxRetryBackoffMs: number;
  /**
   * Default number of independent parallel slots dispatched per issue.
   * Overridden per-issue by an `ensemble:<n>` label.
   */
  ensembleSize: number;
}

/**
 * Agent record selecting the Agent Client Protocol (ACP) executor, which drives an external
 * bridge subprocess (e.g. Claude Code) over stdio using the ACP JSON-RPC schema.
 */
export interface AgentConfig {
  executor: "acp";
  /** Shell command launched per session (run via `bash -lc` in the workspace, or over SSH on remote workers). Also determines the provider config format: `claude-agent-acp` → `.claude/settings.local.json`, `codex-acp` → `.codex/config.toml`. */
  bridgeCommand: string;
  /** Free-form provider configuration written to the workspace before launching the bridge. The file path and format are derived from {@link bridgeCommand}. */
  providerConfig?: Record<string, unknown> | undefined;
  /** Hard limit (ms) on a single ACP turn before it is force-cancelled. */
  turnTimeoutMs: number;
  /** Inactivity window (ms) after which a session with no agent events is treated as stalled and aborted. `<= 0` disables stall detection. */
  stallTimeoutMs: number;
  /** When true, launch the bridge with only the MCP servers Symphony injected (no user-side MCP config). */
  strictMcpConfig?: boolean | undefined;
}

/**
 * Legacy top-level codex configuration section. Fields `turnTimeoutMs` and `stallTimeoutMs`
 * feed defaults into the `agents.codex` AgentConfig record. Remaining fields are retained
 * for backward compatibility with existing workflow YAML files but are not consumed at runtime.
 */
export interface CodexSettings {
  /** Shell command launched per session; invoked via `bash -lc` in the workspace directory. */
  command: string;
  /**
   * Codex `AskForApproval` value. Either a named policy string (e.g. `"never"`, `"on-request"`)
   * or a structured policy map.
   */
  approvalPolicy: CodexApprovalPolicyName | Record<string, unknown>;
  /** Codex `SandboxMode` value applied to the whole thread, e.g. `"workspace-write"`, `"read-only"`, `"danger-full-access"`. */
  threadSandbox: CodexSandboxMode;
  /**
   * Optional Codex `SandboxPolicy` override applied per turn. `null` falls back to a workspace-write
   * policy scoped to the workspace directory with no network access.
   */
  turnSandboxPolicy: Record<string, unknown> | null;
  /** Hard limit (ms) on a single Codex turn before it is treated as timed out. */
  turnTimeoutMs: number;
  /** Per-request read timeout (ms). Retained for config compatibility; not consumed at runtime. */
  readTimeoutMs: number;
  /** Inactivity window (ms) before a session with no events is force-aborted as stalled. `<= 0` disables stall detection. */
  stallTimeoutMs: number;
  /** Reasoning effort/summary configuration passed to `turn/start`. */
  reasoning: CodexReasoning | null;
}

export interface CodexReasoning {
  /** Summary detail level returned in reasoning items (e.g. `"concise"`, `"detailed"`, `"auto"`). */
  summary: "concise" | "detailed" | "auto";
}

/**
 * Runtime knobs for the Claude Code backend, driven via an ACP bridge subprocess.
 * Mirrored into the `claude` entry of {@link Settings.agents} as an {@link AgentConfig}.
 */
export interface ClaudeSettings {
  /** Shell command for the Claude Code ACP bridge; invoked via `bash -lc` in the workspace. */
  command: string;
  /** Hard limit (ms) on a single Claude turn before it is force-cancelled. */
  turnTimeoutMs: number;
  /** Inactivity window (ms) before a stalled session is aborted. `<= 0` disables stall detection. */
  stallTimeoutMs: number;
  /** When true, launch Claude with only Symphony's injected MCP servers (ignore user MCP config). */
  strictMcpConfig: boolean;
  /** Provider-specific settings written to `.claude/settings.local.json` in the workspace. */
  providerConfig?: Record<string, unknown> | undefined;
}

/**
 * Operator-facing dashboard and refresh cadence. Must not influence orchestrator correctness.
 */
export interface ObservabilitySettings {
  dashboardEnabled: boolean;
  /** How often (ms) status snapshots are refreshed from the orchestrator. */
  refreshMs: number;
  /** Minimum interval (ms) between successive UI redraws; throttles render-side work. */
  renderIntervalMs: number;
}

/**
 * Bind address for the optional HTTP observability/control server.
 */
export interface ServerSettings {
  /** Interface to bind on. Defaults to loopback to keep the API local-only unless explicitly opened up. */
  host: string;
  /**
   * TCP port to bind. Undefined disables the server unless the active agent backend requires it
   * (e.g. Claude, which needs the MCP endpoint). `0` requests an ephemeral local port.
   */
  port?: number | undefined;
  /** Directory containing JSONL trace files (same directory TraceEmitter writes to). */
  traceDir?: string | undefined;
  /** Built frontend assets directory (override for dashboard SPA). */
  staticDir?: string | undefined;
}

/**
 * Where structured runtime logs are written. The path is a stable symlink pointed at the
 * current rolling segment; older segments live next to it.
 */
export interface LoggingSettings {
  logFile: string;
}

/**
 * Shell hooks that run at well-defined points in the workspace and run lifecycle.
 * Each hook executes via `bash -lc` with the workspace as cwd, locally or over SSH on a worker.
 */
export interface HooksSettings {
  /**
   * Runs once, immediately after a workspace directory is freshly created.
   * Failure or timeout aborts workspace creation.
   */
  afterCreate?: string | null | undefined;
  /**
   * Runs before each agent attempt, after workspace preparation and before the agent process launches.
   * Failure aborts the attempt.
   */
  beforeRun?: string | null | undefined;
  /**
   * Runs after every agent attempt regardless of outcome, as long as the workspace still exists.
   * Failure is logged and ignored.
   */
  afterRun?: string | null | undefined;
  /**
   * Runs immediately before a workspace directory is deleted, if it still exists.
   * Failure is logged but does not block cleanup.
   */
  beforeRemove?: string | null | undefined;
  /** Per-hook execution timeout (ms) applied to all four hooks above. */
  timeoutMs: number;
}

/**
 * Root directory under which per-issue workspace folders are created.
 * Each issue becomes `<root>/<safe-identifier>/`, with ensemble slots appended as `/<slotIndex>`.
 */
export interface WorkspaceSettings {
  /** Resolved local filesystem path with `~` and `$VAR` already expanded; what local code touches. */
  root: string;
  /**
   * Unexpanded form of `root` (e.g. `"~/work"` or `"$HOME/work"`) preserved for use on remote workers,
   * where home-directory and env-var expansion must happen on the worker host, not locally.
   */
  rootExpression?: string | undefined;
  /**
   * Controls whether each agent run gets its own `<root>/<safe-identifier>` subfolder
   * (`"per-agent"`, the default) or all runs share `root` directly (`"none"`). Selected via the
   * `workspace.isolation` config key. With `"none"`, session resumption is disabled and the
   * shared folder is never auto-removed; intended for high-touchpoint setups where co-located
   * agents are desired.
   */
  isolation: "per-agent" | "none";
}

/**
 * Root configuration for a Symphony runtime instance. Built from the YAML front matter of a
 * workflow file plus environment-variable fallbacks, then held immutable for the lifetime of
 * the process. Every subsystem reads its slice from here. State-specific tweaks live in
 * `statusOverrides` and are layered on top per issue.
 */
export interface Settings {
  tracker: TrackerSettings;
  /** Cadence at which the tracker is polled for candidate issues, in milliseconds. */
  polling: { intervalMs: number };
  workspace: WorkspaceSettings;
  worker: WorkerSettings;
  hooks: HooksSettings;
  agent: AgentSettings;
  /**
   * Per-kind executor configuration keyed by agent kind (the same string used as
   * {@link AgentSettings.kind}). When an issue is dispatched to kind `K`, `agents[K]` is the
   * source of truth for how to run the executor; the top-level `codex` / `claude` blocks are
   * kept in sync for those two well-known kinds and act as convenience views.
   */
  agents: Record<string, AgentConfig>;
  codex: CodexSettings;
  claude: ClaudeSettings;
  observability: ObservabilitySettings;
  server: ServerSettings;
  logging: LoggingSettings;
  /**
   * Partial settings layered on top of the base config while an issue sits in a given tracker
   * state. Keys are normalized state names (trimmed, lowercased, e.g. `"in progress"`); a
   * matching entry's `agent` / `codex` / `claude` fragments are merged over the defaults for
   * the duration of that issue's stay in the state.
   */
  statusOverrides: Map<string, PartialRuntimeSettings>;
}

/**
 * Sparse overlay applied to a base {@link Settings} to produce the effective config for a
 * single issue. Resolved per state transition: the issue's current tracker state is looked up
 * in {@link Settings.statusOverrides}, and any present fragments are merged over the defaults
 * before the next dispatch decision or agent turn.
 */
export interface PartialRuntimeSettings {
  agent?: Partial<AgentSettings> | undefined;
  codex?: Partial<CodexSettings> | undefined;
  claude?: Partial<ClaudeSettings> | undefined;
}

/**
 * Parsed contents of a workflow file - a Markdown document with YAML front matter delimited
 * by `---` lines. The front matter becomes `config` (and is normalized into `settings`); the
 * body becomes `promptTemplate`.
 */
export interface WorkflowDefinition {
  /** Absolute path of the workflow file on disk. */
  path: string;
  /** Raw YAML front matter as a plain object, before normalization into `settings`. */
  config: Record<string, unknown>;
  /**
   * Liquid template (liquidjs) rendered into the first prompt sent to the agent. Receives an
   * `issue` object, an `attempt` number for retries, and an `ensemble` context describing the
   * slot index and size. Empty bodies fall back to a built-in default.
   */
  promptTemplate: string;
  /** Normalized, validated runtime settings derived from `config` plus env. */
  settings: Settings;
}

/**
 * Minimum interface the runtime needs from any issue tracker backend. Lets the in-process
 * memory tracker stand in for the real Linear-backed client without further coupling.
 */
export interface RuntimeTrackerClient {
  /**
   * Returns issues currently eligible for dispatch: those whose state is in
   * {@link TrackerSettings.activeStates}, filtered by the configured assignee where the backend
   * supports it. Downstream dispatch rules (routing labels, blockers, concurrency caps) are
   * applied by the runtime, not here.
   */
  fetchCandidateIssues(): Promise<Issue[]>;
  /** Re-fetches specific issues by tracker id, preserving the requested order. */
  fetchIssuesByIds(ids: string[]): Promise<Issue[]>;
  /**
   * Lists issues currently in any of the given states. Optional because it is only exercised
   * by best-effort flows (notably terminal-state workspace cleanup at startup); backends that
   * cannot answer state queries cheaply may omit it and the caller will skip those flows.
   */
  fetchIssuesByStates?(states: string[]): Promise<Issue[]>;
}

/**
 * Per-slot ensemble information injected into the Liquid prompt template as `ensemble`.
 * Field names are snake_case because they're exposed directly to template authors.
 */
export interface EnsembleContext {
  /** True when more than one slot is running for the same issue. */
  enabled: boolean;
  /** Zero-based index of this slot within the ensemble; range is `[0, size)`. */
  slot_index: number;
  /** Total number of parallel slots for the issue; at least 1. */
  size: number;
}

/**
 * Scheduled retry or continuation for an issue that just finished a run.
 * Held in the orchestrator until the monotonic deadline elapses, then the issue becomes dispatchable again.
 */
export interface RetryEntry {
  issueId: string;
  identifier: string;
  /** 1-based attempt counter; bumped each time a failure retry is recorded, reset to 1 for continuation retries. */
  attempt: number;
  /** Monotonic clock deadline (ms) — drives timer scheduling; immune to wall-clock adjustments. */
  monotonicDeadlineMs: number;
  /** Wall-clock estimate (ISO-8601) for display/serialization only. */
  dueAtIso: string;
  /** Last error message, when the previous run failed. */
  error?: string | undefined;
  /** Slot this retry prefers to reclaim so ensemble slots stay stable across attempts. */
  slotIndex?: number | undefined;
  workerHost?: string | null | undefined;
  workspacePath?: string | null | undefined;
}

/**
 * Why an otherwise eligible issue was held back from dispatch this tick.
 * - `global_concurrency_cap`: total running agents reached {@link AgentSettings.maxConcurrentAgents}.
 * - `local_concurrency_cap`: per-state cap from {@link Settings.statusOverrides} was reached.
 * - `worker_host_capacity`: every configured SSH worker host is at {@link WorkerSettings.maxConcurrentAgentsPerHost}.
 */
export type DispatchBlockReason =
  | "global_concurrency_cap"
  | "local_concurrency_cap"
  | "worker_host_capacity";

/**
 * Record of an issue that was skipped during a dispatch tick along with why.
 * Surfaced to operators (TUI, HTTP snapshot) so capacity pressure is visible; rebuilt each tick.
 */
export interface DispatchBlockEntry {
  issueId: string;
  identifier: string;
  /** Snapshot of {@link Issue.state} at the time the dispatch attempt was blocked. */
  state: string;
  reason: DispatchBlockReason;
  workerHost?: string | null | undefined;
}

/**
 * Cumulative token and runtime totals, either for a single run or aggregated across all runs.
 * Token counters are monotonic; runtime is accumulated when a run ends.
 */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Wall-clock runtime accumulated in seconds (note: unlike timeout settings which use ms). */
  secondsRunning: number;
}

/**
 * Live state of one agent slot currently executing an issue. Mutated as agent updates stream in.
 */
export interface RunningEntry {
  issue: Issue;
  identifier: string;
  /** Zero-based slot within the ensemble; always less than `ensembleSize`. */
  slotIndex: number;
  /** Resolved ensemble size for this run; from the `ensemble:<n>` label or {@link AgentSettings.ensembleSize}. */
  ensembleSize: number;
  /** Backend selected for this run (resolved against per-state setting overrides at claim time). */
  agentKind: AgentKind;
  /** SSH host the agent runs on; `null` for local execution. */
  workerHost?: string | null | undefined;
  /** Absolute workspace path on the worker; set once the executor emits `workspace_prepared`. */
  workspacePath?: string | null | undefined;
  /** Provider session id reported by the executor (Codex/Claude side). */
  sessionId?: string | null | undefined;
  /** Token used to resume this session on subsequent runs; persisted to the workspace resume state file. */
  resumeId?: string | null | undefined;
  /** OS process id of the agent child process, as a string; `null` if not yet spawned or unavailable. */
  executorPid?: string | null | undefined;
  /** Number of completed turns; incremented on each `turn_completed` update. */
  turnCount: number;
  startedAt: Date;
  /** Discriminator of the most recent {@link AgentUpdate} (see {@link AgentUpdate.type}). */
  lastAgentEvent?: AgentUpdateType | null | undefined;
  lastAgentMessage?: unknown;
  lastAgentTimestamp?: Date | null | undefined;
  /** Monotonic per-run totals, kept in sync as usage updates arrive. */
  usageTotals: UsageTotals;
  /** Highwater mark of input tokens already folded into the orchestrator-wide totals; used to compute deltas. */
  lastReportedInputTokens: number;
  /** Highwater mark of output tokens already folded into the orchestrator-wide totals. */
  lastReportedOutputTokens: number;
  /** Highwater mark of total tokens already folded into the orchestrator-wide totals. */
  lastReportedTotalTokens: number;
  /** 1-based attempt number when this run is a retry; `null` for the first attempt. */
  retryAttempt: number | null;
}

/**
 * Common fields present on every agent update.
 */
export interface AgentUpdateBase {
  sessionUpdate?: unknown;
  workspacePath?: string | null | undefined;
  sessionId?: string | null | undefined;
  resumeId?: string | null | undefined;
  executorPid?: string | null | undefined;
  timestamp?: Date | undefined;
  message?: unknown;
  usage?: Partial<UsageTotals> | undefined;
  rateLimits?: unknown;
}

// --- Typed message variants per AgentUpdate.type ---

export interface AgentSessionNotificationUpdate extends AgentUpdateBase {
  type: "session_notification";
  message: SessionNotification;
}

export type StringMessageUpdateType =
  | "stderr"
  | "process_exit"
  | "resume_state_warning"
  | "session_started"
  | "workspace_prepared"
  | "rate_limit"
  | "turn_input_required"
  | "tool_input_auto_answered"
  | "malformed";

export interface StringMessageUpdate extends AgentUpdateBase {
  type: StringMessageUpdateType;
  message: string;
}

export interface SessionReplaySuppressedUpdate extends AgentUpdateBase {
  type: "session_replay_suppressed";
  message: { replayedUpdateCount: number };
}

export interface TurnStartedUpdate extends AgentUpdateBase {
  type: "turn_started";
  message: { prompt: Array<{ type: string; text: string }> };
}
export interface TurnCompletedUpdate extends AgentUpdateBase {
  type: "turn_completed";
  message: { response: PromptResponse };
  usage?: Partial<UsageTotals>;
}
export interface TurnCancelledUpdate extends AgentUpdateBase {
  type: "turn_cancelled";
  message: { response: PromptResponse };
  usage?: Partial<UsageTotals>;
}
export interface TurnFailedUpdate extends AgentUpdateBase {
  type: "turn_failed";
  message: string | { response: PromptResponse };
  usage?: Partial<UsageTotals>;
}

export interface ApprovalRequiredUpdate extends AgentUpdateBase {
  type: "approval_required";
  message: { request: RequestPermissionRequest; selected: PermissionOption | null };
}
export interface ApprovalAutoApprovedUpdate extends AgentUpdateBase {
  type: "approval_auto_approved";
  message: { request: RequestPermissionRequest; selected: PermissionOption };
}

export interface FsWriteUpdate extends AgentUpdateBase {
  type: "fs_write";
  message: { path: string };
}

/**
 * Single event from an agent executor: session lifecycle, turn progress, usage, errors, or raw notifications.
 * Streamed via the `onUpdate` callback and also returned in batches from {@link AgentExecutor.runTurn}.
 *
 * Discriminated on `type`.
 */
export type AgentUpdate =
  | AgentSessionNotificationUpdate
  | StringMessageUpdate
  | SessionReplaySuppressedUpdate
  | TurnStartedUpdate
  | TurnCompletedUpdate
  | TurnCancelledUpdate
  | TurnFailedUpdate
  | ApprovalRequiredUpdate
  | ApprovalAutoApprovedUpdate
  | FsWriteUpdate;

// Derived from the AgentUpdate discriminated union — no separate source of truth.
export type AgentUpdateType = AgentUpdate["type"];

// `satisfies` rejects any array entry that isn't in AgentUpdateType (catches typos/stale entries).
export const AGENT_UPDATE_TYPES = [
  "workspace_prepared",
  "session_started",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "turn_input_required",
  "approval_required",
  "approval_auto_approved",
  "tool_input_auto_answered",
  "rate_limit",
  "stderr",
  "malformed",
  "process_exit",
  "resume_state_warning",
  "session_replay_suppressed",
  "fs_write",
  "session_notification",
] as const satisfies readonly AgentUpdateType[];

// Fails to compile if a union member is missing from the array (catches forgotten entries).
type _AllAgentTypesPresent = [
  Exclude<AgentUpdateType, (typeof AGENT_UPDATE_TYPES)[number]>,
] extends [never]
  ? true
  : never;
const _allAgentTypesPresent: _AllAgentTypesPresent = true;

type AgentUpdateMessage<K extends AgentUpdateType> = K extends "session_notification"
  ? SessionNotification
  : K extends StringMessageUpdateType
    ? string
    : Extract<AgentUpdate, { type: K }> extends { message: infer M }
      ? M
      : undefined;

/**
 * Wire format of a single JSONL trace line as written by TraceEmitter.
 * Mapped union: switching on `type` narrows `message` to the variant's specific shape.
 */
export type TraceEvent = {
  [K in AgentUpdateType]: {
    type: K;
    issueId: string;
    issueIdentifier: string;
    timestamp: string | null;
    message: AgentUpdateMessage<K> | null;
    usage: Partial<UsageTotals> | null;
    workspacePath: string | null;
    sessionId: string | null;
    executorPid: string | null;
  };
}[AgentUpdateType];

/**
 * Handle to a started agent process, returned by {@link AgentExecutor.startSession}.
 * The same instance is passed back into `runTurn` for each prompt and closed via `stop`.
 */
export interface AgentSession {
  agentKind: AgentKind;
  /** Provider session id; populated once the executor receives it from the backend. */
  sessionId?: string | null | undefined;
  /** Token persisted to the workspace so a later run can resume this session. */
  resumeId?: string | null | undefined;
  /** OS pid of the agent child as a string; `null` if not applicable. */
  executorPid?: string | null | undefined;
  /** Closes the session and tears down the underlying process; must be safe to call from a `finally` block. */
  stop(): Promise<void>;
}

/**
 * Backend driver for a specific agent kind - knows how to spawn the agent process and run turns against it.
 */
export interface AgentExecutor {
  /** Agent kind this executor serves; matches {@link AgentSettings.kind}. */
  kind: AgentKind;
  /**
   * Spawns the agent process and prepares it for the first turn.
   * `resumeId` reuses a prior session when present; `onUpdate` receives every event as it arrives.
   */
  startSession(input: {
    workspace: string;
    workerHost?: string | null | undefined;
    issue?: Issue;
    settings: Settings;
    resumeId?: string | null;
    onUpdate?: (update: AgentUpdate) => void;
  }): Promise<AgentSession>;
  /** Sends one prompt to the session and resolves with the updates produced during that turn. */
  runTurn(session: AgentSession, prompt: string, issue?: Issue): Promise<AgentUpdate[]>;
}
