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

export function normalizeHttpBindHost(host: string): string {
  return host.trim() === "" ? "127.0.0.1" : host;
}

export function httpUrlHost(host: string): string {
  const normalized = normalizeHttpBindHost(host);
  if (normalized === "0.0.0.0" || normalized === "::") return "127.0.0.1";
  return normalized.includes(":") && !normalized.startsWith("[") ? `[${normalized}]` : normalized;
}

// --- Session protocol types ---

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

// --- Domain types ---

/**
 * Identifies a configured agent backend by name (e.g. `"codex"`, `"claude"`).
 * Matches a key in {@link Settings.agents} and is open-ended because operators define their own.
 */
export type AgentKind = string;

/**
 * Identifies a tracker backend by name (e.g. `"linear"`, `"local"`, `"memory"`).
 * Open-ended: the set of supported kinds is whatever the composition root registered
 * in its tracker provider registry, not a closed union owned by the domain.
 */
export type TrackerKind = string;

/**
 * Selector for the worker driver backend; keys into the worker-driver registry the
 * composition root assembles, so the set of supported kinds is open-ended
 * (an unregistered kind fails loud at pool construction).
 */
export type WorkerDriverKind = string;

export const ISSUE_STATE_TYPES = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "triage",
] as const;

export type IssueStateType = (typeof ISSUE_STATE_TYPES)[number];

