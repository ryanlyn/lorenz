import path from "node:path";

import { execaSync } from "execa";
import { z } from "zod";
import type {
  AgentConfig,
  AgentKind,
  AgentSettings,
  HooksSettings,
  PartialRuntimeSettings,
  Settings,
  TrackerSettings,
  WorkerPoolSettings,
  WorkerPoolSettingsInput,
  WorkerSettings,
} from "@lorenz/domain";
import {
  errorMessage,
  isDiagnosticSecretKey,
  isRecord as isPlainRecord,
  normalizeHttpBindHost,
  registerDiagnosticSecret,
  withDerivedMaxInFlight,
} from "@lorenz/domain";
import {
  defaultAgentExecutorRegistry,
  type AgentExecutorProvider,
  type AgentExecutorRegistry,
} from "@lorenz/agent-sdk";
import type { ToolRegistry } from "@lorenz/tool-sdk";
import { defaultTrackerRegistry, type TrackerRegistry } from "@lorenz/tracker-sdk";

import { hooksAliases, normalizeAliases } from "./aliases.js";
import { warnConfigDeprecations } from "./deprecations.js";
import { defaultAgentRecords, defaultSettings, type DefaultSettingsOptions } from "./defaults.js";
import { configErrorMessage } from "./errors.js";
import { joinPath, nonEmptyString } from "./leaf-utils.js";
import {
  agentRecordOverrideSchema,
  agentRecordSchema,
  coercedNonNegativeTimeoutMs,
  coercedTimeoutMs,
  workflowConfigSchema,
  type AgentRaw,
  type AgentRecordOverrideRaw,
  type AgentRecordRaw,
  type AgentsRaw,
  type WorkerPoolRaw,
  type ClaudeRaw,
  type CodexRaw,
  type DispatchRaw,
  type HooksRaw,
  type StatusOverridesRaw,
  trackerRecordSchema,
  type TrackerRecordRaw,
  type TrackersRaw,
  type ToolsRaw,
  type TrackerRaw,
  type WorkflowConfigRaw,
  type WorkersRaw,
} from "./schemas.js";

export function parseConfig(
  raw: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
  defaults: DefaultSettingsOptions = {},
  registry: TrackerRegistry = defaultTrackerRegistry,
  executors: AgentExecutorRegistry = defaultAgentExecutorRegistry,
): Settings {
  const settings = defaultSettings(defaults);
  const parsed = parseWorkflowConfig(raw);

  const trackerRaw = parsed.tracker ?? {};
  settings.tracker = parseTracker(
    settings.tracker,
    trackerRaw,
    parsed.trackers ?? {},
    env,
    registry,
  );
  settings.toolOptions = parseToolOptions(parsed.tools, env);

  const pollingRaw = parsed.polling ?? {};
  settings.polling.intervalMs = pollingRaw.intervalMs ?? settings.polling.intervalMs;

  const workspaceRaw = parsed.workspace ?? {};
  const workspaceRootFallback = settings.workspace.rootExpression ?? settings.workspace.root;
  const workspaceRootExpression = resolveWorkspaceRootExpression(
    nonEmptyString(env.LORENZ_WORKSPACE_ROOT) ?? workspaceRaw.root,
    workspaceRootFallback,
    env,
  );
  settings.workspace.rootExpression = workspaceRootExpression;
  settings.workspace.root = expandLocalPath(workspaceRootExpression, env);
  settings.workspace.isolation = workspaceRaw.isolation ?? settings.workspace.isolation;

  const workerRaw = parsed.worker ?? {};
  if (workerRaw.kind !== undefined) settings.worker.kind = workerRaw.kind;
  settings.worker.sshHosts = workerRaw.sshHosts ?? settings.worker.sshHosts;
  settings.worker.sshTimeoutMs = workerRaw.sshTimeoutMs ?? settings.worker.sshTimeoutMs;
  if (workerRaw.maxConcurrentAgentsPerHost !== undefined) {
    settings.worker.maxConcurrentAgentsPerHost = workerRaw.maxConcurrentAgentsPerHost;
  }
  if (workerRaw.kind !== undefined && settings.worker.sshHosts.length > 0) {
    throw new Error("worker.kind cannot be combined with worker.ssh_hosts");
  }
  // The pool is the single dispatch path; parseWorkerPool always returns one. The static-ssh
  // fold-in caps per-host concurrency at `max_concurrent_agents_per_host ?? agent.max_concurrent_agents`.
  // The agent override is applied later (parseAgentSettings), so resolve it here from the raw config,
  // falling back to the value already on settings.agent.
  const perHostConcurrency =
    settings.worker.maxConcurrentAgentsPerHost ??
    parsed.agent?.maxConcurrentAgents ??
    settings.agent.maxConcurrentAgents;
  settings.worker.workerPool = parseWorkerPool(
    workerRaw.workerPool,
    workerRaw,
    parsed.workers ?? {},
    settings.worker.sshHosts,
    perHostConcurrency,
  );

  settings.hooks = parseHooks(settings.hooks, parsed.hooks ?? {});
  if (settings.workspace.isolation === "none") assertNoWorkspaceHooks(settings.hooks);
  settings.agent = parseAgentSettings(
    settings.agent,
    parsed.agent ?? {},
    parseSkillSources(parsed.agent?.skills, env, defaults.configDir),
  );
  settings.agents = parseAgents(
    parsed.agents ?? {},
    legacyAgentRecordOverrides(parsed.codex ?? {}, parsed.claude ?? {}),
    executors,
    env,
  );

  const observabilityRaw = parsed.observability ?? {};
  settings.observability.dashboardEnabled =
    observabilityRaw.dashboardEnabled ?? settings.observability.dashboardEnabled;
  settings.observability.refreshMs = observabilityRaw.refreshMs ?? settings.observability.refreshMs;
  settings.observability.renderIntervalMs =
    observabilityRaw.renderIntervalMs ?? settings.observability.renderIntervalMs;

  const serverRaw = parsed.server ?? {};
  settings.server.host = normalizeHttpBindHost(serverRaw.host ?? settings.server.host);
  if (serverRaw.port !== undefined) settings.server.port = serverRaw.port;
  if (serverRaw.traceDir !== undefined) settings.server.traceDir = serverRaw.traceDir;
  if (serverRaw.staticDir !== undefined) settings.server.staticDir = serverRaw.staticDir;

  const loggingRaw = parsed.logging ?? {};
  if (loggingRaw.logFile !== undefined) {
    settings.logging.logFile = expandLocalPath(loggingRaw.logFile, env);
  }

  settings.statusOverrides = parseStatusOverrides(
    parsed.statusOverrides ?? {},
    settings.agents,
    executors,
    env,
  );
  return settings;
}

