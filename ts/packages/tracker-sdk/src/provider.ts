import type { Issue, RuntimeTrackerClient, Settings } from "@symphony/domain";

/** Ambient dependencies handed to provider hooks that must not touch process globals directly. */
export interface TrackerContext {
  env: NodeJS.ProcessEnv;
  /**
   * Config-layer secret resolution (`$VAR` and `op://` references, with an optional env-var
   * fallback) for provider option values. Present when invoked by the config parser.
   */
  resolveSecret?: (value: string | undefined, fallbackEnvVar?: string) => string | undefined;
}

/** Dependencies for building the normalized tool operations of one tracker. */
export interface TrackerOpsContext {
  fetchImpl: typeof fetch;
}

/** Input accepted by {@link TrackerToolOps.createIssue}. */
export interface TrackerCreateIssueInput {
  title: string;
  body?: string | undefined;
  status?: string | undefined;
}

/** Natively projected query payload returned by {@link TrackerToolOps.queryRows}. */
export interface TrackerQueryResult {
  rows: Array<Record<string, unknown>>;
  total: number;
  skipped?: unknown[] | undefined;
}

/**
 * Normalized issue operations backing the provider-neutral `tracker_*` tool pack. Every
 * member is optional: a missing member makes the corresponding tool report itself as
 * unsupported for this tracker instead of failing mid-call.
 *
 * Backends that filter and project natively (e.g. the local board's query DSL) implement
 * {@link queryRows}; backends that return whole issues implement {@link queryIssues} and let
 * the pack project rows with the shared select/filter helpers.
 */
export interface TrackerToolOps {
  readIssue?(issueId: string): Promise<Issue>;
  /** Issues matching generic query args (`issueIds`, `states`, provider-native queries such as `jql`). */
  queryIssues?(args: Record<string, unknown>): Promise<Issue[]>;
  /** Pre-projected rows for backends with a native query surface; takes precedence over {@link queryIssues}. */
  queryRows?(args: Record<string, unknown>): Promise<TrackerQueryResult>;
  updateStatus?(issueId: string, status: string): Promise<Issue>;
  addComment?(issueId: string, body: string): Promise<void>;
  createIssue?(input: TrackerCreateIssueInput): Promise<Issue>;
}

/**
 * Everything Symphony needs to know about one issue-tracker backend, bundled as a single
 * extension point. A provider owns its slice of the `tracker:` config section, the runtime
 * client that feeds issues into dispatch, and the normalized operations behind the
 * provider-neutral `tracker_*` tools. Agent-facing tool packs are a separate extension
 * point (`ToolProvider` in `@symphony/tool-sdk`): a tracker package may ship one, and a
 * deployment may mount several packs while this provider drives dispatch.
 *
 * The core (config parsing, runtime, MCP server, CLI) is provider-agnostic and talks to
 * providers exclusively through this contract via a {@link TrackerRegistry}. Adding a new
 * tracker backend means implementing this interface in a new package and registering it at
 * the composition root - no core package changes.
 */
export interface TrackerProvider {
  /** Config selector matched against `tracker.kind` (e.g. `"linear"`, `"jira"`). */
  readonly kind: string;
  /**
   * snake_case → camelCase alias map for this provider's keys in the `tracker:` config
   * section (e.g. `{ project_slug: "projectSlug" }`). Applied before {@link parseOptions}.
   */
  readonly configAliases?: Readonly<Record<string, string>> | undefined;
  /**
   * Environment variables consulted as fallbacks for shared `tracker:` fields the workflow
   * config leaves unset, keyed by field name (e.g. `{ apiKey: "JIRA_API_KEY" }`).
   */
  readonly envFallbacks?: Readonly<Record<string, string>> | undefined;
  /** Endpoint used when `tracker.endpoint` is not configured. */
  readonly defaultEndpoint?: string | undefined;
  /**
   * Validate and normalize the provider-specific keys of the `tracker:` section (aliases
   * already applied). Called at config-parse time; throw with a `tracker.<key> ...` message
   * on invalid input. The returned record becomes {@link Settings.tracker.options}.
   */
  parseOptions?(options: Record<string, unknown>, context: TrackerContext): Record<string, unknown>;
  /**
   * Throw when the parsed settings cannot drive dispatch (missing credentials or required
   * options). Called once at startup by `validateDispatchConfig`.
   */
  validateDispatch?(settings: Settings): void;
  /** Build the runtime client that feeds candidate issues into the dispatch loop. */
  createClient(settings: Settings, context: TrackerContext): RuntimeTrackerClient;
  /**
   * Normalized operations backing the neutral `tracker_*` pack for this backend; return
   * `undefined` (or omit the member) when the backend exposes no agent-facing operations.
   */
  createToolOps?(settings: Settings, context: TrackerOpsContext): TrackerToolOps | undefined;
  /** Operator-facing URL of the tracked project, shown in dashboards. */
  projectUrl?(settings: Settings): string | undefined;
}