// --- Leaf helpers ---

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DIAGNOSTIC_REDACTION = "[REDACTED]";
const MIN_REGISTERED_SECRET_LENGTH = 3;
const OP_REFERENCE_PATTERN = /op:\/\/[^\s"'`),\]}]+/g;
const BEARER_AUTH_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=%-]+/gi;
const BASIC_AUTH_PATTERN = /\bBasic\s+[A-Za-z0-9._~+/=%-]+/gi;
const URL_AUTH_PATTERN = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^@\s/?#]+)@/g;
const SECRET_ASSIGNMENT_PATTERN =
  /((?:["']?\b(?:api[_-]?key|apiKey|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|secret|token)\b["']?)\s*[:=]\s*)(["']?)([^"'\s,}\]]+)/gi;
const DIAGNOSTIC_SECRET_KEY_PATTERN =
  /(?:api[_-]?key|apiKey|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|secret|token)/i;

const registeredDiagnosticSecrets = new Set<string>();
let sortedDiagnosticSecrets: string[] | null = null;

export function isDiagnosticSecretKey(key: string): boolean {
  return DIAGNOSTIC_SECRET_KEY_PATTERN.test(key);
}

export function registerDiagnosticSecret(value: string | null | undefined): void {
  const secret = value?.trim();
  if (!secret || secret.length < MIN_REGISTERED_SECRET_LENGTH) return;
  if (secret === DIAGNOSTIC_REDACTION || secret.startsWith("op://")) return;
  if (registeredDiagnosticSecrets.has(secret)) return;
  registeredDiagnosticSecrets.add(secret);
  sortedDiagnosticSecrets = null;
}

export function redactDiagnosticText(value: string): string {
  let redacted = value;
  for (const secret of registeredSecretsByLength()) {
    redacted = redacted.split(secret).join(DIAGNOSTIC_REDACTION);
  }
  return redacted
    .replace(BEARER_AUTH_PATTERN, `Bearer ${DIAGNOSTIC_REDACTION}`)
    .replace(BASIC_AUTH_PATTERN, `Basic ${DIAGNOSTIC_REDACTION}`)
    .replace(URL_AUTH_PATTERN, `$1${DIAGNOSTIC_REDACTION}@`)
    // The value group stops before the closing quote, so that quote survives in
    // the output and must not be re-emitted here.
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1$2${DIAGNOSTIC_REDACTION}`)
    .replace(OP_REFERENCE_PATTERN, DIAGNOSTIC_REDACTION);
}

export function redactDiagnosticValue<T>(value: T): T {
  return redactDiagnosticUnknown(value, new WeakMap()) as T;
}

function registeredSecretsByLength(): string[] {
  sortedDiagnosticSecrets ??= [...registeredDiagnosticSecrets].sort(
    (left, right) => right.length - left.length,
  );
  return sortedDiagnosticSecrets;
}

// Maps each visited original to its redacted clone so repeated references (and
// cycles) resolve to the clone; returning the original here would leak it unredacted.
function redactDiagnosticUnknown(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return redactDiagnosticText(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(redactDiagnosticUnknown(item, seen));
    return clone;
  }
  if (!isPlainDiagnosticRecord(value)) return value;
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) {
    // Define an own data property rather than assigning: JSON-parsed payloads can
    // carry an own "__proto__" key, and plain assignment would hit the
    // Object.prototype.__proto__ setter (dropping the key and mutating the
    // clone's prototype) instead of copying it.
    Object.defineProperty(clone, key, {
      value: redactDiagnosticUnknown(item, seen),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return clone;
}

function isPlainDiagnosticRecord(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isOneOf<const Values extends readonly string[]>(
  value: string,
  values: Values,
): value is Values[number] {
  return (values as readonly string[]).includes(value);
}

export function normalizeStateType(value: string | null | undefined): IssueStateType | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  return isOneOf(normalized, ISSUE_STATE_TYPES) ? normalized : null;
}

export function durationMs(startedAt: string, endedAt: string): number {
  return Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
}

// --- Clock ---

export interface ClockPort {
  now(): Date;
  monotonicMs(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface TimerHandle {
  unref?: (() => void) | undefined;
}

export const systemClock: ClockPort = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const PRIORITY_VALUES = [1, 2, 3, 4] as const;

export type Priority = (typeof PRIORITY_VALUES)[number];

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
 * Rules for which tracker issues this Lorenz instance picks up based on label routing.
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
   * and the remainder (trimmed, lowercased) used as the route name; e.g. `"Lorenz:"` turns
   * `Lorenz:backend` into route `backend`.
   */
  routeLabelPrefix: string;
}

/**
 * Connection and filtering rules for the issue tracker that feeds work into this instance.
 *
 * Only fields every backend shares live here. Provider-specific keys from the selected
 * tracker bundle (e.g. Linear's `project_slug`, the local board's `path`) are normalized
 * and validated by the registered tracker provider and carried opaquely in {@link options}.
 */
export interface TrackerSettings {
  /** Backend adapter selector. `"memory"` is an in-process fixture used for tests. */
  kind?: TrackerKind | undefined;
  /** Tracker API endpoint; when unset, the provider's default endpoint applies. */
  endpoint?: string | undefined;
  /** Tracker credential; supports `$VAR` and `op://` references plus provider env fallbacks. */
  apiKey?: string | undefined;
  /** Tracker assignee identity (or `$VAR`) used to scope candidate queries to one user. */
  assignee?: string | undefined;
  /** Tracker state names considered eligible for dispatch (case-insensitive match). */
  activeStates: string[];
  /** Tracker state names that mark an issue as finished; running agents on these issues are stopped and their workspaces cleaned up. */
  terminalStates: string[];
  dispatch: DispatchSettings;
  /**
   * Provider-specific settings, normalized and validated by the tracker provider registered
   * for {@link kind}. Read through the provider package's typed accessor (e.g.
   * `linearTrackerOptions(settings)`), never by key from core code.
   */
  options: Record<string, unknown>;
}

/**
 * Configuration for the embedded warm worker/executor worker pool, the single dispatch path. When
 * `enabled`, the runtime leases a worker per run (producing the run's `workerHost`) through the
 * configured driver. The `local` driver yields an empty `workerHost` so dispatch executes on acp's
 * own in-process MCP endpoint; the `static-ssh` driver leases from the
 * {@link WorkerSettings.sshHosts} static-host model. Durations are milliseconds; spend caps are
 * seconds (matching {@link UsageTotals.secondsRunning}).
 */
export interface WorkerPoolSettings {
  /**
   * Internal liveness switch, not an operator-facing config key. A parsed config always produces
   * `enabled: true`; the reload-drain is the only writer that flips it to `false`, to drain a
   * removed pool to zero (`reconcile` then skips the driver swap and tears the workers down). When
   * `false` the pool is constructed-but-inert (or not constructed at all) and `governs()` falls
   * through to local/static.
   */
  enabled: boolean;
  /** Worker driver backend that provisions, probes, and destroys workers. */
  driver: WorkerDriverKind;
  /** Floor on warm inventory the reaper keeps alive (never reaped below this count). */
  min: number;
  /** Ceiling on total workers the pool may provision at once. */
  max: number;
  /** Target number of pre-warmed idle workers the reaper tops up toward, within budget. */
  warm: number;
  /**
   * Concurrent run slots a single machine may serve. Defaults to `1`. Values `> 1` are
   * safe once each RunSlot owns its own MCP endpoint (token + local-server + tunnel); `> 1`
   * is gated by a runtime capability + an explicit co-residence opt-in.
   *
   * This is the single canonical own field. {@link WorkerPoolSettings.maxInFlight} is a derived,
   * read-only getter over this value (installed by {@link withDerivedMaxInFlight}) so the two
   * can never drift: there is no second writable field a fixture could set independently.
   */
  slotsPerMachine: number;
  /**
   * @deprecated Read-only alias of {@link WorkerPoolSettings.slotsPerMachine}. Declared as a get
   * accessor (not a writable field) and installed by {@link withDerivedMaxInFlight}, so it always
   * mirrors `slotsPerMachine` and can never drift. Assigning it is a type error; write
   * `slotsPerMachine` instead.
   */
  get maxInFlight(): number;
  /** Hard lifetime (ms) of a worker before it is recycled, even while idle. */
  ttlMs: number;
  /** Idle window (ms) after which a warm worker above `min` is reaped. */
  idleReapMs: number;
  /** How long (ms) `acquire` blocks for capacity before returning `no_capacity:acquire_timeout`. */
  acquireTimeoutMs: number;
  /** Cadence (ms) of the single serial reaper tick. */
  reapIntervalMs: number;
  /** Heartbeat staleness threshold (ms) past which a lease whose run is gone is treated as orphaned. */
  staleHeartbeatMs: number;
  /** Deadline (ms) `drain` waits for in-flight leases before force-destroying all workers on shutdown. */
  drainDeadlineMs: number;
  /** Optional fairness cap on how many workers one issue's slots may hold, so an ensemble cannot monopolize the pool. */
  maxWorkersPerIssue?: number | undefined;
  /**
   * Explicit operator opt-in for co-residence (multiple run slots sharing one machine). Required
   * alongside the runtime per-run-endpoint capability before {@link WorkerPoolSettings.slotsPerMachine}
   * may exceed `1`: a single poisoned worker fails every co-resident run on recycle, so widening the
   * blast radius is an explicit operator tradeoff, not just a capability. Absent (the default) keeps
   * the single-tenant layout. Enforced by the post-construction gate in the CLI, never here.
   */
  coResidence?: boolean | undefined;
  /**
   * Optional ceiling on concurrent per-run MCP tunnels (reverse `ssh -N` children / remote ports).
   * When the pool fans out N run slots per machine the tunnel count grows from `1/host` to `N/host`;
   * exhausting this ceiling surfaces as a typed `no_capacity` rather than an unhandled throw. Absent
   * lets the worker-host-pool derive a default from its remote-port range.
   */
  maxConcurrentTunnels?: number | undefined;
  /** Optional spend caps. Worker counts are absolute; worker-seconds are wall-clock seconds. */
  spend?:
    | {
        /** Maximum workers that may exist concurrently (independent of `max`). */
        maxConcurrentWorkers?: number;
        /** Maximum cumulative worker-seconds for the process lifetime. */
        maxWorkerSeconds?: number;
        /** Maximum worker-seconds per UTC day; persisted across restart via a `spend.json` sidecar. */
        dailyWorkerSeconds?: number;
      }
    | undefined;
  /**
   * Driver-specific options from the selected `workers.<name>` profile, passed through
   * un-normalized without the profile's `driver`. Example: `workers.static.ssh_hosts` becomes
   * `{ ssh_hosts: ["user@host:22"] }`.
   */
  driverOptions?: Record<string, unknown> | undefined;
}

/**
 * Shape callers construct: all of {@link WorkerPoolSettings} except the derived `maxInFlight`
 * getter, which {@link withDerivedMaxInFlight} installs. Use this for the literal you hand to
 * {@link withDerivedMaxInFlight} so you set `slotsPerMachine` only and never the derived alias.
 */
export type WorkerPoolSettingsInput = Omit<WorkerPoolSettings, "maxInFlight">;

/**
 * Installs the derived, read-only `maxInFlight` getter over `slotsPerMachine` so the two can
 * never drift. This is the single sanctioned constructor for {@link WorkerPoolSettings}: the input
 * carries `slotsPerMachine` as its only own field, and the returned object exposes `maxInFlight`
 * as an enumerable accessor that re-reads `slotsPerMachine` on every access (so it tracks any
 * later mutation of `slotsPerMachine` and can never hold a stale, drifted copy).
 *
 * Mutates `input` in place (and returns it) rather than allocating a wrapper, so the object stays
 * structurally a plain `WorkerPoolSettings` for callers that spread or snapshot it.
 *
 * Clone interaction (documented per task note): the accessor is defined `enumerable: true`, so a
 * shallow spread (`{ ...workerPool }`, as used by `cloneSettings`/`cloneWorkerPool`) or
 * `structuredClone` copies `maxInFlight` as a *plain data property* holding the current value -
 * it does not copy the getter. That is fine and stays drift-proof: the clone path is expected to
 * re-run `withDerivedMaxInFlight` on the cloned `slotsPerMachine` to re-install the accessor (the
 * config clone helper owns that). The derived value is identical either way because cloning copies
 * `slotsPerMachine` unchanged, so the byte-identity deep-equal-clone regression is unaffected.
 */
export function withDerivedMaxInFlight(input: WorkerPoolSettingsInput): WorkerPoolSettings {
  return Object.defineProperty(input, "maxInFlight", {
    get(this: WorkerPoolSettingsInput): number {
      return this.slotsPerMachine;
    },
    enumerable: true,
    configurable: true,
  }) as WorkerPoolSettings;
}

/**
 * Where agent runs execute. With no hosts configured, runs happen on the local machine;
 * with hosts configured, work is sharded over SSH onto remote workers.
 */
export interface WorkerSettings {
  /** Optional named worker profile selected from top-level `workers.<name>`. */
  kind?: string | undefined;
  /**
   * SSH destinations in standard OpenSSH form, e.g. `host`, `user@host`, `user@host:2222`,
   * or any `Host` alias resolved via `~/.ssh/config` (or `$LORENZ_SSH_CONFIG`).
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
  /**
   * Embedded worker-pool configuration; the single dispatch path. {@link parseConfig} always
   * populates it: an absent `worker_pool` with no hosts defaults to an enabled `local` pool
   * (slotsPerMachine=1, min=0/warm=0/max=1), and a non-empty {@link WorkerSettings.sshHosts} is
   * represented by an enabled `static-ssh` pool carrying the hosts in
   * {@link WorkerPoolSettings.driverOptions}. The field stays optional in the type so non-parse
   * constructors (tests, fixtures) may omit it.
   */
  workerPool?: WorkerPoolSettings | undefined;
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
  /**
   * Local skill directories overlaid into each prepared workspace before the agent process
   * starts. Entries are absolute paths resolved from workflow configuration; skills are
   * copied to `.lorenz/skills/` with a `.gitignore`. Mounted tool packs contribute their
   * bundled skills on top of this list at dispatch time.
   */
  skills: string[];
}

/**
 * Per-kind agent record: how to run sessions for one entry of {@link Settings.agents}.
 *
 * `executor` selects the runtime driver by name and is open-ended - the supported set is
 * whatever the composition root registered in its agent executor registry. Only fields every
 * executor shares live here; executor-specific keys of an `agents.<kind>` config record
 * (e.g. the ACP executor's `bridge_command`) are normalized and validated by the registered
 * executor provider and carried opaquely in {@link options}.
 */
export interface AgentConfig {
  /** Runtime driver selector (e.g. `"acp"`), resolved through the agent executor registry. */
  executor: string;
  /** Hard limit (ms) on a single agent turn before it is force-cancelled. */
  turnTimeoutMs: number;
  /** Inactivity window (ms) after which a session with no agent events is treated as stalled and aborted. `<= 0` disables stall detection. */
  stallTimeoutMs: number;
  /**
   * Executor-specific settings, normalized and validated by the executor provider registered
   * for {@link executor}. Read through the executor package's typed accessor (e.g.
   * `acpAgentOptions(config)`), never by key from core code.
   */
  options: Record<string, unknown>;
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
 * Root configuration for a Lorenz runtime instance. Built from the YAML front matter of a
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
   * single source of truth for how to run the executor. The top-level `codex:` / `claude:`
   * workflow sections are parse-time conveniences that merge into `agents.codex` /
   * `agents.claude`; they do not exist at runtime.
   */
  agents: Record<string, AgentConfig>;
  /**
   * Per-pack options from the workflow's `tools:` map, keyed by pack name. Runtime mounts the
   * dispatch tracker's declared default packs (for example Jira's `jira` pack) and any
   * additional packs named here. Each configured pack validates its own option bag.
   */
  toolOptions?: Record<string, Record<string, unknown>> | undefined;
  observability: ObservabilitySettings;
  server: ServerSettings;
  logging: LoggingSettings;
  /**
   * Partial settings layered on top of the base config while an issue sits in a given tracker
   * state. Keys are normalized state names (trimmed, lowercased, e.g. `"in progress"`); a
   * matching entry's `agent` scheduling fragment and per-kind `agents` record fragments are
   * merged over the defaults for the duration of that issue's stay in the state.
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
  /** Per-kind overrides merged into the matching {@link Settings.agents} records. */
  agents?: Record<string, Partial<AgentConfig>> | undefined;
}

export interface WorkflowContentStamp {
  mtimeMs: number;
  size: number;
  contentHash: string;
}

/**
 * Opaque parsed representation of a prompt template. Produced by workflow loading and
 * consumed by prompt rendering so callers can avoid reparsing the same template.
 */
export type ParsedPromptTemplate = unknown[];

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
  /** Parsed form of the effective prompt template, cached for prompt rendering. */
  parsedPromptTemplate?: ParsedPromptTemplate | undefined;
  /** Last observed file stamp used to skip unchanged reload work. */
  stamp?: WorkflowContentStamp | undefined;
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
  /**
   * Optional push capability: open a live change stream that invokes `onChange` whenever the
   * backend signals new or updated work, so the runtime can re-poll IMMEDIATELY instead of
   * waiting out `polling.intervalMs`. Backends that can only be pulled omit this and the runtime
   * relies on interval polling alone.
   *
   * The interval poll always stays active as a safety net, so `onChange` need not be exhaustive
   * or reliable: a missed signal is at worst recovered on the next interval, and the runtime
   * coalesces a burst of signals into a single poll. The returned {@link TrackerChangeStream} is
   * closed by the runtime on shutdown. Returning `null` means "no push available for this config"
   * (e.g. the credential that enables it is unset) - the runtime stays on interval polling without
   * treating it as an error.
   */
  watch?(onChange: () => void): TrackerChangeStream | null | Promise<TrackerChangeStream | null>;
}

/**
 * A live subscription opened by {@link RuntimeTrackerClient.watch}. The runtime owns its
 * lifecycle and calls {@link close} exactly once on shutdown; implementations must make close
 * idempotent and release any sockets/timers it holds.
 */
export interface TrackerChangeStream {
  close(): void | Promise<void>;
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
  issueUrl?: string | null | undefined;
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
  issueUrl?: string | null | undefined;
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

export type UsageTokenUpdate = Partial<
  Pick<UsageTotals, "inputTokens" | "outputTokens" | "totalTokens">
>;

export type UsageUpdateKind = "cumulative" | "delta";

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
  /** SSH host the agent runs on; `null` for local execution. Always concrete or null. */
  workerHost?: string | null | undefined;
  /** Absolute workspace path on the worker; set once the executor emits `workspace_prepared`. */
  workspacePath?: string | null | undefined;
  /** Provider session id reported by the executor (Codex/Claude side). */
  sessionId?: string | null | undefined;
  /** OS process id of the agent child process, as a string; `null` if not yet spawned or unavailable. */
  executorPid?: string | null | undefined;
  /** Number of completed turns; incremented on each `turn_completed` update. */
  turnCount: number;
  startedAt: Date;
  /** Discriminator of the most recent {@link AgentUpdate} (see {@link AgentUpdate.type}). */
  lastAgentEvent?: AgentUpdateType | null | undefined;
  lastAgentMessage?: unknown;
  lastAgentTimestamp?: Date | null | undefined;
  /** Monotonic count of tool-call start notifications seen during this run. */
  toolCallCount?: number | undefined;
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
  executorPid?: string | null | undefined;
  timestamp?: Date | undefined;
  message?: unknown;
  usage?: UsageTokenUpdate | undefined;
  /** Whether usage fields are cumulative session high-water marks or per-update deltas. */
  usageKind?: UsageUpdateKind | undefined;
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

export type WorkspaceHookName = "after_create" | "before_run" | "after_run" | "before_remove";
export type HookExecutionStatus = "started" | "completed" | "failed";

export interface HookExecutionMessage {
  status: HookExecutionStatus;
  command: string;
  cwd: string;
  hookName?: WorkspaceHookName | undefined;
  workerHost?: string | null | undefined;
  exitCode?: number | null | undefined;
  output?: string | undefined;
  outputTruncated?: boolean | undefined;
  error?: string | undefined;
  errorTruncated?: boolean | undefined;
}

export interface HookExecutionUpdate extends AgentUpdateBase {
  type: "hook_execution";
  message: HookExecutionMessage;
}

export interface TurnStartedUpdate extends AgentUpdateBase {
  type: "turn_started";
  message: { prompt: Array<{ type: string; text: string }> };
}
export interface TurnCompletedUpdate extends AgentUpdateBase {
  type: "turn_completed";
  message: { response: PromptResponse };
  usage?: UsageTokenUpdate;
}
export interface TurnCancelledUpdate extends AgentUpdateBase {
  type: "turn_cancelled";
  message: { response: PromptResponse };
  usage?: UsageTokenUpdate;
}
export interface TurnFailedUpdate extends AgentUpdateBase {
  type: "turn_failed";
  message: string | { response: PromptResponse };
  usage?: UsageTokenUpdate;
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
  | HookExecutionUpdate
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
  "fs_write",
  "hook_execution",
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
    usage: UsageTokenUpdate | null;
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
   * `onUpdate` receives every event as it arrives.
   */
  startSession(input: {
    workspace: string;
    workerHost?: string | null | undefined;
    issue?: Issue;
    settings: Settings;
    onUpdate?: (update: AgentUpdate) => void;
  }): Promise<AgentSession>;
  /** Sends one prompt to the session and resolves with the updates produced during that turn. */
  runTurn(session: AgentSession, prompt: string, issue?: Issue): Promise<AgentUpdate[]>;
}

// --- SDK module contracts ---

/** A required function hook an out-of-tree module must expose. */
export interface SdkRequiredFn {
  /** Property name to test for `typeof === "function"`. */
  readonly field: string;
  /** Signature shown in the error, e.g. `createClient(settings, context)`. */
  readonly signature: string;
  /** Article preceding the signature in the error: `"a"` or `"an"`. */
  readonly article: "a" | "an";
}

/** The per-axis text and shape an {@link makeSdkModuleContract} call varies on. */
export interface SdkModuleContractSpec {
  /** Error-code prefix; errors are `<prefix>_module_invalid`/`<prefix>_sdk_mismatch`. */
  readonly errorPrefix: string;
  /**
   * Module noun phrase in the non-object error, e.g. `a tracker provider module`;
   * the error appends ` object` to it.
   */
  readonly moduleNoun: string;
  /** Identity-field name the module must carry as a non-empty string. */
  readonly identityField: string;
  /** The `define...({ ... })` snippet shown in the non-object error's authoring hint. */
  readonly defineCall: string;
  /** Required function hooks, asserted in order after the identity check. */
  readonly requiredFns: readonly SdkRequiredFn[];
  /** SDK version this build speaks; a module declaring another version is rejected. */
  readonly sdkVersion: number;
}

/** A module carrying the `sdkVersion` an out-of-tree author declares. */
export interface SdkModule {
  readonly sdkVersion: number;
}

/** The assert + define pair {@link makeSdkModuleContract} returns for one axis. */
export interface SdkModuleContract<TModule extends SdkModule> {
  /**
   * Structural check + version handshake for a dynamically loaded module. `source`
   * names where the value came from (a module specifier, or the `define...` helper
   * at authoring time) so every error is actionable. Standalone (`this: void`), so
   * an SDK can re-export it directly under its public name.
   */
  readonly assertModule: (this: void, value: unknown, source: string) => asserts value is TModule;
  /**
   * Authoring sugar: shape-asserts at definition time (so a typo fails in the
   * author's tests, not the operator's daemon) and returns the module unchanged.
   * `helperName` names the wrapper for the assertion's `source`.
   */
  readonly defineModule: (this: void, module: TModule, helperName: string) => TModule;
}

/**
 * Builds the assert/define pair an SDK exposes for OUT-OF-TREE modules of one
 * extension axis. In-repo extensions register with the composition root (which
 * vouches for them); a dynamically imported module crosses a version boundary the
 * daemon cannot type-check, so the explicit `sdkVersion` handshake stands in for
 * the compiler. Every axis runs the identical 5-check sequence (object, identity,
 * required hooks, numeric version, version match) and differs only in {@link spec}.
 */
export function makeSdkModuleContract<TModule extends SdkModule>(
  spec: SdkModuleContractSpec,
): SdkModuleContract<TModule> {
  function assertModule(value: unknown, source: string): asserts value is TModule {
    if (!isRecord(value)) {
      throw new Error(
        `${spec.errorPrefix}_module_invalid: ${source} did not yield ${spec.moduleNoun} object ` +
          `(got ${value === null ? "null" : typeof value}); export ${spec.defineCall} ` +
          `as the default export or a named export`,
      );
    }
    const identity = value[spec.identityField];
    if (typeof identity !== "string" || identity.trim() === "") {
      throw new Error(
        `${spec.errorPrefix}_module_invalid: ${source} is missing a non-empty string \`${spec.identityField}\``,
      );
    }
    for (const fn of spec.requiredFns) {
      if (typeof value[fn.field] !== "function") {
        throw new Error(
          `${spec.errorPrefix}_module_invalid: ${source} (${spec.identityField}: ${identity}) ` +
            `is missing ${fn.article} \`${fn.signature}\` function`,
        );
      }
    }
    if (typeof value["sdkVersion"] !== "number") {
      throw new Error(
        `${spec.errorPrefix}_module_invalid: ${source} (${spec.identityField}: ${identity}) is missing a numeric \`sdkVersion\` ` +
          `(declare sdkVersion: ${spec.sdkVersion})`,
      );
    }
    if (value["sdkVersion"] !== spec.sdkVersion) {
      throw new Error(
        `${spec.errorPrefix}_sdk_mismatch: ${source} targets SDK v${value["sdkVersion"]}, ` +
          `this build supports v${spec.sdkVersion}`,
      );
    }
  }

  function defineModule(module: TModule, helperName: string): TModule {
    assertModule(module, helperName);
    return module;
  }

  return { assertModule, defineModule };
}