export function settingsForIssueState(settings: Settings, state: string): Settings {
  const override = settings.statusOverrides.get(normalizeStateName(state));
  if (!override) return cloneSettings(settings);

  const merged = cloneSettings(settings);
  if (override.agent) merged.agent = { ...merged.agent, ...override.agent };
  if (override.agents) {
    for (const [kind, fragment] of Object.entries(override.agents)) {
      const base = merged.agents[kind];
      if (!base) continue;
      merged.agents[kind] = mergeAgentFragment(base, fragment);
    }
  }
  return merged;
}

/**
 * Opt-in deprecation-warning surface for {@link validateDispatchConfig}. Callers that hold the
 * raw front matter (the daemon's first load, an embedder validating a config) pass it to have
 * deprecated keys reported at validation time; the per-poll runtime path omits it so a reload
 * loop never re-warns.
 */
export interface ConfigDeprecationContext {
  rawConfig: Record<string, unknown>;
  warn: (message: string) => void;
}

export function validateDispatchConfig(
  settings: Settings,
  trackers: TrackerRegistry = defaultTrackerRegistry,
  executors: AgentExecutorRegistry = defaultAgentExecutorRegistry,
  tools?: ToolRegistry,
  deprecations?: ConfigDeprecationContext,
): void {
  // Report deprecations before the throwing validation below so operators still see the
  // recommendation when a config both uses a deprecated key and fails to validate.
  if (deprecations) warnConfigDeprecations(deprecations.rawConfig, deprecations.warn);

  const provider = trackers.require(settings.tracker.kind);
  provider.validateDispatch?.(settings);

  if (tools && settings.toolOptions !== undefined) {
    for (const [pack, options] of Object.entries(settings.toolOptions)) {
      const provider = tools.require(pack);
      if (provider.validateOptions === undefined) {
        if (Object.keys(options).length > 0) {
          throw new Error(`tools.${pack} is not supported by the "${pack}" pack`);
        }
        continue;
      }
      provider.validateOptions(options);
    }
  }

  const requiredBackends = new Set<AgentKind>([settings.agent.kind]);
  for (const override of settings.statusOverrides.values()) {
    if (override.agent?.kind) requiredBackends.add(override.agent.kind);
  }
  for (const kind of requiredBackends) {
    const agent = settings.agents[kind];
    if (!agent) throw new Error(`agents.${kind} is required`);
    const executorProvider = executors.get(agent.executor);
    if (!executorProvider) {
      const known = executors.executors();
      const hint = known.length > 0 ? ` (known executors: ${known.join(", ")})` : "";
      throw new Error(`unsupported agents.${kind}.executor: ${agent.executor}${hint}`);
    }
    executorProvider.validateAgent?.(kind, agent, settings);
  }
}

/**
 * The effective tracker selector a raw workflow config resolves to - the value
 * that becomes `settings.tracker.kind` - WITHOUT running the rest of config
 * parsing. The out-of-tree extension loader needs this BEFORE {@link parseConfig}
 * so it can dynamic-import a tracker module named by `tracker.kind` and register
 * it (under that exact string) into the registry the parser then resolves
 * `parseOptions`/`validateDispatch` against. Returns undefined when no tracker is
 * configured (the default tracker applies) or when a `trackers.<name>` bundle is
 * selected (a bundle is an in-repo composition, never a module specifier).
 *
 * Mirrors {@link parseTracker}'s selection: `tracker.kind` is the selector; an
 * empty/blank value yields undefined. This reads only the selector, so a tracker
 * module specifier in `tracker.kind` (e.g. `./acme-tracker.mjs`) surfaces here
 * verbatim for the loader, while a bundle selection is left to the registry's
 * built-ins.
 */
export function trackerSpecifierFromConfig(raw: Record<string, unknown> = {}): string | undefined {
  const parsed = parseWorkflowConfig(raw);
  const trackersRaw = parsed.trackers ?? {};
  const selectorRecord = parseTrackerRecord(parsed.tracker ?? {}, "tracker");
  const selected = trackerKindValue(selectorRecord.kind);
  if (selected === undefined) return undefined;
  // A `trackers.<name>` bundle selection composes an in-repo provider via the
  // bundle's `provider:` key; it is never an out-of-tree module specifier.
  if (trackersRaw[selected] !== undefined) return undefined;
  return selected;
}

export function normalizeStateName(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeRouteName(value: unknown): string {
  if (value === undefined || value === null) return "";
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value).trim().toLowerCase();
}

/** Shared tracker aliases; provider-specific aliases are declared by each tracker provider. */
const TRACKER_COMMON_ALIASES = {
  api_key: "apiKey",
  active_states: "activeStates",
  terminal_states: "terminalStates",
};
const TRACKER_DISPATCH_ALIASES = {
  accept_unrouted: "acceptUnrouted",
  only_routes: "onlyRoutes",
  route_label_prefix: "routeLabelPrefix",
};

/** Keys of a selected tracker config record owned by the core; everything else belongs to the provider. */
const TRACKER_COMMON_KEYS = new Set([
  "kind",
  "provider",
  "endpoint",
  "apiKey",
  "assignee",
  "activeStates",
  "terminalStates",
  "dispatch",
]);

