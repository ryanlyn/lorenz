import { execaSync } from "execa";
import { z } from "zod";
import type {
  AgentConfig,
  AgentKind,
  AgentSettings,
  AgentUsageAccounting,
  HooksSettings,
  PartialRuntimeSettings,
  Settings,
  TrackerSettings,
} from "@symphony/domain";
import { isRecord as isPlainRecord, normalizeHttpBindHost } from "@symphony/domain";
import { defaultAgentExecutorRegistry, type AgentExecutorRegistry } from "@symphony/agent-sdk";
import type { ToolRegistry } from "@symphony/tool-sdk";
import { defaultTrackerRegistry, type TrackerRegistry } from "@symphony/tracker-sdk";

import { hooksAliases, normalizeAliases } from "./aliases.js";
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
  type ClaudeRaw,
  type CodexRaw,
  type DispatchRaw,
  type HooksRaw,
  type StatusOverridesRaw,
  type TrackerRaw,
  type WorkflowConfigRaw,
} from "./schemas.js";

export function parseConfig(
  raw: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
  defaults: DefaultSettingsOptions = {},
  registry: TrackerRegistry = defaultTrackerRegistry,
): Settings {
  const settings = defaultSettings(defaults);
  const parsed = parseWorkflowConfig(raw);

  const trackerRaw = parsed.tracker ?? {};
  settings.tracker = parseTracker(settings.tracker, trackerRaw, env, registry);
  if (parsed.tools !== undefined) settings.tools = [...parsed.tools];

  const pollingRaw = parsed.polling ?? {};
  settings.polling.intervalMs = pollingRaw.intervalMs ?? settings.polling.intervalMs;

  const workspaceRaw = parsed.workspace ?? {};
  const workspaceRootFallback = settings.workspace.rootExpression ?? settings.workspace.root;
  const workspaceRootExpression = resolveWorkspaceRootExpression(
    nonEmptyString(env.SYMPHONY_WORKSPACE_ROOT) ?? workspaceRaw.root,
    workspaceRootFallback,
    env,
  );
  settings.workspace.rootExpression = workspaceRootExpression;
  settings.workspace.root = expandLocalPath(workspaceRootExpression, env);
  settings.workspace.isolation = workspaceRaw.isolation ?? settings.workspace.isolation;

  const workerRaw = parsed.worker ?? {};
  settings.worker.sshHosts = workerRaw.sshHosts ?? settings.worker.sshHosts;
  settings.worker.sshTimeoutMs = workerRaw.sshTimeoutMs ?? settings.worker.sshTimeoutMs;
  if (workerRaw.maxConcurrentAgentsPerHost !== undefined) {
    settings.worker.maxConcurrentAgentsPerHost = workerRaw.maxConcurrentAgentsPerHost;
  }

  settings.hooks = parseHooks(settings.hooks, parsed.hooks ?? {});
  if (settings.workspace.isolation === "none") assertNoWorkspaceHooks(settings.hooks);
  settings.agent = parseAgentSettings(settings.agent, parsed.agent ?? {});
  settings.agents = parseAgents(
    parsed.agents ?? {},
    legacyAgentRecordOverrides(parsed.codex ?? {}, parsed.claude ?? {}),
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

  settings.statusOverrides = parseStatusOverrides(parsed.statusOverrides ?? {}, settings.agents);
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
      merged.agents[kind] = { ...base, ...fragment };
    }
  }
  return merged;
}

