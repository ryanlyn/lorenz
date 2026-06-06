import { execaSync } from "execa";
import { z } from "zod";
import type {
  AgentConfig,
  AgentKind,
  AgentSettings,
  AgentUsageAccounting,
  ClaudeSettings,
  CodexSettings,
  HooksSettings,
  PartialRuntimeSettings,
  Settings,
  TrackerKind,
  TrackerSettings,
} from "@symphony/domain";
import {
  TRACKER_KINDS,
  isOneOf,
  isRecord as isPlainRecord,
  normalizeHttpBindHost,
} from "@symphony/domain";

import { hooksAliases } from "./aliases.js";
import { defaultAgentRecords, defaultSettings, type DefaultSettingsOptions } from "./defaults.js";
import { configErrorMessage } from "./errors.js";
import { joinPath, nonEmptyString } from "./leaf-utils.js";
import {
  acpAgentRecordSchema,
  coercedNonNegativeTimeoutMs,
  coercedTimeoutMs,
  workflowConfigSchema,
  type AcpAgentRecordRaw,
  type AgentRaw,
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
): Settings {
  const settings = defaultSettings(defaults);
  const parsed = parseWorkflowConfig(raw);

  const trackerRaw = parsed.tracker ?? {};
  settings.tracker = parseTracker(settings.tracker, trackerRaw, env);

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
  settings.codex = parseCodex(settings.codex, parsed.codex ?? {});
  settings.claude = parseClaude(settings.claude, parsed.claude ?? {});
  settings.agents = parseAgents(parsed.agents ?? {}, settings.codex, settings.claude);
  applyKnownAgentRecords(settings);

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

  settings.statusOverrides = parseStatusOverrides(parsed.statusOverrides ?? {});
  return settings;
}

export function settingsForIssueState(settings: Settings, state: string): Settings {
  const override = settings.statusOverrides.get(normalizeStateName(state));
  if (!override) return cloneSettings(settings);

  const merged = cloneSettings(settings);
  if (override.agent) merged.agent = { ...merged.agent, ...override.agent };
  if (override.codex) merged.codex = { ...merged.codex, ...override.codex };
  if (override.claude) merged.claude = { ...merged.claude, ...override.claude };
  applyStateBackendOverridesToAgentRecords(merged, override);
  return merged;
}