function parseTracker(
  defaults: TrackerSettings,
  trackerRaw: TrackerRaw,
  trackersRaw: TrackersRaw,
  env: NodeJS.ProcessEnv,
  registry: TrackerRegistry,
): TrackerSettings {
  assertTrackerBundleNames(trackersRaw);

  const selectorRecord = parseTrackerRecord(trackerRaw, "tracker");
  const selectedBundleName = trackerKindValue(selectorRecord.kind) ?? defaults.kind;
  const trackerRecord =
    selectedBundleName === undefined
      ? legacyTrackerRecord(selectorRecord, selectedBundleName, trackersRaw)
      : trackerRecordForSelection(selectorRecord, selectedBundleName, trackersRaw);
  const kind = trackerRecord.kind;
  // Unregistered kinds parse generically (options pass through unvalidated) and are
  // rejected with the full list of known kinds by validateDispatchConfig.
  const provider = registry.get(kind);

  const apiKey = resolveConfiguredSecret(
    trackerRecord.apiKey,
    env,
    provider?.envFallbacks?.apiKey,
    {
      register: true,
    },
  );
  const assignee = resolveConfiguredSecret(
    trackerRecord.assignee,
    env,
    provider?.envFallbacks?.assignee,
  );
  const endpoint = trackerRecord.endpoint ?? provider?.defaultEndpoint ?? defaults.endpoint;

  const providerRaw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(trackerRecord)) {
    if (!TRACKER_COMMON_KEYS.has(key)) providerRaw[key] = value;
  }
  const aliased = normalizeAliases(providerRaw, { ...(provider?.configAliases ?? {}) });
  const options = provider?.parseOptions
    ? provider.parseOptions(aliased, {
        env,
        resolveSecret: (value, fallbackEnvVar) =>
          resolveConfiguredSecret(value, env, fallbackEnvVar, { register: true }),
      })
    : aliased;

  return {
    kind,
    endpoint,
    apiKey,
    assignee,
    activeStates: trackerRecord.activeStates ?? defaults.activeStates,
    terminalStates: trackerRecord.terminalStates ?? defaults.terminalStates,
    dispatch: parseDispatch(defaults.dispatch, trackerRecord.dispatch ?? {}),
    options,
  };
}

function legacyTrackerRecord(
  selectorRecord: TrackerRecordRaw,
  selectedBundleName: string | undefined,
  trackersRaw: TrackersRaw,
): TrackerRecordRaw {
  if (selectedBundleName !== undefined && Object.keys(trackersRaw).length > 0) {
    throw new Error(`trackers.${selectedBundleName} is required by tracker.kind`);
  }
  return { ...selectorRecord, kind: selectedBundleName };
}

function trackerRecordForSelection(
  selectorRecord: TrackerRecordRaw,
  selectedBundleName: string,
  trackersRaw: TrackersRaw,
): TrackerRecordRaw {
  const selectedBundleRaw = trackersRaw[selectedBundleName];
  return selectedBundleRaw === undefined
    ? legacyTrackerRecord(selectorRecord, selectedBundleName, trackersRaw)
    : bundledTrackerRecord(selectorRecord, selectedBundleRaw, selectedBundleName);
}

function bundledTrackerRecord(
  selectorRecord: TrackerRecordRaw,
  selectedBundleRaw: Record<string, unknown>,
  selectedBundleName: string,
): TrackerRecordRaw {
  const selectedBundle = parseTrackerRecord(selectedBundleRaw, `trackers.${selectedBundleName}`);
  const provider = trackerKindValue(selectedBundle.provider);
  if (provider === undefined) {
    throw new Error(`trackers.${selectedBundleName}.provider is required`);
  }
  const { kind: _selectorKind, provider: _selectorProvider, ...selectorOptions } = selectorRecord;
  const { kind: _bundleKind, provider: _bundleProvider, ...bundleOptions } = selectedBundle;
  return { ...selectorOptions, ...bundleOptions, kind: provider };
}

function assertTrackerBundleNames(trackersRaw: TrackersRaw): void {
  for (const name of Object.keys(trackersRaw)) {
    if (!name.trim()) throw new Error("trackers names must not be blank");
  }
}

function parseTrackerRecord(raw: Record<string, unknown>, label: string): TrackerRecordRaw {
  const normalized = normalizeAliases(raw, TRACKER_COMMON_ALIASES);
  if (isPlainRecord(normalized.dispatch)) {
    normalized.dispatch = normalizeAliases(normalized.dispatch, TRACKER_DISPATCH_ALIASES);
  }
  const result = trackerRecordSchema.safeParse(normalized);
  if (result.success) return result.data;
  throw new Error(configErrorMessage(result.error, label));
}

function expandLocalPath(value: string, env: NodeJS.ProcessEnv): string {
  const expanded = expandPathVariables(value, env);
  const home = nonEmptyString(env.HOME) ?? nonEmptyString(env.USERPROFILE);
  if (home && expanded === "~") return home;
  if (home && expanded.startsWith("~/")) return joinPath(home, expanded.slice(2));
  return expanded;
}

function parseSkillSources(
  skills: string[] | undefined,
  env: NodeJS.ProcessEnv,
  configDir: string | undefined,
): string[] {
  const baseDir = configDir ?? process.cwd();
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const source of skills ?? []) {
    const expanded = expandLocalPath(source, env);
    if (!nonEmptyString(expanded)) throw new Error("agent.skills must not contain blank paths");
    const absolute = path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(baseDir, expanded);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    resolved.push(absolute);
  }
  return resolved;
}

function resolveWorkspaceRootExpression(
  value: string | undefined,
  fallback: string,
  env: NodeJS.ProcessEnv,
): string {
  const expression = value ?? fallback;
  return nonEmptyString(expandLocalPath(expression, env)) === undefined ? fallback : expression;
}

function parseDispatch(defaults: TrackerSettings["dispatch"], raw: DispatchRaw) {
  const onlyRoutesRaw = raw.onlyRoutes;
  const onlyRoutes =
    onlyRoutesRaw === null
      ? null
      : onlyRoutesRaw === undefined
        ? defaults.onlyRoutes
        : normalizeOnlyRoutes(onlyRoutesRaw);
  return {
    acceptUnrouted: raw.acceptUnrouted ?? defaults.acceptUnrouted,
    onlyRoutes,
    routeLabelPrefix: (raw.routeLabelPrefix ?? defaults.routeLabelPrefix).trim(),
  };
}

function assertNoWorkspaceHooks(hooks: HooksSettings): void {
  const configured = Object.entries(hooksAliases)
    .filter(([snake, camel]) => snake !== "timeout_ms" && hooks[camel as keyof HooksSettings])
    .map(([snake]) => snake);
  if (configured.length === 0) return;
  throw new Error(
    `workspace.isolation = "none" does not support hooks; remove ${configured.join(", ")}`,
  );
}