export function validateDispatchConfig(
  settings: Settings,
  trackers: TrackerRegistry = defaultTrackerRegistry,
  executors: AgentExecutorRegistry = defaultAgentExecutorRegistry,
  tools?: ToolRegistry,
): void {
  const provider = trackers.require(settings.tracker.kind);
  provider.validateDispatch?.(settings);

  if (tools && settings.tools !== undefined) {
    for (const name of settings.tools) tools.require(name);
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

export function normalizeStateName(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeRouteName(value: unknown): string {
  if (value === undefined || value === null) return "";
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value).trim().toLowerCase();
}

/** Keys of the tracker config section owned by the core; everything else belongs to the provider. */
const TRACKER_COMMON_KEYS = new Set([
  "kind",
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
  env: NodeJS.ProcessEnv,
  registry: TrackerRegistry,
): TrackerSettings {
  const kind = trackerKindValue(trackerRaw.kind) ?? defaults.kind;
  // Unregistered kinds parse generically (options pass through unvalidated) and are
  // rejected with the full list of known kinds by validateDispatchConfig.
  const provider = registry.get(kind);

  const apiKey = resolveConfiguredSecret(trackerRaw.apiKey, env, provider?.envFallbacks?.apiKey);
  const assignee = resolveConfiguredSecret(
    trackerRaw.assignee,
    env,
    provider?.envFallbacks?.assignee,
  );
  const endpoint = trackerRaw.endpoint ?? provider?.defaultEndpoint ?? defaults.endpoint;

  const providerRaw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(trackerRaw)) {
    if (!TRACKER_COMMON_KEYS.has(key)) providerRaw[key] = value;
  }
  const aliased = normalizeAliases(providerRaw, { ...(provider?.configAliases ?? {}) });
  const options = provider?.parseOptions
    ? provider.parseOptions(aliased, {
        env,
        resolveSecret: (value, fallbackEnvVar) =>
          resolveConfiguredSecret(value, env, fallbackEnvVar),
      })
    : aliased;

  return {
    kind,
    endpoint,
    apiKey,
    assignee,
    activeStates: trackerRaw.activeStates ?? defaults.activeStates,
    terminalStates: trackerRaw.terminalStates ?? defaults.terminalStates,
    dispatch: parseDispatch(defaults.dispatch, trackerRaw.dispatch ?? {}),
    options,
  };
}

function expandLocalPath(value: string, env: NodeJS.ProcessEnv): string {
  const expanded = expandPathVariables(value, env);
  const home = nonEmptyString(env.HOME) ?? nonEmptyString(env.USERPROFILE);
  if (home && expanded === "~") return home;
  if (home && expanded.startsWith("~/")) return joinPath(home, expanded.slice(2));
  return expanded;
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

function parseHooks(defaults: HooksSettings, hooksRaw: HooksRaw): HooksSettings {
  return {
    afterCreate: hooksRaw.afterCreate ?? null,
    beforeRun: hooksRaw.beforeRun ?? null,
    afterRun: hooksRaw.afterRun ?? null,
    beforeRemove: hooksRaw.beforeRemove ?? null,
    timeoutMs: hooksRaw.timeoutMs ?? defaults.timeoutMs,
  };
}

function parseAgentSettings(defaults: AgentSettings, agentRaw: AgentRaw): AgentSettings {
  const kind = agentRaw.kind ?? defaults.kind;

  return {
    kind,
    maxConcurrentAgents: agentRaw.maxConcurrentAgents ?? defaults.maxConcurrentAgents,
    maxTurns: agentRaw.maxTurns ?? defaults.maxTurns,
    maxRetryBackoffMs: agentRaw.maxRetryBackoffMs ?? defaults.maxRetryBackoffMs,
    ensembleSize: agentRaw.ensembleSize ?? defaults.ensembleSize,
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

/** Translate legacy backend-section keys (`command`, ...) into agent-record fields. */
function agentRecordFragment(raw: Partial<CodexRaw & ClaudeRaw>): Partial<AgentConfig> {
  return {
    ...(raw.command !== undefined ? { bridgeCommand: raw.command } : {}),
    ...(raw.turnTimeoutMs !== undefined ? { turnTimeoutMs: raw.turnTimeoutMs } : {}),
    ...(raw.stallTimeoutMs !== undefined ? { stallTimeoutMs: raw.stallTimeoutMs } : {}),
    ...(raw.strictMcpConfig !== undefined ? { strictMcpConfig: raw.strictMcpConfig } : {}),
    ...(raw.providerConfig !== undefined ? { providerConfig: raw.providerConfig } : {}),
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
  const baseModel = base.providerConfig?.model;
  const model = raw.model ?? baseModel;
  fragment.providerConfig = raw.providerConfig
    ? { ...(model !== undefined ? { model } : {}), ...raw.providerConfig }
    : { ...base.providerConfig, ...(model !== undefined ? { model } : {}) };
  return fragment;
}

function parseAgents(
  raw: AgentsRaw,
  legacyOverrides: Record<string, Partial<AgentConfig>>,
): Record<string, AgentConfig> {
  const { timeoutDefaults, records } = parseAgentsRaw(raw);
  const base = defaultAgentRecords();
  for (const [kind, fragment] of Object.entries(legacyOverrides)) {
    const record = base[kind];
    if (record) base[kind] = { ...record, ...fragment };
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
    const defaults = baseAgents[normalized] ?? customAgentDefaultsForBridge(parsed, claudeDefaults);
    agents[normalized] = parseAgent(normalized, parsed, defaults);
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

function customAgentDefaultsForBridge(
  raw: AgentRecordRaw,
  claudeDefaults: AgentConfig,
): AgentConfig {
  const bridgeCommand = raw.bridgeCommand ?? raw.command ?? claudeDefaults.bridgeCommand;
  return {
    ...claudeDefaults,
    providerConfig: isClaudeCompatibleBridgeCommand(bridgeCommand)
      ? claudeDefaults.providerConfig
      : undefined,
  };
}

function parseAgentRecordSchema(raw: Record<string, unknown>, label: string) {
  const result = agentRecordSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new Error(configErrorMessage(result.error, label));
}

function parseAgent(kind: AgentKind, raw: AgentRecordRaw, defaults: AgentConfig): AgentConfig {
  const bridgeCommand = raw.bridgeCommand ?? raw.command ?? defaults.bridgeCommand;
  return {
    executor: raw.executor ?? defaults.executor,
    bridgeCommand,
    usageAccounting: raw.usageAccounting ?? inferUsageAccounting(kind, bridgeCommand),
    providerConfig: raw.providerConfig ?? defaults.providerConfig,
    turnTimeoutMs: raw.turnTimeoutMs ?? defaults.turnTimeoutMs,
    stallTimeoutMs: raw.stallTimeoutMs ?? defaults.stallTimeoutMs,
    strictMcpConfig: raw.strictMcpConfig ?? defaults.strictMcpConfig ?? true,
  };
}

function inferUsageAccounting(kind: AgentKind, bridgeCommand: string): AgentUsageAccounting {
  if (kind === "codex" || kind === "claude") return "per-turn";
  if (/(^|\s|\/)(codex-acp|claude-agent-acp)(\s|$)/.test(bridgeCommand)) return "per-turn";
  return "cumulative";
}

function isClaudeCompatibleBridgeCommand(bridgeCommand: string): boolean {
  return /(^|\s|\/)claude-agent-acp(\s|$)/.test(bridgeCommand);
}

function parseStatusOverrides(
  raw: StatusOverridesRaw,
  baseAgents: Record<string, AgentConfig>,
): Map<string, PartialRuntimeSettings> {
  const overrides = new Map<string, PartialRuntimeSettings>();

  for (const [stateName, value] of Object.entries(raw)) {
    const normalizedState = normalizeStateName(stateName);
    if (!normalizedState) throw new Error("status_overrides state names must not be blank");

    const next: PartialRuntimeSettings = {};
    if (value.agent !== undefined) next.agent = parsePartialAgent(value.agent);
    const agents = parseStatusOverrideAgents(normalizedState, value, baseAgents);
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
): Record<string, Partial<AgentConfig>> {
  const agents: Record<string, Partial<AgentConfig>> = {};
  for (const [kind, recordRaw] of Object.entries(value.agents ?? {})) {
    const normalizedKind = kind.trim();
    if (!normalizedKind) throw new Error("status_overrides agents names must not be blank");
    const result = agentRecordOverrideSchema.safeParse(recordRaw);
    if (!result.success) {
      throw new Error(
        configErrorMessage(result.error, `status_overrides.${state}.agents.${normalizedKind}`),
      );
    }
    agents[normalizedKind] = agentRecordOverrideFragment(result.data);
  }
  if (value.codex !== undefined) {
    agents.codex = { ...agentRecordFragment(value.codex), ...agents.codex };
  }
  if (value.claude !== undefined) {
    const fragment = agentRecordFragment(value.claude);
    // A model override re-pins the provider config unless the override supplies its own.
    const base = baseAgents.claude;
    if (value.claude.model !== undefined && value.claude.providerConfig === undefined && base) {
      fragment.providerConfig = { ...base.providerConfig, model: value.claude.model };
    }
    agents.claude = { ...fragment, ...agents.claude };
  }
  return agents;
}

function agentRecordOverrideFragment(raw: AgentRecordOverrideRaw): Partial<AgentConfig> {
  return {
    ...agentRecordFragment(raw),
    ...(raw.bridgeCommand !== undefined ? { bridgeCommand: raw.bridgeCommand } : {}),
    ...(raw.usageAccounting !== undefined ? { usageAccounting: raw.usageAccounting } : {}),
  };
}

function cloneSettings(settings: Settings): Settings {
  return {
    ...settings,
    tracker: cloneTracker(settings.tracker),
    polling: { ...settings.polling },
    workspace: { ...settings.workspace },
    worker: { ...settings.worker, sshHosts: [...settings.worker.sshHosts] },
    hooks: { ...settings.hooks },
    agent: { ...settings.agent },
    agents: cloneAgentRecords(settings.agents),
    observability: { ...settings.observability },
    server: { ...settings.server },
    logging: { ...settings.logging },
    statusOverrides: new Map(settings.statusOverrides),
  };
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
    cloned[name] = {
      ...record,
      providerConfig: record.providerConfig ? structuredClone(record.providerConfig) : undefined,
    };
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
): string | undefined {
  const fallback = fallbackEnvName === undefined ? undefined : nonEmptyString(env[fallbackEnvName]);
  if (value === undefined) {
    return resolveOnePasswordRef(fallback, env);
  }
  const resolved = resolveEnv(value, env);
  const secret = nonEmptyString(resolved) ?? fallback;
  return resolveOnePasswordRef(secret, env);
}

function resolveOnePasswordRef(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (value === undefined || !value.startsWith("op://")) return value;
  const mergedEnv = { ...process.env, ...env };
  try {
    execaSync("op", ["--version"], { env: mergedEnv });
  } catch {
    throw new Error(
      "1Password CLI (op) is required to resolve op:// references but was not found. " +
        "Install it from https://developer.1password.com/docs/cli/get-started - it cannot be managed by mise.",
    );
  }
  try {
    const result = execaSync("op", ["read", value], { env: mergedEnv });
    return result.stdout.trim();
  } catch {
    throw new Error(`Failed to resolve 1Password reference: ${value}`);
  }
}

function expandPathVariables(value: string, env: NodeJS.ProcessEnv): string {
  const name = wholeEnvName(value);
  return name === null ? value : (env[name] ?? "");
}

function wholeEnvName(value: string): string | null {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  return match?.[1] ?? null;
}
