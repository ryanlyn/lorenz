import type { RuntimeTrackerClient, Settings } from "@lorenz/domain";

/** Ambient dependencies handed to provider hooks that must not touch process globals directly. */
export interface TrackerContext {
  env: NodeJS.ProcessEnv;
  /**
   * Config-layer secret resolution (`$VAR` and `op://` references, with an optional env-var
   * fallback) for provider option values. Present when invoked by the config parser.
   */
  resolveSecret?: (value: string | undefined, fallbackEnvVar?: string) => string | undefined;
}

/** Normalized tracker issue comment returned by tracker clients and their comment tools. */
export interface TrackerComment {
  id: string;
  body: string;
  author?: string | null | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  url?: string | null | undefined;
}

/**
 * Everything Lorenz needs to know about one issue-tracker backend, bundled as a single
 * extension point. A provider owns its slice of the selected tracker bundle and the runtime
 * client that feeds issues into dispatch. Agent-facing tool packs are a separate extension
 * point (`ToolProvider` in `@lorenz/tool-sdk`): a tracker package may ship one and declare
 * it through {@link defaultToolPacks} so it mounts when this tracker drives dispatch, and a
 * workflow may still mount other registered packs explicitly through its `tools:` map.
 *
 * The core (config parsing, runtime, MCP server, CLI) is provider-agnostic and talks to
 * providers exclusively through this contract via a {@link TrackerRegistry}. Adding a new
 * tracker backend means implementing this interface in a new package and registering it at
 * the composition root - no core package changes.
 */
export interface TrackerProvider {
  /** Config selector matched against the tracker provider name (e.g. `"linear"`, `"jira"`). */
  readonly kind: string;
  /**
   * snake_case → camelCase alias map for this provider's keys in the selected tracker
   * bundle (e.g. `{ project_slug: "projectSlug" }`). Applied before {@link parseOptions}.
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
   * Validate and normalize the provider-specific keys of the selected tracker bundle
   * (aliases already applied). Called at config-parse time; throw with a `tracker.<key> ...`
   * message on invalid input. The returned record becomes {@link Settings.tracker.options}.
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
   * Tool packs mounted by default when this tracker drives dispatch. This is how a tracker
   * extension exposes its agent-facing tools (e.g. Jira's `jira_*` pack, Linear's
   * `linear_graphql` pack); return the names of the registered {@link ToolProvider} packs the
   * backend owns. Omit when the backend ships no agent tools.
   */
  defaultToolPacks?(settings: Settings): readonly string[];
  /** Operator-facing URL of the tracked project, shown in dashboards. */
  projectUrl?(settings: Settings): string | undefined;
}