function parseWorkerPool(
  raw: WorkerPoolRaw | null | undefined,
  workerRaw: NonNullable<WorkflowConfigRaw["worker"]>,
  workersRaw: WorkersRaw,
  sshHosts: readonly string[],
  perHostConcurrency: number,
): WorkerPoolSettings {
  const selectedWorker = selectedWorkerProfile(workerRaw.kind, workersRaw);

  // No explicit worker_pool and no named worker profile: defaultDispatchWorkerPool supplies the
  // implicit pool (a `local` pool, or a `static-ssh` pool when `ssh_hosts` is set).
  if ((raw === undefined || raw === null) && selectedWorker === undefined) {
    return defaultDispatchWorkerPool(sshHosts, perHostConcurrency);
  }
  if (selectedWorker !== undefined && raw?.driver !== undefined) {
    throw new Error("worker.kind cannot be combined with worker.worker_pool.driver");
  }
  // The `ssh_hosts` fold-in only auto-selects static-ssh when no driver is named; a named driver
  // wins, so an explicit `worker_pool.driver` alongside `ssh_hosts` is ambiguous and rejected
  // rather than dropping the hosts.
  if (raw?.driver !== undefined && sshHosts.length > 0) {
    throw new Error("worker.worker_pool.driver cannot be combined with worker.ssh_hosts");
  }

  const driver = selectedWorker?.driver ?? raw?.driver ?? "fake";
  const min = raw?.min ?? 0;
  const max = raw?.max ?? 1;
  const warm = raw?.warm ?? 1;

  if (max < min) {
    throw new Error("worker.worker_pool.max must be >= worker.worker_pool.min");
  }
  if (warm > max) {
    throw new Error("worker.worker_pool.warm must be <= worker.worker_pool.max");
  }

  // `maxInFlight` is a derived getter over `slotsPerMachine` (domain `withDerivedMaxInFlight`),
  // so the constructed object carries exactly ONE own field (`slotsPerMachine`). The config key
  // `worker.worker_pool.max_in_flight` is unchanged; it parses into `slotsPerMachine`.
  const input: WorkerPoolSettingsInput = {
    // A configured pool (an explicit worker_pool block or a named worker.kind) is always enabled;
    // `enabled` is an internal liveness flag the reload-drain flips, not an operator config key.
    enabled: true,
    driver,
    min,
    max,
    warm,
    slotsPerMachine: raw?.maxInFlight ?? 1,
    ttlMs: raw?.ttlMs ?? 3_600_000,
    idleReapMs: raw?.idleReapMs ?? 300_000,
    acquireTimeoutMs: raw?.acquireTimeoutMs ?? 30_000,
    reapIntervalMs: raw?.reapIntervalMs ?? 15_000,
    staleHeartbeatMs: raw?.staleHeartbeatMs ?? 600_000,
    drainDeadlineMs: raw?.drainDeadlineMs ?? 30_000,
  };

  const settings = withDerivedMaxInFlight(input);

  // Co-residence opt-in, tunnel ceiling, and fairness cap stay absent unless explicitly set, so
  // a default config's settings object keeps exactly the same own fields (the absent-worker_pool
  // deep-equal-clone holds).
  if (raw?.maxWorkersPerIssue !== undefined) settings.maxWorkersPerIssue = raw.maxWorkersPerIssue;
  if (raw?.coResidence !== undefined) settings.coResidence = raw.coResidence;
  if (raw?.maxConcurrentTunnels !== undefined)
    settings.maxConcurrentTunnels = raw.maxConcurrentTunnels;

  const spend = parseWorkerPoolSpend(raw?.spend);
  if (spend) settings.spend = spend;
  const driverOptions =
    selectedWorker === undefined ? undefined : selectedWorkerDriverOptions(selectedWorker);
  if (driverOptions !== undefined) settings.driverOptions = driverOptions;

  // Driver-specific option validation (e.g. static-ssh's required ssh_hosts)
  // lives with the registered driver and runs at pool construction - the same
  // fail-loud startup point as an unregistered kind.
  return settings;
}

/**
 * The implicit dispatch pool produced when no `worker_pool` and no `worker.kind` are configured:
 * - empty `sshHosts`  -> an enabled `local` pool, slotsPerMachine=1, min=0/warm=0 and
 *   max=`max_concurrent_agents_per_host ?? agent.max_concurrent_agents` so local concurrency tracks
 *   the agent concurrency knob. Nothing provisions eagerly; each single-tenant local worker is minted
 *   on first acquire, up to `max`. The local driver yields an empty `workerHost`, so the per-run
 *   endpoint manager mints no tunnel and acp keeps its own in-process MCP endpoint.
 * - non-empty `sshHosts` -> an enabled `static-ssh` pool whose driverOptions carry the configured
 *   hosts (the `ssh_hosts` spelling the driver's `readSshHosts` expects). `max` is the host count
 *   and slotsPerMachine is the per-host cap (`max_concurrent_agents_per_host ??
 *   agent.max_concurrent_agents`), so total capacity is hosts * perHostConcurrency. `co_residence`
 *   is auto-enabled when that cap is >1, since each co-resident run owns its own per-run Token B
 *   claim plus the shared per-host reverse tunnel. The provision policy is round-robin first-free
 *   (static-ssh `provision`).
 */
function defaultDispatchWorkerPool(
  sshHosts: readonly string[],
  perHostConcurrency: number,
): WorkerPoolSettings {
  if (sshHosts.length > 0) {
    const slotsPerMachine = Math.max(1, perHostConcurrency);
    const input: WorkerPoolSettingsInput = {
      enabled: true,
      driver: "static-ssh",
      min: 0,
      max: sshHosts.length,
      warm: 0,
      slotsPerMachine,
      ttlMs: 3_600_000,
      idleReapMs: 300_000,
      acquireTimeoutMs: 30_000,
      reapIntervalMs: 15_000,
      staleHeartbeatMs: 600_000,
      drainDeadlineMs: 30_000,
      driverOptions: { ssh_hosts: [...sshHosts] },
    };
    const settings = withDerivedMaxInFlight(input);
    // A per-host cap >1 co-resides runs on one host (guarded by the slots-per-machine gate), so
    // auto-enable the co_residence opt-in. A cap of 1 stays single-tenant and never trips the gate.
    if (slotsPerMachine > 1) settings.coResidence = true;
    return settings;
  }

  const input: WorkerPoolSettingsInput = {
    enabled: true,
    driver: "local",
    min: 0,
    // Local concurrency tracks the agent concurrency knob: up to `perHostConcurrency`
    // (`max_concurrent_agents_per_host ?? agent.max_concurrent_agents`) single-tenant local workers
    // run in parallel. slotsPerMachine stays 1, so each run is its own isolation unit (no
    // co-residence, no per-run claim gateway) rather than packing N runs onto one worker.
    max: Math.max(1, perHostConcurrency),
    warm: 0,
    slotsPerMachine: 1,
    ttlMs: 3_600_000,
    idleReapMs: 300_000,
    acquireTimeoutMs: 30_000,
    reapIntervalMs: 15_000,
    staleHeartbeatMs: 600_000,
    drainDeadlineMs: 30_000,
  };
  return withDerivedMaxInFlight(input);
}

