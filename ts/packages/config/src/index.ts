import { execaSync } from "execa";
import { z } from "zod";
import type {
  AgentKind,
  AgentConfig,
  AgentSettings,
  AcpAgentConfig,
  AppServerAgentConfig,
  ClaudeSettings,
  CodexSettings,
  HooksSettings,
  PartialRuntimeSettings,
  Settings,
  TrackerKind,
  TrackerSettings,
} from "@symphony/domain";
import {
  CODEX_APPROVAL_POLICY_NAMES,
  CODEX_SANDBOX_MODES,
  TRACKER_KINDS,
  PORT_MAX,
  ONE_WEEK_MS,
  RENDER_INTERVAL_MAX_MS,
  CONCURRENCY_MAX,
  MAX_TURNS_MAX,
  ENSEMBLE_SIZE_MAX,
  isValidPort,
  isValidTimeoutMs,
  isValidNonNegativeTimeoutMs,
  isValidIntervalMs,
  isValidRenderIntervalMs,
  isValidConcurrency,
  isValidMaxTurns,
  isValidEnsembleSize,
} from "@symphony/domain";

export {
  PORT_MAX,
  ONE_WEEK_MS,
  RENDER_INTERVAL_MAX_MS,
  CONCURRENCY_MAX,
  MAX_TURNS_MAX,
  ENSEMBLE_SIZE_MAX,
} from "@symphony/domain";

const numericInput = z.union([
  z.number().refine((n) => !Number.isNaN(n), { message: "must not be NaN" }),
  z
    .string()
    .refine((s) => s.trim() !== "", { message: "must not be empty" })
    .transform(Number)
    .refine((n) => !Number.isNaN(n), { message: "must be a number" }),
]);

const coercedPort = numericInput
  .refine((n) => isValidPort(n), {
    message: `must be a valid port number (0-${PORT_MAX})`,
  })
  .describe("non-negative");

const coercedTimeoutMs = numericInput
  .refine((n) => isValidTimeoutMs(n), {
    message: `must be a positive integer no greater than ${ONE_WEEK_MS} (1 week)`,
  })
  .describe("positive");

const coercedNonNegativeTimeoutMs = numericInput
  .refine((n) => isValidNonNegativeTimeoutMs(n), {
    message: `must be a non-negative integer no greater than ${ONE_WEEK_MS} (1 week)`,
  })
  .describe("non-negative");

const coercedIntervalMs = numericInput
  .refine((n) => isValidIntervalMs(n), {
    message: `must be a positive integer no greater than ${ONE_WEEK_MS} (1 week)`,
  })
  .describe("positive");

const coercedRenderIntervalMs = numericInput
  .refine((n) => isValidRenderIntervalMs(n), {
    message: `must be a positive integer no greater than ${RENDER_INTERVAL_MAX_MS}`,
  })
  .describe("positive");

const coercedConcurrency = numericInput
  .refine((n) => isValidConcurrency(n), {
    message: `must be an integer between 1 and ${CONCURRENCY_MAX}`,
  })
  .describe("positive");

const coercedMaxTurns = numericInput
  .refine((n) => isValidMaxTurns(n), {
    message: `must be an integer between 1 and ${MAX_TURNS_MAX}`,
  })
  .describe("positive");

const coercedEnsembleSize = numericInput
  .refine((n) => isValidEnsembleSize(n), {
    message: `must be an integer between 1 and ${ENSEMBLE_SIZE_MAX}`,
  })
  .describe("positive");

const coercedBoolean = z.union([
  z.boolean(),
  z.literal("true").transform(() => true),
  z.literal("false").transform(() => false),
]);

const approvalPolicySchema = z.union([z.string(), z.record(z.string(), z.unknown())]).optional();
const sandboxPolicySchema = z.record(z.string(), z.unknown()).nullable().optional();

const optionalHookScript = z.string().nullable().optional();

const appServerAgentRecordSchema = z
  .object({
    executor: z.literal("appserver"),
    command: z.string().optional(),
    approvalPolicy: approvalPolicySchema,
    threadSandbox: z.string().optional(),
    turnSandboxPolicy: sandboxPolicySchema,
    turnTimeoutMs: coercedTimeoutMs.optional(),
    readTimeoutMs: coercedTimeoutMs.optional(),
    stallTimeoutMs: coercedNonNegativeTimeoutMs.optional(),
  })
  .strict();