export function validateDispatchConfig(settings: Settings): void {
  if (!settings.tracker.kind) throw new Error("tracker.kind is required");
  if (settings.tracker.kind === "linear") {
    if (!settings.tracker.apiKey) throw new Error("tracker.api_key is required");
    const { projectSlug, projectSlugs, projectLabels } = settings.tracker;
    const hasSlug = !!projectSlug;
    const hasSlugs = !!projectSlugs && projectSlugs.length > 0;
    const hasLabels = !!projectLabels && projectLabels.length > 0;
    const count = [hasSlug, hasSlugs, hasLabels].filter(Boolean).length;
    if (count === 0)
      throw new Error(
        "tracker.project_slug, tracker.project_slugs, or tracker.project_labels is required",
      );
    if (count > 1)
      throw new Error(
        "tracker.project_slug, tracker.project_slugs, and tracker.project_labels are mutually exclusive",
      );
  }
  if (settings.tracker.kind === "local") {
    if (!settings.tracker.path || settings.tracker.path.trim() === "") {
      throw new Error("tracker.path (board directory) is required for the local tracker");
    }
  }

  const requiredBackends = new Set<AgentKind>([settings.agent.kind]);
  for (const override of settings.statusOverrides.values()) {
    if (override.agent?.kind) requiredBackends.add(override.agent.kind);
  }
  for (const kind of requiredBackends) {
    const agent = settings.agents[kind];
    if (!agent) throw new Error(`agents.${kind} is required`);
    if (!agent.bridgeCommand.trim()) {
      throw new Error(
        kind === "claude"
          ? "claude.command is required"
          : `agents.${kind}.bridgeCommand is required`,
      );
    }
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

/**
 * Local-tracker issue-id prefixes must be filesystem-safe so `<prefix><n>.md` can never escape the
 * board dir. Mirrors BoardStore's own guard (config must not import the tracker packages, so the
 * rule is duplicated here as the user-facing validation). Default "BOARD-" satisfies it.
 */
const LOCAL_ID_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
function assertValidLocalIdPrefix(prefix: string): void {
  if (!LOCAL_ID_PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      `tracker.id_prefix ${JSON.stringify(prefix)} is invalid: ` +
        `must start alphanumeric, then only letters, digits, "_" or "-"`,
    );
  }
}

function parseTracker(
  defaults: TrackerSettings,
  trackerRaw: TrackerRaw,
  env: NodeJS.ProcessEnv,
): TrackerSettings {
  const kindRaw = trackerRaw.kind;
  const kind =
    kindRaw === undefined || kindRaw === null
      ? defaults.kind
      : trackerKindValue(kindRaw, "tracker.kind");

  const apiKey = resolveConfiguredSecret(trackerRaw.apiKey, env, "LINEAR_API_KEY");
  const projectSlug = resolveEnv(trackerRaw.projectSlug ?? "", env) || undefined;
  const assignee = resolveConfiguredSecret(trackerRaw.assignee, env, "LINEAR_ASSIGNEE");
  const idPrefix = trackerRaw.idPrefix ?? defaults.idPrefix ?? "BOARD-";
  assertValidLocalIdPrefix(idPrefix);

  const projectSlugs = trackerRaw.projectSlugs?.length ? trackerRaw.projectSlugs : undefined;
  const projectLabels = trackerRaw.projectLabels?.length ? trackerRaw.projectLabels : undefined;

  return {
    ...defaults,
    kind,
    endpoint: trackerRaw.endpoint ?? defaults.endpoint,
    path: trackerRaw.path ?? defaults.path ?? ".symphony/local",
    idPrefix,
    apiKey,
    projectSlug,
    projectSlugs,
    projectLabels,
    assignee,
    activeStates: trackerRaw.activeStates ?? defaults.activeStates,
    terminalStates: trackerRaw.terminalStates ?? defaults.terminalStates,
    dispatch: parseDispatch(defaults.dispatch, trackerRaw.dispatch ?? {}),
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

function parseAgents(
  raw: AgentsRaw,
  codex: CodexSettings,
  claude: ClaudeSettings,
): Record<string, AgentConfig> {
  const { timeoutDefaults, records } = parseAgentsRaw(raw);
  // TODO: Remove legacy top-level codex/claude timeout fallbacks after configs use shared agents-level timeout defaults.
  const baseAgents = withAgentTimeoutDefaults(defaultAgentRecords(codex, claude), timeoutDefaults);
  const agents = cloneAgentRecords(baseAgents);
  const claudeDefaults = baseAgents.claude!;
  for (const [name, value] of Object.entries(records)) {
    const normalized = name.trim();
    if (!normalized) throw new Error("agents names must not be blank");
    const recordRaw = asRecord(value, `agents.${normalized}`);
    const executor = recordRaw.executor;
    if (executor !== undefined && executor !== "acp") {
      throw new Error(`unsupported agents.${normalized}.executor: ${JSON.stringify(executor)}`);
    }
    const parsed = parseAgentRecordSchema(
      { ...recordRaw, executor: "acp" },
      `agents.${normalized}`,
    );
    const defaults = baseAgents[normalized] ?? claudeDefaults;
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

function parseAgentRecordSchema(raw: Record<string, unknown>, label: string) {
  const result = acpAgentRecordSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new Error(configErrorMessage(result.error, label));
}

function parseAgent(kind: AgentKind, raw: AcpAgentRecordRaw, defaults: AgentConfig): AgentConfig {
  const bridgeCommand = raw.bridgeCommand ?? raw.command ?? defaults.bridgeCommand;
  return {
    executor: "acp",
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

function applyKnownAgentRecords(settings: Settings): void {
  const claude = settings.agents.claude;
  if (claude?.executor === "acp") {
    settings.claude = {
      command: claude.bridgeCommand,
      turnTimeoutMs: claude.turnTimeoutMs,
      stallTimeoutMs: claude.stallTimeoutMs,
      strictMcpConfig: claude.strictMcpConfig ?? settings.claude.strictMcpConfig,
      providerConfig: claude.providerConfig ?? settings.claude.providerConfig,
    };
  }
}

function parseCodex(defaults: CodexSettings, codexRaw: CodexRaw): CodexSettings {
  return {
    command: codexRaw.command ?? defaults.command,
    turnTimeoutMs: codexRaw.turnTimeoutMs ?? defaults.turnTimeoutMs,
    stallTimeoutMs: codexRaw.stallTimeoutMs ?? defaults.stallTimeoutMs,
  };
}

function parseClaude(defaults: ClaudeSettings, claudeRaw: ClaudeRaw): ClaudeSettings {
  return {
    command: claudeRaw.command ?? defaults.command,
    turnTimeoutMs: claudeRaw.turnTimeoutMs ?? defaults.turnTimeoutMs,
    stallTimeoutMs: claudeRaw.stallTimeoutMs ?? defaults.stallTimeoutMs,
    strictMcpConfig: claudeRaw.strictMcpConfig ?? defaults.strictMcpConfig,
    providerConfig: claudeRaw.providerConfig ?? defaults.providerConfig,
  };
}

function parseStatusOverrides(raw: StatusOverridesRaw): Map<string, PartialRuntimeSettings> {
  const overrides = new Map<string, PartialRuntimeSettings>();

  for (const [stateName, value] of Object.entries(raw)) {
    const normalizedState = normalizeStateName(stateName);
    if (!normalizedState) throw new Error("status_overrides state names must not be blank");

    const next: PartialRuntimeSettings = {};
    if (value.agent !== undefined) next.agent = parsePartialAgent(value.agent);
    if (value.codex !== undefined) next.codex = parsePartialCodex(value.codex);
    if (value.claude !== undefined) next.claude = parsePartialClaude(value.claude);
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

function parsePartialCodex(raw: Partial<CodexRaw>): Partial<CodexSettings> {
  const next: Partial<CodexSettings> = {};
  if (raw.command !== undefined) next.command = raw.command;
  if (raw.turnTimeoutMs !== undefined) next.turnTimeoutMs = raw.turnTimeoutMs;
  if (raw.stallTimeoutMs !== undefined) next.stallTimeoutMs = raw.stallTimeoutMs;
  return next;
}

function parsePartialClaude(raw: Partial<ClaudeRaw>): Partial<ClaudeSettings> {
  const next: Partial<ClaudeSettings> = {};
  if (raw.command !== undefined) next.command = raw.command;
  if (raw.strictMcpConfig !== undefined) next.strictMcpConfig = raw.strictMcpConfig;
  if (raw.turnTimeoutMs !== undefined) next.turnTimeoutMs = raw.turnTimeoutMs;
  if (raw.stallTimeoutMs !== undefined) next.stallTimeoutMs = raw.stallTimeoutMs;
  if (raw.providerConfig !== undefined) next.providerConfig = raw.providerConfig;
  return next;
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
    codex: { ...settings.codex },
    claude: { ...settings.claude },
    observability: { ...settings.observability },
    server: { ...settings.server },
    logging: { ...settings.logging },
    statusOverrides: new Map(settings.statusOverrides),
  };
}

function applyStateBackendOverridesToAgentRecords(
  settings: Settings,
  override: PartialRuntimeSettings,
): void {
  if (override.codex) {
    const codex = settings.agents.codex;
    if (codex) {
      settings.agents.codex = {
        ...codex,
        ...(override.codex.command !== undefined ? { bridgeCommand: settings.codex.command } : {}),
        ...(override.codex.turnTimeoutMs !== undefined
          ? { turnTimeoutMs: settings.codex.turnTimeoutMs }
          : {}),
        ...(override.codex.stallTimeoutMs !== undefined
          ? { stallTimeoutMs: settings.codex.stallTimeoutMs }
          : {}),
      };
    }
  }

  if (override.claude) {
    const claude = settings.agents.claude;
    if (claude) {
      settings.agents.claude = {
        ...claude,
        ...(override.claude.command !== undefined
          ? { bridgeCommand: settings.claude.command }
          : {}),
        ...(override.claude.turnTimeoutMs !== undefined
          ? { turnTimeoutMs: settings.claude.turnTimeoutMs }
          : {}),
        ...(override.claude.stallTimeoutMs !== undefined
          ? { stallTimeoutMs: settings.claude.stallTimeoutMs }
          : {}),
        ...(override.claude.strictMcpConfig !== undefined
          ? { strictMcpConfig: settings.claude.strictMcpConfig }
          : {}),
        ...(override.claude.providerConfig !== undefined
          ? { providerConfig: settings.claude.providerConfig }
          : {}),
      };
    }
  }
}

/**
 * Deep-copy mutable tracker collections (dispatch and state lists) so per-issue-state clones
 * cannot mutate the shared base config.
 */
function cloneTracker(tracker: TrackerSettings): TrackerSettings {
  return {
    ...tracker,
    dispatch: { ...tracker.dispatch },
    activeStates: [...tracker.activeStates],
    terminalStates: [...tracker.terminalStates],
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

function trackerKindValue(value: unknown, label: string): TrackerKind {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (isOneOf(value, TRACKER_KINDS)) return value;
  throw new Error(`unsupported ${label}: ${value}`);
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
  fallbackEnvName: string,
): string | undefined {
  if (value === undefined) {
    const fallback = nonEmptyString(env[fallbackEnvName]);
    return resolveOnePasswordRef(fallback, env);
  }
  const resolved = resolveEnv(value, env);
  const secret = nonEmptyString(resolved) ?? nonEmptyString(env[fallbackEnvName]);
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