function selectedWorkerProfile(
  workerKind: string | undefined,
  workersRaw: WorkersRaw,
): WorkersRaw[string] | undefined {
  if (workerKind === undefined) return undefined;
  const selected = workersRaw[workerKind];
  if (selected === undefined) {
    throw new Error(`worker.kind "${workerKind}" does not match any workers entry`);
  }
  return selected;
}

function selectedWorkerDriverOptions(
  worker: WorkersRaw[string],
): Record<string, unknown> | undefined {
  const { driver: _driver, ...driverOptions } = worker;
  return Object.keys(driverOptions).length === 0 ? undefined : driverOptions;
}

function parseWorkerPoolSpend(raw: WorkerPoolRaw["spend"]): WorkerPoolSettings["spend"] {
  if (raw === undefined) return undefined;
  const spend: NonNullable<WorkerPoolSettings["spend"]> = {};
  if (raw.maxConcurrentWorkers !== undefined) spend.maxConcurrentWorkers = raw.maxConcurrentWorkers;
  if (raw.maxWorkerSeconds !== undefined) spend.maxWorkerSeconds = raw.maxWorkerSeconds;
  if (raw.dailyWorkerSeconds !== undefined) spend.dailyWorkerSeconds = raw.dailyWorkerSeconds;
  return spend;
}

function parseHooks(defaults: HooksSettings, hooksRaw: HooksRaw): HooksSettings {
  return {
    afterCreate: hooksRaw.afterCreate ?? null,
    beforeRun: hooksRaw.beforeRun ?? null,
    afterRun: hooksRaw.afterRun ?? null,
    beforeRemove: hooksRaw.beforeRemove ?? null,
    timeoutMs: hooksRaw.timeoutMs ?? defaults.timeoutMs,
  };
}

function parseAgentSettings(
  defaults: AgentSettings,
  agentRaw: AgentRaw,
  skills: string[],
): AgentSettings {
  const kind = agentRaw.kind ?? defaults.kind;

  return {
    kind,
    maxConcurrentAgents: agentRaw.maxConcurrentAgents ?? defaults.maxConcurrentAgents,
    maxTurns: agentRaw.maxTurns ?? defaults.maxTurns,
    maxRetryBackoffMs: agentRaw.maxRetryBackoffMs ?? defaults.maxRetryBackoffMs,
    ensembleSize: agentRaw.ensembleSize ?? defaults.ensembleSize,
    skills: agentRaw.skills ? skills : defaults.skills,
  };
}

/**
 * Map a legacy top-level `codex:` / `claude:` workflow section onto the matching
 * {@link Settings.agents} record. The sections are parse-time conveniences only;
 * `agents` is the single source of truth at runtime.
 */
function legacyAgentRecordOverrides(
  codexRaw: CodexRaw,
  claudeRaw: ClaudeRaw,
): Record<string, Partial<AgentConfig>> {
  const overrides: Record<string, Partial<AgentConfig>> = {};
  const codex = agentRecordFragment(codexRaw);
  if (Object.keys(codex).length > 0) overrides.codex = codex;
  const claude = claudeRecordFragment(defaultAgentRecords().claude!, claudeRaw);
  if (Object.keys(claude).length > 0) overrides.claude = claude;
  return overrides;
}

/**
 * Translate legacy backend-section keys into an agent-record fragment: shared keys stay
 * top-level, ACP keys (`command`, ...) become entries of the record's options bag.
 */