const acpAgentRecordSchema = z
  .object({
    executor: z.literal("acp"),
    bridgeCommand: z.string().optional(),
    bridgeArgs: z.array(z.string()).optional(),
    command: z.string().optional(),
    model: z.string().optional(),
    permissionMode: z.string().optional(),
    turnTimeoutMs: coercedTimeoutMs.optional(),
    stallTimeoutMs: coercedNonNegativeTimeoutMs.optional(),
    strictMcpConfig: coercedBoolean.optional(),
  })
  .strict();
const agentRecordSchema = z.discriminatedUnion("executor", [
  appServerAgentRecordSchema,
  acpAgentRecordSchema,
]);

const trackerRawSchema = z
  .object({
    kind: z.string().optional(),
    endpoint: z.string().optional(),
    apiKey: z.string().optional(),
    projectSlug: z.string().optional(),
    assignee: z.string().optional(),
    activeStates: z.array(z.string()).optional(),
    terminalStates: z.array(z.string()).optional(),
    dispatch: z
      .object({
        acceptUnrouted: coercedBoolean.optional(),
        onlyRoutes: z.array(z.string()).nullable().optional(),
        routeLabelPrefix: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const pollingRawSchema = z.object({ intervalMs: coercedIntervalMs.optional() }).strict();
const workspaceRawSchema = z.object({ root: z.string().optional() }).strict();
const workerRawSchema = z
  .object({
    sshHosts: z.array(z.string()).optional(),
    sshTimeoutMs: coercedTimeoutMs.optional(),
    maxConcurrentAgentsPerHost: coercedConcurrency.optional(),
  })
  .strict();
const hooksRawSchema = z
  .object({
    afterCreate: optionalHookScript,
    beforeRun: optionalHookScript,
    afterRun: optionalHookScript,
    beforeRemove: optionalHookScript,
    timeoutMs: coercedTimeoutMs.optional(),
  })
  .strict();
const agentRawSchema = z
  .object({
    kind: z.string().optional(),
    maxConcurrentAgents: coercedConcurrency.optional(),
    maxTurns: coercedMaxTurns.optional(),
    maxRetryBackoffMs: coercedTimeoutMs.optional(),
    ensembleSize: coercedEnsembleSize.optional(),
  })
  .strict();
const codexRawSchema = z
  .object({
    command: z.string().optional(),
    approvalPolicy: approvalPolicySchema,
    threadSandbox: z.string().optional(),
    turnSandboxPolicy: sandboxPolicySchema,
    turnTimeoutMs: coercedTimeoutMs.optional(),
    readTimeoutMs: coercedTimeoutMs.optional(),
    stallTimeoutMs: coercedNonNegativeTimeoutMs.optional(),
  })
  .strict();
const claudeRawSchema = z
  .object({
    command: z.string().optional(),
    model: z.string().optional(),
    permissionMode: z.string().optional(),
    turnTimeoutMs: coercedTimeoutMs.optional(),
    stallTimeoutMs: coercedNonNegativeTimeoutMs.optional(),
    strictMcpConfig: coercedBoolean.optional(),
  })
  .strict();
const observabilityRawSchema = z
  .object({
    dashboardEnabled: coercedBoolean.optional(),
    refreshMs: coercedIntervalMs.optional(),
    renderIntervalMs: coercedRenderIntervalMs.optional(),
  })
  .strict();
const serverRawSchema = z
  .object({
    host: z.string().optional(),
    port: coercedPort.optional(),
  })
  .strict();
const loggingRawSchema = z.object({ logFile: z.string().optional() }).strict();
const rawRecordSchema = z.record(z.string(), z.unknown());
const partialAgentRawSchema = agentRawSchema.partial().strict();
const partialCodexRawSchema = codexRawSchema.partial().strict();
const partialClaudeRawSchema = claudeRawSchema.partial().strict();
const statusOverrideRawSchema = z
  .object({
    agent: partialAgentRawSchema.optional(),
    codex: partialCodexRawSchema.optional(),
    claude: partialClaudeRawSchema.optional(),
  })
  .strict();

const workflowConfigSchema = z.preprocess(
  normalizeWorkflowConfig,
  z
    .object({
      tracker: trackerRawSchema.optional(),
      polling: pollingRawSchema.optional(),
      workspace: workspaceRawSchema.optional(),
      worker: workerRawSchema.optional(),
      hooks: hooksRawSchema.optional(),
      agent: agentRawSchema.optional(),
      agents: z.record(z.string(), rawRecordSchema).optional(),
      codex: codexRawSchema.optional(),
      claude: claudeRawSchema.optional(),
      observability: observabilityRawSchema.optional(),
      server: serverRawSchema.optional(),
      logging: loggingRawSchema.optional(),
      statusOverrides: z.record(z.string(), statusOverrideRawSchema).optional(),
    })
    .passthrough(),
);

type WorkflowConfigRaw = z.infer<typeof workflowConfigSchema>;
type TrackerRaw = z.infer<typeof trackerRawSchema>;
type DispatchRaw = NonNullable<TrackerRaw["dispatch"]>;
type HooksRaw = z.infer<typeof hooksRawSchema>;
type AgentRaw = z.infer<typeof agentRawSchema>;
type CodexRaw = z.infer<typeof codexRawSchema>;
type ClaudeRaw = z.infer<typeof claudeRawSchema>;
type StatusOverridesRaw = NonNullable<WorkflowConfigRaw["statusOverrides"]>;

const trackerAliases = {
  api_key: "apiKey",
  project_slug: "projectSlug",
  active_states: "activeStates",
  terminal_states: "terminalStates",
};
const dispatchAliases = {
  accept_unrouted: "acceptUnrouted",
  only_routes: "onlyRoutes",
  route_label_prefix: "routeLabelPrefix",
};
const pollingAliases = { interval_ms: "intervalMs" };
const workspaceAliases = {};
const workerAliases = {
  ssh_hosts: "sshHosts",
  ssh_timeout_ms: "sshTimeoutMs",
  max_concurrent_agents_per_host: "maxConcurrentAgentsPerHost",
};
const hooksAliases = {
  after_create: "afterCreate",
  before_run: "beforeRun",
  after_run: "afterRun",
  before_remove: "beforeRemove",
  timeout_ms: "timeoutMs",
};
const agentAliases = {
  max_concurrent_agents: "maxConcurrentAgents",
  max_turns: "maxTurns",
  max_retry_backoff_ms: "maxRetryBackoffMs",
  ensemble_size: "ensembleSize",
};
const codexAliases = {
  approval_policy: "approvalPolicy",
  thread_sandbox: "threadSandbox",
  turn_sandbox_policy: "turnSandboxPolicy",
  turn_timeout_ms: "turnTimeoutMs",
  read_timeout_ms: "readTimeoutMs",
  stall_timeout_ms: "stallTimeoutMs",
};
const claudeAliases = {
  permission_mode: "permissionMode",
  turn_timeout_ms: "turnTimeoutMs",
  stall_timeout_ms: "stallTimeoutMs",
  strict_mcp_config: "strictMcpConfig",
};
const acpAgentAliases = {
  bridge_command: "bridgeCommand",
  bridge_args: "bridgeArgs",
};
const agentRecordAliases = {
  ...codexAliases,
  ...claudeAliases,
  ...acpAgentAliases,
};
const observabilityAliases = {
  dashboard_enabled: "dashboardEnabled",
  refresh_ms: "refreshMs",
  render_interval_ms: "renderIntervalMs",
};
const loggingAliases = { log_file: "logFile" };

export interface DefaultSettingsOptions {
  tmpdir?: string | undefined;
  cwd?: string | undefined;
}

export const defaultSettings = (options: DefaultSettingsOptions = {}): Settings => {
  const tmpdir = options.tmpdir ?? "/tmp";
  const cwd = options.cwd ?? ".";
  const workspaceRoot = joinPath(tmpdir, "symphony_workspaces");
  const codex: CodexSettings = {
    command: "codex app-server",
    approvalPolicy: {
      reject: {
        sandbox_approval: true,
        rules: true,
        mcp_elicitations: true,
      },
    },
    threadSandbox: "workspace-write",
    turnSandboxPolicy: null,
    turnTimeoutMs: 3_600_000,
    readTimeoutMs: 5_000,
    stallTimeoutMs: 300_000,
  };
  const claude: ClaudeSettings = {
    command: "claude-agent-acp",
    model: "claude-opus-4-6[1m]",
    permissionMode: "dontAsk",
    turnTimeoutMs: 3_600_000,
    stallTimeoutMs: 300_000,
    strictMcpConfig: true,
  };
  return {
    tracker: {
      kind: undefined,
      endpoint: "https://api.linear.app/graphql",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
      dispatch: {
        acceptUnrouted: true,
        onlyRoutes: null,
        routeLabelPrefix: "Symphony:",
      },
    },
    polling: { intervalMs: 30_000 },
    workspace: {
      root: workspaceRoot,
      rootExpression: workspaceRoot,
    },
    worker: { sshHosts: [], sshTimeoutMs: 60_000 },
    hooks: { timeoutMs: 60_000 },
    agent: {
      kind: "codex",
      maxConcurrentAgents: 10,
      maxTurns: 20,
      maxRetryBackoffMs: 300_000,
      ensembleSize: 1,
    },
    agents: defaultAgentRecords(codex, claude),
    codex,
    claude,
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    server: { host: "127.0.0.1" },
    logging: { logFile: joinPath(cwd, "log/symphony.log") },
    statusOverrides: new Map(),
  };
};

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

  const workerRaw = parsed.worker ?? {};
  settings.worker.sshHosts = workerRaw.sshHosts ?? settings.worker.sshHosts;
  settings.worker.sshTimeoutMs = workerRaw.sshTimeoutMs ?? settings.worker.sshTimeoutMs;
  if (workerRaw.maxConcurrentAgentsPerHost !== undefined) {
    settings.worker.maxConcurrentAgentsPerHost = workerRaw.maxConcurrentAgentsPerHost;
  }

  settings.hooks = parseHooks(settings.hooks, parsed.hooks ?? {});
  settings.agent = parseAgent(settings.agent, parsed.agent ?? {});
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
  settings.server.host = serverRaw.host ?? settings.server.host;
  if (serverRaw.port !== undefined) settings.server.port = serverRaw.port;

  settings.statusOverrides = parseStatusOverrides(parsed.statusOverrides ?? {});
  return settings;
}

function joinPath(root: string, child: string): string {
  if (root === "") return child;
  return `${root.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}

export function settingsForIssueState(settings: Settings, state: string): Settings {
  const override = settings.statusOverrides.get(normalizeStateName(state));
  if (!override) return cloneSettings(settings);

  const merged = cloneSettings(settings);
  if (override.agent) merged.agent = { ...merged.agent, ...override.agent };
  if (override.codex) merged.codex = mergeCodex(merged.codex, override.codex);
  if (override.claude) merged.claude = { ...merged.claude, ...override.claude };
  return merged;
}

export function validateDispatchConfig(settings: Settings): void {
  if (!settings.tracker.kind) throw new Error("tracker.kind is required");
  if (settings.tracker.kind === "linear") {
    if (!settings.tracker.apiKey) throw new Error("tracker.api_key is required");
    if (!settings.tracker.projectSlug) throw new Error("tracker.project_slug is required");
  }

  const requiredBackends = new Set<AgentKind>([settings.agent.kind]);
  for (const override of settings.statusOverrides.values()) {
    if (override.agent?.kind) requiredBackends.add(override.agent.kind);
  }
  for (const kind of requiredBackends) {
    const agent = settings.agents[kind];
    if (!agent) throw new Error(`agents.${kind} is required`);
    if (agent.executor === "appserver" && !agent.command.trim()) {
      throw new Error(`${kind}.command is required`);
    }
    if (agent.executor === "acp" && !agent.bridgeCommand.trim()) {
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

  return {
    ...defaults,
    kind,
    endpoint: trackerRaw.endpoint ?? defaults.endpoint,
    apiKey,
    projectSlug,
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

function parseHooks(defaults: HooksSettings, hooksRaw: HooksRaw): HooksSettings {
  return {
    afterCreate: hooksRaw.afterCreate ?? null,
    beforeRun: hooksRaw.beforeRun ?? null,
    afterRun: hooksRaw.afterRun ?? null,
    beforeRemove: hooksRaw.beforeRemove ?? null,
    timeoutMs: hooksRaw.timeoutMs ?? defaults.timeoutMs,
  };
}

function parseAgent(defaults: AgentSettings, agentRaw: AgentRaw): AgentSettings {
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
  raw: Record<string, unknown>,
  codex: CodexSettings,
  claude: ClaudeSettings,
): Record<string, AgentConfig> {
  const baseAgents = defaultAgentRecords(codex, claude);
  const agents = cloneAgentRecords(baseAgents);
  for (const [name, value] of Object.entries(raw)) {
    const normalized = name.trim();
    if (!normalized) throw new Error("agents names must not be blank");
    const recordRaw = asRecord(value, `agents.${normalized}`);
    const executor = stringValue(recordRaw.executor, normalized === "codex" ? "appserver" : "acp");
    if (executor !== "appserver" && executor !== "acp") {
      throw new Error(`unsupported agents.${normalized}.executor: ${executor}`);
    }
    const parsed = parseAgentRecordSchema({ ...recordRaw, executor }, `agents.${normalized}`);
    agents[normalized] = parseAgentRecord(parsed, {
      codex: baseAgents.codex as AppServerAgentConfig,
      claude: baseAgents.claude as AcpAgentConfig,
    });
  }
  return agents;
}

type AgentRecordRaw = z.infer<typeof agentRecordSchema>;

function parseAgentRecordSchema(raw: Record<string, unknown>, label: string): AgentRecordRaw {
  const result = agentRecordSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new Error(configErrorMessage(result.error, label));
}

function parseAgentRecord(
  raw: AgentRecordRaw,
  defaults: { codex: AppServerAgentConfig; claude: AcpAgentConfig },
): AgentConfig {
  if (raw.executor === "appserver") return parseAppServerAgent(raw, defaults.codex);
  return parseAcpAgent(raw, defaults.claude);
}

function parseAppServerAgent(
  raw: z.infer<typeof appServerAgentRecordSchema>,
  defaults: AppServerAgentConfig,
): AppServerAgentConfig {
  const codex = parseCodex(defaults, raw);
  return { executor: "appserver", ...codex };
}

function parseAcpAgent(
  raw: z.infer<typeof acpAgentRecordSchema>,
  defaults: AcpAgentConfig,
): AcpAgentConfig {
  return {
    executor: "acp",
    bridgeCommand: raw.bridgeCommand ?? raw.command ?? defaults.bridgeCommand,
    bridgeArgs: raw.bridgeArgs ?? defaults.bridgeArgs,
    model: raw.model ?? defaults.model,
    permissionMode: raw.permissionMode ?? defaults.permissionMode,
    turnTimeoutMs: raw.turnTimeoutMs ?? defaults.turnTimeoutMs,
    stallTimeoutMs: raw.stallTimeoutMs ?? defaults.stallTimeoutMs,
    strictMcpConfig: raw.strictMcpConfig ?? defaults.strictMcpConfig ?? true,
  };
}

function defaultAgentRecords(
  codex: CodexSettings,
  claude: ClaudeSettings,
): Record<string, AgentConfig> {
  return {
    codex: { executor: "appserver", ...codex },
    claude: {
      executor: "acp",
      bridgeCommand: claude.command,
      bridgeArgs: ["--permission-mode", claude.permissionMode, "--model", claude.model],
      model: claude.model,
      permissionMode: claude.permissionMode,
      turnTimeoutMs: claude.turnTimeoutMs,
      stallTimeoutMs: claude.stallTimeoutMs,
      strictMcpConfig: claude.strictMcpConfig,
    },
  };
}

function applyKnownAgentRecords(settings: Settings): void {
  const codex = settings.agents.codex;
  if (codex?.executor === "appserver") {
    settings.codex = {
      command: codex.command,
      approvalPolicy: codex.approvalPolicy,
      threadSandbox: codex.threadSandbox,
      turnSandboxPolicy: codex.turnSandboxPolicy,
      turnTimeoutMs: codex.turnTimeoutMs,
      readTimeoutMs: codex.readTimeoutMs,
      stallTimeoutMs: codex.stallTimeoutMs,
    };
  }
  const claude = settings.agents.claude;
  if (claude?.executor === "acp") {
    settings.claude = {
      command: claude.bridgeCommand,
      model: claude.model ?? settings.claude.model,
      permissionMode: claude.permissionMode ?? settings.claude.permissionMode,
      turnTimeoutMs: claude.turnTimeoutMs,
      stallTimeoutMs: claude.stallTimeoutMs,
      strictMcpConfig: claude.strictMcpConfig ?? settings.claude.strictMcpConfig,
    };
  }
}

function parseCodex(defaults: CodexSettings, codexRaw: CodexRaw): CodexSettings {
  return {
    command: codexRaw.command ?? defaults.command,
    approvalPolicy: approvalPolicyValue(
      codexRaw.approvalPolicy,
      defaults.approvalPolicy,
      "codex.approval_policy",
    ),
    threadSandbox: sandboxModeValue(
      codexRaw.threadSandbox,
      defaults.threadSandbox,
      "codex.thread_sandbox",
    ),
    turnSandboxPolicy: optionalMap(
      codexRaw.turnSandboxPolicy,
      defaults.turnSandboxPolicy,
      "codex.turn_sandbox_policy",
    ),
    turnTimeoutMs: codexRaw.turnTimeoutMs ?? defaults.turnTimeoutMs,
    readTimeoutMs: codexRaw.readTimeoutMs ?? defaults.readTimeoutMs,
    stallTimeoutMs: codexRaw.stallTimeoutMs ?? defaults.stallTimeoutMs,
  };
}

function parseClaude(defaults: ClaudeSettings, claudeRaw: ClaudeRaw): ClaudeSettings {
  return {
    command: claudeRaw.command ?? defaults.command,
    model: claudeRaw.model ?? defaults.model,
    permissionMode: claudeRaw.permissionMode ?? defaults.permissionMode,
    turnTimeoutMs: claudeRaw.turnTimeoutMs ?? defaults.turnTimeoutMs,
    stallTimeoutMs: claudeRaw.stallTimeoutMs ?? defaults.stallTimeoutMs,
    strictMcpConfig: claudeRaw.strictMcpConfig ?? defaults.strictMcpConfig,
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
  if (raw.approvalPolicy !== undefined) {
    next.approvalPolicy = approvalPolicyValue(
      raw.approvalPolicy,
      "never",
      "status_overrides.*.codex.approval_policy",
    );
  }
  if (raw.threadSandbox !== undefined) {
    next.threadSandbox = sandboxModeValue(
      raw.threadSandbox,
      "workspace-write",
      "status_overrides.*.codex.thread_sandbox",
    );
  }
  if (raw.turnSandboxPolicy !== undefined) {
    next.turnSandboxPolicy = optionalMap(
      raw.turnSandboxPolicy,
      null,
      "status_overrides.*.codex.turn_sandbox_policy",
    );
  }
  if (raw.turnTimeoutMs !== undefined) next.turnTimeoutMs = raw.turnTimeoutMs;
  if (raw.readTimeoutMs !== undefined) next.readTimeoutMs = raw.readTimeoutMs;
  if (raw.stallTimeoutMs !== undefined) next.stallTimeoutMs = raw.stallTimeoutMs;
  return next;
}

function parsePartialClaude(raw: Partial<ClaudeRaw>): Partial<ClaudeSettings> {
  const next: Partial<ClaudeSettings> = {};
  if (raw.command !== undefined) next.command = raw.command;
  if (raw.model !== undefined) next.model = raw.model;
  if (raw.permissionMode !== undefined) next.permissionMode = raw.permissionMode;
  if (raw.strictMcpConfig !== undefined) next.strictMcpConfig = raw.strictMcpConfig;
  if (raw.turnTimeoutMs !== undefined) next.turnTimeoutMs = raw.turnTimeoutMs;
  if (raw.stallTimeoutMs !== undefined) next.stallTimeoutMs = raw.stallTimeoutMs;
  return next;
}

function mergeCodex(base: CodexSettings, override: Partial<CodexSettings>): CodexSettings {
  const merged = { ...base, ...override };
  if (isPlainRecord(base.approvalPolicy) && isPlainRecord(override.approvalPolicy)) {
    merged.approvalPolicy = deepMerge(base.approvalPolicy, override.approvalPolicy);
  }
  if (isPlainRecord(base.turnSandboxPolicy) && isPlainRecord(override.turnSandboxPolicy)) {
    merged.turnSandboxPolicy = deepMerge(base.turnSandboxPolicy, override.turnSandboxPolicy);
  }
  return merged;
}

function cloneSettings(settings: Settings): Settings {
  return {
    ...settings,
    tracker: { ...settings.tracker, dispatch: { ...settings.tracker.dispatch } },
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

function cloneAgentRecords(records: Record<string, AgentConfig>): Record<string, AgentConfig> {
  const cloned: Record<string, AgentConfig> = {};
  for (const [name, record] of Object.entries(records)) {
    cloned[name] =
      record.executor === "appserver"
        ? {
            ...record,
            approvalPolicy: cloneUnknownRecord(record.approvalPolicy),
            turnSandboxPolicy: cloneNullableRecord(record.turnSandboxPolicy),
          }
        : { ...record, bridgeArgs: [...record.bridgeArgs] };
  }
  return cloned;
}

function cloneUnknownRecord(
  value: CodexSettings["approvalPolicy"],
): CodexSettings["approvalPolicy"] {
  return isPlainRecord(value) ? deepMerge({}, value) : value;
}

function cloneNullableRecord(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return value === null ? null : deepMerge({}, value);
}

function deepMerge(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = out[key];
    out[key] = isPlainRecord(existing) && isPlainRecord(value) ? deepMerge(existing, value) : value;
  }
  return out;
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

function configErrorMessage(error: z.ZodError, baseLabel?: string): string {
  const issue = error.issues[0];
  if (!issue) return `${baseLabel ?? "workflow"} is invalid`;
  const label = pathLabel(issue.path, baseLabel);
  switch (issue.code) {
    case "unrecognized_keys":
      return `${label} contains unsupported keys: ${issue.keys.join(", ")}`;
    case "invalid_type": {
      const expected = (issue as { expected?: string }).expected;
      const messages: Record<string, string> = {
        string: `${label} must be a string`,
        number: integerMessageForLabel(label),
        array: `${label} must be a list of strings`,
      };
      return messages[expected ?? ""] ?? `${label} must be a map`;
    }
    case "too_small":
      return integerMessageForLabel(label);
    case "custom":
      return `${label} ${issue.message}`;
    case "invalid_union": {
      const innerErrors = (issue as { errors?: unknown[][] }).errors;
      const firstInner = innerErrors?.[0]?.[0] as { expected?: string } | undefined;
      if (firstInner?.expected === "boolean") return `expected a boolean`;
      if (firstInner?.expected === "number") return integerMessageForLabel(label);
      return `${label} is invalid: ${issue.message}`;
    }
    default:
      return `${label} is invalid: ${issue.message}`;
  }
}

function integerMessageForLabel(label: string): string {
  const field = label.split(".").pop() ?? "";
  if (field === "port") return `${label} must be a valid port number (0-65535)`;
  const kind = field === "stall_timeout_ms" ? "a non-negative integer" : "a positive integer";
  return `${label} must be ${kind}`;
}

function camelToSnake(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function pathLabel(
  pathSegments: readonly (string | number | symbol)[],
  baseLabel?: string,
): string {
  const suffix = pathSegments.map((seg) => camelToSnake(String(seg))).join(".");
  if (suffix && baseLabel) return `${baseLabel}.${suffix}`;
  if (suffix) return suffix;
  return baseLabel ?? "workflow";
}

function normalizeWorkflowConfig(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  const raw = normalizeAliases(value, { status_overrides: "statusOverrides" });
  const normalized: Record<string, unknown> = { ...raw };

  normalizeNested(normalized, "tracker", trackerAliases);
  normalizeNested(normalized, "polling", pollingAliases);
  normalizeNested(normalized, "workspace", workspaceAliases);
  normalizeNested(normalized, "worker", workerAliases);
  normalizeNested(normalized, "hooks", hooksAliases);
  normalizeNested(normalized, "agent", agentAliases);
  normalizeNested(normalized, "codex", codexAliases);
  normalizeNested(normalized, "claude", claudeAliases);
  normalizeNested(normalized, "observability", observabilityAliases);
  normalizeNested(normalized, "server", {});
  normalizeNested(normalized, "logging", loggingAliases);

  if (isPlainRecord(normalized.tracker)) {
    normalizeNested(normalized.tracker, "dispatch", dispatchAliases);
  }
  if (isPlainRecord(normalized.agents)) {
    normalized.agents = Object.fromEntries(
      Object.entries(normalized.agents).map(([name, agent]) => [
        name,
        isPlainRecord(agent) ? normalizeAliases(agent, agentRecordAliases) : agent,
      ]),
    );
  }
  if (isPlainRecord(normalized.statusOverrides)) {
    normalized.statusOverrides = Object.fromEntries(
      Object.entries(normalized.statusOverrides).map(([state, override]) => {
        if (!isPlainRecord(override)) return [state, override];
        const normalizedOverride: Record<string, unknown> = { ...override };
        normalizeNested(normalizedOverride, "agent", agentAliases);
        normalizeNested(normalizedOverride, "codex", codexAliases);
        normalizeNested(normalizedOverride, "claude", claudeAliases);
        return [state, normalizedOverride];
      }),
    );
  }
  return normalized;
}

function normalizeNested(
  raw: Record<string, unknown>,
  key: string,
  aliases: Record<string, string>,
): void {
  if (isPlainRecord(raw[key])) raw[key] = normalizeAliases(raw[key], aliases);
}

function normalizeAliases(
  raw: Record<string, unknown>,
  aliases: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (Object.prototype.hasOwnProperty.call(raw, alias)) {
      out[canonical] = raw[alias];
      delete out[alias];
    }
  }
  return out;
}

function stringValue(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);
}

function trackerKindValue(value: unknown, label: string): TrackerKind {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (isOneOf(value, TRACKER_KINDS)) return value;
  throw new Error(`unsupported ${label}: ${value}`);
}

function approvalPolicyValue(
  value: unknown,
  fallback: CodexSettings["approvalPolicy"],
  label: string,
): CodexSettings["approvalPolicy"] {
  if (value === undefined || value === null) return fallback;
  if (isPlainRecord(value)) return value;
  if (typeof value !== "string") throw new Error(`${label} must be a string or map`);
  if (isOneOf(value, CODEX_APPROVAL_POLICY_NAMES)) return value;
  throw new Error(`unsupported ${label}: ${value}`);
}

function sandboxModeValue(
  value: unknown,
  fallback: CodexSettings["threadSandbox"],
  label: string,
): CodexSettings["threadSandbox"] {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (isOneOf(value, CODEX_SANDBOX_MODES)) return value;
  throw new Error(`unsupported ${label}: ${value}`);
}

function optionalMap(
  value: unknown,
  fallback: Record<string, unknown> | null,
  label: string,
): Record<string, unknown> | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (!isPlainRecord(value)) throw new Error(`${label} must be a map`);
  return value;
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
        "Install it from https://developer.1password.com/docs/cli/get-started — it cannot be managed by mise.",
    );
  }
  try {
    const result = execaSync("op", ["read", value], { env: mergedEnv });
    return result.stdout.trim();
  } catch {
    throw new Error(`Failed to resolve 1Password reference: ${value}`);
  }
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function expandPathVariables(value: string, env: NodeJS.ProcessEnv): string {
  const name = wholeEnvName(value);
  return name === null ? value : (env[name] ?? "");
}

function wholeEnvName(value: string): string | null {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  return match?.[1] ?? null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<const Values extends readonly string[]>(
  value: string,
  values: Values,
): value is Values[number] {
  return (values as readonly string[]).includes(value);
}