function agentRecordFragment(raw: Partial<CodexRaw & ClaudeRaw>): Partial<AgentConfig> {
  const options: Record<string, unknown> = {
    ...(raw.command !== undefined ? { bridgeCommand: raw.command } : {}),
    ...(raw.strictMcpConfig !== undefined ? { strictMcpConfig: raw.strictMcpConfig } : {}),
    ...(raw.providerConfig !== undefined ? { providerConfig: raw.providerConfig } : {}),
  };
  return {
    ...(raw.turnTimeoutMs !== undefined ? { turnTimeoutMs: raw.turnTimeoutMs } : {}),
    ...(raw.stallTimeoutMs !== undefined ? { stallTimeoutMs: raw.stallTimeoutMs } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

/**
 * Like {@link agentRecordFragment}, plus the top-level `claude.model` handling: the model
 * setting pins the `model` key of the record's provider config; an explicit `model` key
 * inside a configured provider config takes precedence.
 */
function claudeRecordFragment(base: AgentConfig, raw: ClaudeRaw): Partial<AgentConfig> {
  const fragment = agentRecordFragment(raw);
  if (raw.model === undefined && raw.providerConfig === undefined) return fragment;
  const baseProviderConfig = isPlainRecord(base.options.providerConfig)
    ? base.options.providerConfig
    : undefined;
  const model = raw.model ?? baseProviderConfig?.model;
  const providerConfig = raw.providerConfig
    ? { ...(model !== undefined ? { model } : {}), ...raw.providerConfig }
    : { ...baseProviderConfig, ...(model !== undefined ? { model } : {}) };
  fragment.options = { ...fragment.options, providerConfig };
  return fragment;
}

/** Layer a sparse record fragment over a full record, merging the options bags per key. */
function mergeAgentFragment(base: AgentConfig, fragment: Partial<AgentConfig>): AgentConfig {
  return { ...base, ...fragment, options: { ...base.options, ...fragment.options } };
}

/** Like {@link mergeAgentFragment} for two sparse fragments; the second fragment wins. */
function mergeAgentFragments(
  first: Partial<AgentConfig>,
  second: Partial<AgentConfig> | undefined,
): Partial<AgentConfig> {
  if (!second) return first;
  const options = { ...first.options, ...second.options };
  return {
    ...first,
    ...second,
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

function parseAgents(
  raw: AgentsRaw,
  legacyOverrides: Record<string, Partial<AgentConfig>>,
  executors: AgentExecutorRegistry,
  env: NodeJS.ProcessEnv,
): Record<string, AgentConfig> {
  const { timeoutDefaults, records } = parseAgentsRaw(raw);
  const base = defaultAgentRecords();
  for (const [kind, fragment] of Object.entries(legacyOverrides)) {
    const record = base[kind];
    if (record) base[kind] = mergeAgentFragment(record, fragment);
  }
  // TODO: Remove legacy top-level codex/claude timeout fallbacks after configs use shared agents-level timeout defaults.
  const baseAgents = withAgentTimeoutDefaults(base, timeoutDefaults);
  const agents = cloneAgentRecords(baseAgents);
  const claudeDefaults = baseAgents.claude!;
  for (const [name, value] of Object.entries(records)) {
    const normalized = name.trim();
    if (!normalized) throw new Error("agents names must not be blank");
    const recordRaw = asRecord(value, `agents.${normalized}`);
    const parsed = parseAgentRecordSchema(recordRaw, `agents.${normalized}`);
    agents[normalized] = parseAgent(normalized, parsed, baseAgents, claudeDefaults, executors, env);
  }
  return agents;
}

interface AgentTimeoutDefaults {
  turnTimeoutMs?: number | undefined;
  stallTimeoutMs?: number | undefined;
}

function parseAgentsRaw(raw: AgentsRaw): {
  timeoutDefaults: AgentTimeoutDefaults;
  records: Record<string, unknown>;
} {
  const { turnTimeoutMs, stallTimeoutMs, ...records } = raw;
  const result = z
    .object({
      turnTimeoutMs: coercedTimeoutMs.optional(),
      stallTimeoutMs: coercedNonNegativeTimeoutMs.optional(),
    })
    .strict()
    .safeParse({ turnTimeoutMs, stallTimeoutMs });
  if (!result.success) throw new Error(configErrorMessage(result.error, "agents"));
  return { timeoutDefaults: result.data, records };
}

function withAgentTimeoutDefaults(
  records: Record<string, AgentConfig>,
  timeoutDefaults: AgentTimeoutDefaults,
): Record<string, AgentConfig> {
  if (timeoutDefaults.turnTimeoutMs === undefined && timeoutDefaults.stallTimeoutMs === undefined) {
    return records;
  }
  return Object.fromEntries(
    Object.entries(records).map(([name, record]) => [
      name,
      {
        ...record,
        turnTimeoutMs: timeoutDefaults.turnTimeoutMs ?? record.turnTimeoutMs,
        stallTimeoutMs: timeoutDefaults.stallTimeoutMs ?? record.stallTimeoutMs,
      },
    ]),
  );
}

/**
 * Default record backing a custom agent kind: the claude record minus its provider config,
 * which only carries over when the configured bridge command is claude-compatible.
 */
function customAgentDefaultsForBridge(
  aliasedOptions: Record<string, unknown>,
  claudeDefaults: AgentConfig,
): AgentConfig {
  const configured = aliasedOptions.bridgeCommand;
  const bridgeCommand =
    typeof configured === "string" ? configured : String(claudeDefaults.options.bridgeCommand);
  const isClaudeCompatible = /(^|\s|\/)claude-agent-acp(\s|$)/.test(bridgeCommand);
  // No usageAccounting default: custom kinds infer it from their effective bridge command.
  const { usageAccounting: _usageAccounting, ...claudeOptions } = claudeDefaults.options;
  return {
    ...claudeDefaults,
    options: isClaudeCompatible
      ? claudeOptions
      : Object.fromEntries(
          Object.entries(claudeOptions).filter(([key]) => key !== "providerConfig"),
        ),
  };
}

function parseAgentRecordSchema(raw: Record<string, unknown>, label: string) {
  const result = agentRecordSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new Error(configErrorMessage(result.error, label));
}

/** Keys of an agents.<kind> record owned by the core; everything else belongs to the executor. */
const AGENT_COMMON_KEYS = new Set(["executor", "turnTimeoutMs", "stallTimeoutMs"]);

function parseAgent(
  kind: AgentKind,
  raw: AgentRecordRaw,
  baseAgents: Record<string, AgentConfig>,
  claudeDefaults: AgentConfig,
  executors: AgentExecutorRegistry,
  env: NodeJS.ProcessEnv,
): AgentConfig {
  const executor = raw.executor ?? baseAgents[kind]?.executor ?? claudeDefaults.executor;
  // Unregistered executors parse generically (options pass through unvalidated) and are
  // rejected with the full list of known executors by validateDispatchConfig.
  const provider = executors.get(executor);

  const aliased = agentOptionsRaw(raw, provider, `agents.${kind}`);
  const defaults = baseAgents[kind] ?? customAgentDefaultsForBridge(aliased, claudeDefaults);
  // Option bags belong to one executor: a record selecting a different executor than its
  // defaults (including the ACP-flavored custom-kind fallback) starts from an empty bag.
  // Shared timeouts still inherit below.
  const inheritedOptions = executor === defaults.executor ? defaults.options : {};
  const merged = { ...inheritedOptions, ...aliased };
  const options = parseAgentOptions(provider, merged, env, `agents.${kind}`);

  return {
    executor,
    turnTimeoutMs: raw.turnTimeoutMs ?? defaults.turnTimeoutMs,
    stallTimeoutMs: raw.stallTimeoutMs ?? defaults.stallTimeoutMs,
    options,
  };
}

/** Run the executor provider's option parser, labelling errors with the record's config path. */
function parseAgentOptions(
  provider: AgentExecutorProvider | undefined,
  options: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  label: string,
): Record<string, unknown> {
  if (!provider?.parseOptions) return options;
  try {
    return provider.parseOptions(options, {
      env,
      resolveSecret: (value, fallbackEnvVar) => resolveConfiguredSecret(value, env, fallbackEnvVar),
    });
  } catch (error) {
    throw new Error(`${label}: ${errorMessage(error)}`, { cause: error });
  }
}

function parseStatusOverrides(
  raw: StatusOverridesRaw,
  baseAgents: Record<string, AgentConfig>,
  executors: AgentExecutorRegistry,
  env: NodeJS.ProcessEnv,
): Map<string, PartialRuntimeSettings> {
  const overrides = new Map<string, PartialRuntimeSettings>();

  for (const [stateName, value] of Object.entries(raw)) {
    const normalizedState = normalizeStateName(stateName);
    if (!normalizedState) throw new Error("status_overrides state names must not be blank");

    const next: PartialRuntimeSettings = {};
    if (value.agent !== undefined) next.agent = parsePartialAgent(value.agent);
    const agents = parseStatusOverrideAgents(normalizedState, value, baseAgents, executors, env);
    if (Object.keys(agents).length > 0) next.agents = agents;
    overrides.set(normalizedState, next);
  }

  return overrides;
}

function parsePartialAgent(raw: Partial<AgentRaw>): Partial<AgentSettings> {
  const next: Partial<AgentSettings> = {};
  if (raw.kind !== undefined) next.kind = raw.kind;
  if (raw.maxConcurrentAgents !== undefined) next.maxConcurrentAgents = raw.maxConcurrentAgents;
  if (raw.maxTurns !== undefined) next.maxTurns = raw.maxTurns;
  if (raw.maxRetryBackoffMs !== undefined) next.maxRetryBackoffMs = raw.maxRetryBackoffMs;
  if (raw.ensembleSize !== undefined) next.ensembleSize = raw.ensembleSize;
  return next;
}

/**
 * Collect per-kind agent record overrides for one state: the explicit `agents:` map plus
 * the legacy `codex:` / `claude:` sugar sections, all normalized into agent-record fields.
 */
function parseStatusOverrideAgents(
  state: string,
  value: StatusOverridesRaw[string],
  baseAgents: Record<string, AgentConfig>,
  executors: AgentExecutorRegistry,
  env: NodeJS.ProcessEnv,
): Record<string, Partial<AgentConfig>> {
  const agents: Record<string, Partial<AgentConfig>> = {};
  for (const [kind, recordRaw] of Object.entries(value.agents ?? {})) {
    const normalizedKind = kind.trim();
    if (!normalizedKind) throw new Error("status_overrides agents names must not be blank");
    const label = `status_overrides.${state}.agents.${normalizedKind}`;
    const result = agentRecordOverrideSchema.safeParse(recordRaw);
    if (!result.success) throw new Error(configErrorMessage(result.error, label));
    agents[normalizedKind] = agentRecordOverrideFragment(
      result.data,
      label,
      baseAgents[normalizedKind],
      executors,
      env,
    );
  }
  if (value.codex !== undefined) {
    agents.codex = mergeAgentFragments(agentRecordFragment(value.codex), agents.codex);
  }
  if (value.claude !== undefined) {
    const fragment = agentRecordFragment(value.claude);
    // A model override re-pins the provider config unless the override supplies its own.
    const base = baseAgents.claude;
    if (value.claude.model !== undefined && value.claude.providerConfig === undefined && base) {
      const baseProviderConfig = isPlainRecord(base.options.providerConfig)
        ? base.options.providerConfig
        : undefined;
      fragment.options = {
        ...fragment.options,
        providerConfig: { ...baseProviderConfig, model: value.claude.model },
      };
    }
    agents.claude = mergeAgentFragments(fragment, agents.claude);
  }
  return agents;
}

/**
 * Build a sparse fragment from an explicit per-state agent record: shared keys stay
 * top-level, the remaining keys are aliased by the base record's executor provider and kept
 * as a sparse options overlay. The overlay is the diff of the provider-parsed merge against
 * the base options, so coercions and derived keys land normalized while base defaults never
 * leak into the fragment.
 */
function agentRecordOverrideFragment(
  raw: AgentRecordOverrideRaw,
  label: string,
  base: AgentConfig | undefined,
  executors: AgentExecutorRegistry,
  env: NodeJS.ProcessEnv,
): Partial<AgentConfig> {
  // Per-state overrides cannot switch executors; reject the key explicitly.
  if ("executor" in raw) {
    throw new Error(`${label} contains unsupported keys: executor`);
  }
  const provider = executors.get(base?.executor);
  const aliased = agentOptionsRaw(raw, provider, label);
  const options =
    base && Object.keys(aliased).length > 0
      ? sparseOptionsOverlay(
          parseAgentOptions(provider, { ...base.options, ...aliased }, env, label),
          base.options,
        )
      : aliased;
  return {
    ...(raw.turnTimeoutMs !== undefined ? { turnTimeoutMs: raw.turnTimeoutMs } : {}),
    ...(raw.stallTimeoutMs !== undefined ? { stallTimeoutMs: raw.stallTimeoutMs } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

function agentOptionsRaw(
  raw: Record<string, unknown>,
  provider: AgentExecutorProvider | undefined,
  _label: string,
): Record<string, unknown> {
  const flat = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !AGENT_COMMON_KEYS.has(key)),
  );
  const aliases = { ...(provider?.configAliases ?? {}) };
  return normalizeLegacyAgentCommand(normalizeAliases(flat, aliases));
}

/** Fold the legacy `command` spelling into `bridgeCommand`; an explicit canonical key wins. */
function normalizeLegacyAgentCommand(options: Record<string, unknown>): Record<string, unknown> {
  if (!("command" in options)) return options;
  const { command, ...rest } = options;
  return { bridgeCommand: rest.bridgeCommand ?? command, ...rest };
}

/** Keys of a parsed options bag whose values differ from the base record's options. */
function sparseOptionsOverlay(
  parsed: Record<string, unknown>,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const overlay: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!sameOptionValue(value, base[key])) overlay[key] = value;
  }
  return overlay;
}

function sameOptionValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseToolOptions(
  tools: ToolsRaw | undefined,
  env: NodeJS.ProcessEnv,
): Record<string, Record<string, unknown>> | undefined {
  if (tools === undefined) return undefined;
  if (Object.keys(tools).length === 0) return undefined;
  return resolveToolOptionReferences(tools, env);
}

/**
 * Copy per-pack tool options, resolving whole-value `$VAR` and `op://` references in
 * top-level string values at parse time - like shared tracker credentials - so the
 * effective values are what execution uses and what the MCP server identity hashes.
 */
function resolveToolOptionReferences(
  toolOptions: Record<string, Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
): Record<string, Record<string, unknown>> {
  const resolved: Record<string, Record<string, unknown>> = {};
  for (const [pack, options] of Object.entries(toolOptions)) {
    resolved[pack] = Object.fromEntries(
      Object.entries(structuredClone(options)).flatMap(([key, value]) => {
        if (typeof value !== "string") return [[key, value]];
        const secret = resolveConfiguredSecret(value, env, undefined, {
          register: isSecretOptionKey(key),
        });
        return secret === undefined ? [] : [[key, secret]];
      }),
    );
  }
  return resolved;
}

function isSecretOptionKey(key: string): boolean {
  return isDiagnosticSecretKey(key);
}

function cloneSettings(settings: Settings): Settings {
  return {
    ...settings,
    tracker: cloneTracker(settings.tracker),
    polling: { ...settings.polling },
    workspace: { ...settings.workspace },
    worker: cloneWorkerSettings(settings.worker),
    hooks: { ...settings.hooks },
    agent: { ...settings.agent, skills: [...settings.agent.skills] },
    agents: cloneAgentRecords(settings.agents),
    ...(settings.toolOptions !== undefined && {
      toolOptions: structuredClone(settings.toolOptions),
    }),
    observability: { ...settings.observability },
    server: { ...settings.server },
    logging: { ...settings.logging },
    statusOverrides: new Map(settings.statusOverrides),
  };
}

function cloneWorkerSettings(worker: WorkerSettings): WorkerSettings {
  const cloned: WorkerSettings = { ...worker, sshHosts: [...worker.sshHosts] };
  if (worker.workerPool === undefined) {
    delete cloned.workerPool;
  } else {
    cloned.workerPool = cloneWorkerPool(worker.workerPool);
  }
  return cloned;
}

function cloneWorkerPool(workerPool: WorkerPoolSettings): WorkerPoolSettings {
  // A shallow spread copies the enumerable `maxInFlight` getter as a plain data property; strip it
  // and re-install the derived accessor over the cloned `slotsPerMachine` so the clone stays
  // drift-proof (single own field) exactly like the parse path.
  const { maxInFlight: _maxInFlight, ...rest } = workerPool;
  const input: WorkerPoolSettingsInput = { ...rest };
  if (workerPool.spend !== undefined) input.spend = { ...workerPool.spend };
  if (workerPool.driverOptions !== undefined) {
    // structuredClone guarantees nested arrays/objects (e.g. ssh_hosts) are copied,
    // so a per-issue settings clone never aliases the source driverOptions.
    input.driverOptions = structuredClone(workerPool.driverOptions);
  }
  return withDerivedMaxInFlight(input);
}

/**
 * Deep-copy mutable tracker collections (dispatch, state lists, provider options) so
 * per-issue-state clones cannot mutate the shared base config.
 */
function cloneTracker(tracker: TrackerSettings): TrackerSettings {
  return {
    ...tracker,
    dispatch: { ...tracker.dispatch },
    activeStates: [...tracker.activeStates],
    terminalStates: [...tracker.terminalStates],
    options: structuredClone(tracker.options),
  };
}

function cloneAgentRecords(records: Record<string, AgentConfig>): Record<string, AgentConfig> {
  const cloned: Record<string, AgentConfig> = {};
  for (const [name, record] of Object.entries(records)) {
    cloned[name] = { ...record, options: structuredClone(record.options) };
  }
  return cloned;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a map`);
  return value;
}

function parseWorkflowConfig(raw: Record<string, unknown>): WorkflowConfigRaw {
  const result = workflowConfigSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new Error(configErrorMessage(result.error));
}

function trackerKindValue(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const kind = value.trim();
  return kind === "" ? undefined : kind;
}

function normalizeOnlyRoutes(routes: string[]): string[] {
  const normalized = routes.map(normalizeRouteName);
  if (normalized.some((route) => route === "")) {
    throw new Error("tracker.dispatch.only_routes must not contain blank routes");
  }
  return [...new Set(normalized)];
}

function resolveEnv(value: string, env: NodeJS.ProcessEnv): string {
  const name = wholeEnvName(value);
  if (name === null) return value;
  return env[name] ?? "";
}

function resolveConfiguredSecret(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
  fallbackEnvName?: string,
  options: { register?: boolean | undefined } = {},
): string | undefined {
  const fallback = fallbackEnvName === undefined ? undefined : nonEmptyString(env[fallbackEnvName]);
  const shouldRegister =
    options.register === true ||
    (value !== undefined && value.startsWith("op://")) ||
    (fallback !== undefined && fallback.startsWith("op://"));
  let secret: string | undefined;
  if (value === undefined) {
    secret = resolveOnePasswordRef(fallback, env);
  } else {
    const resolved = resolveEnv(value, env);
    const candidate = nonEmptyString(resolved) ?? fallback;
    secret = resolveOnePasswordRef(candidate, env);
  }
  if (shouldRegister) registerDiagnosticSecret(secret);
  return secret;
}

const DEFAULT_SECRET_RESOLUTION_TIMEOUT_MS = 30_000;
const SECRET_RESOLUTION_TIMEOUT_ENV = "LORENZ_SECRET_RESOLUTION_TIMEOUT_MS";
const SECRET_PROVIDER_ENV_KEYS = new Set([
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

function resolveOnePasswordRef(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (value === undefined || !value.startsWith("op://")) return value;
  const providerEnv = secretProviderEnv(env);
  const timeout = secretResolutionTimeoutMs(env);
  try {
    const result = execaSync("op", ["read", value], {
      env: providerEnv,
      extendEnv: false,
      timeout,
    });
    return result.stdout.trim();
  } catch (error) {
    if (isTimeoutError(error)) {
      // eslint-disable-next-line preserve-caught-error -- Secret-boundary rethrows must not retain provider error objects.
      throw new Error(
        `Timed out resolving 1Password reference after ${timeout}ms; check 1Password CLI sign-in, network access, and vault permissions.`,
      );
    }
    if (isMissingExecutableError(error)) {
      // eslint-disable-next-line preserve-caught-error -- Secret-boundary rethrows must not retain provider error objects.
      throw new Error(
        "1Password CLI (op) is required to resolve op:// references but was not found. " +
          "Install it from https://developer.1password.com/docs/cli/get-started - it cannot be managed by mise.",
      );
    }
    // eslint-disable-next-line preserve-caught-error -- Secret-boundary rethrows must not retain provider error objects.
    throw new Error(
      "Failed to resolve 1Password reference; check the redacted op:// reference, vault access, and 1Password sign-in.",
    );
  }
}

function secretProviderEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const source of [process.env, env]) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || !isSecretProviderEnvKey(key)) continue;
      out[key] = value;
    }
  }
  return out;
}

function isSecretProviderEnvKey(key: string): boolean {
  return SECRET_PROVIDER_ENV_KEYS.has(key) || key.startsWith("OP_");
}

function secretResolutionTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env[SECRET_RESOLUTION_TIMEOUT_ENV] ?? process.env[SECRET_RESOLUTION_TIMEOUT_ENV];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SECRET_RESOLUTION_TIMEOUT_MS;
}

function isTimeoutError(error: unknown): boolean {
  if (!isPlainRecord(error)) return false;
  return error.timedOut === true || error.code === "ETIMEDOUT";
}

function isMissingExecutableError(error: unknown): boolean {
  if (!isPlainRecord(error)) return false;
  return error.code === "ENOENT";
}

function expandPathVariables(value: string, env: NodeJS.ProcessEnv): string {
  const name = wholeEnvName(value);
  return name === null ? value : (env[name] ?? "");
}

function wholeEnvName(value: string): string | null {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  return match?.[1] ?? null;
}
