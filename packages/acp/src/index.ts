import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type ClientCapabilities,
  type InitializeResponse,
  type McpServer,
  type ReadTextFileRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Usage,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import {
  acquireAgentMcpEndpoint,
  type AgentMcpEndpointLease,
  type RemoteMcpTunnelTransport,
} from "@lorenz/mcp";
import { actionForStopReason } from "@lorenz/policies/stopReason";
import { shellEscape, startSshProcess } from "@lorenz/ssh";
import { workerHostPool } from "@lorenz/worker-host-pool";
import { validateWorkspaceCwd } from "@lorenz/workspace";
import { execa } from "execa";
import {
  errorMessage,
  type AgentConfig,
  type AgentKind,
  type AgentExecutor,
  type AgentSession,
  type AgentUpdate,
  type AgentUpdateType,
  type Issue,
  type Settings,
  type UsageTokenUpdate,
  type UsageTotals,
} from "@lorenz/domain";
import type { AgentExecutorProvider } from "@lorenz/agent-sdk";

import { stopChild, withTimeout } from "./childProcess.js";
import {
  acpAgentOptions,
  isClaudeCompatibleBridgeCommand,
  parseAcpAgentOptions,
  type AcpAgentOptions,
} from "./options.js";

export {
  acpAgentOptions,
  AGENT_USAGE_ACCOUNTING_VALUES,
  isClaudeCompatibleBridgeCommand,
  type AcpAgentOptions,
  type AgentUsageAccounting,
} from "./options.js";

/** The SSH worker-host pool provisions the reverse tunnels behind remote MCP endpoints. */
const mcpTunnelTransport: RemoteMcpTunnelTransport = workerHostPool;

interface Session extends AgentSession {
  connection: ClientSideConnection;
  process: ChildProcessWithoutNullStreams;
  settings: Settings;
  workspace: string;
  agentConfig: AgentConfig;
  acpOptions: AcpAgentOptions;
  init: InitializeResponse;
  mcpEndpoint: AgentMcpEndpointLease;
  /**
   * True when {@link AcpSession.mcpEndpoint} was THREADED in by the dispatch
   * coordinator (it owns the whole lease for this run). acp must then SKIP both its
   * own `acquireAgentMcpEndpoint` AND its own `mcpEndpoint.release()` so the
   * coordinator's `slot.release` is the single owner (no double-close / orphaned
   * token+local-server+tunnel). False on the local / non-pool path, where acp
   * acquires AND releases its own endpoint byte-for-byte as before.
   */
  ownsMcpEndpoint: boolean;
  workerHost?: string | null | undefined;
  onUpdate?: ((update: AgentUpdate) => void) | undefined;
  usageTotals: UsageTotals;
  sawCallUsageThisTurn: boolean;
  turnStartTotals: UsageTotals;
  lastCallUsageSeq: number;
  callUsageBaseline?: UsageTokenUpdate | undefined;
  pendingTurn?: { reject: (error: Error) => void; allowSessionIdRotation: boolean } | undefined;
}

/**
 * The ACP executor: drives an external bridge subprocess (e.g. `codex-acp`,
 * `claude-agent-acp`) over the Agent Client Protocol, locally or via SSH.
 */
/** Fold the legacy `command` spelling into `bridgeCommand`; the canonical key wins. */
function normalizeLegacyCommand(options: Record<string, unknown>): Record<string, unknown> {
  if (!("command" in options)) return options;
  const { command, ...rest } = options;
  return { bridgeCommand: rest.bridgeCommand ?? command, ...rest };
}

export const acpExecutorProvider: AgentExecutorProvider = {
  executor: "acp",
  // `command` is the legacy spelling of `bridge_command`; it is listed first so the
  // canonical key wins when a record configures both.
  configAliases: {
    bridge_command: "bridgeCommand",
    usage_accounting: "usageAccounting",
    provider_config: "providerConfig",
    strict_mcp_config: "strictMcpConfig",
  },
  parseOptions: (options) => parseAcpAgentOptions(normalizeLegacyCommand(options)),
  validateAgent(kind, config) {
    if (!acpAgentOptions(config).bridgeCommand.trim()) {
      throw new Error(
        kind === "claude"
          ? "claude.command is required"
          : `agents.${kind}.bridgeCommand is required`,
      );
    }
  },
  createExecutor: (kind, _settings, env) => new Executor(kind, env),
};

export class Executor implements AgentExecutor {
  readonly kind: AgentKind;
  private readonly env: NodeJS.ProcessEnv;

  constructor(kind: AgentKind, env: NodeJS.ProcessEnv = process.env) {
    this.kind = kind;
    this.env = env;
  }

  async startSession(input: {
    workspace: string;
    issue?: Issue;
    settings: Settings;
    workerHost?: string | null;
    /**
     * A pre-resolved per-run MCP endpoint lease threaded in by the dispatch
     * coordinator (it owns the whole lease for the run). When present (non-null) acp
     * USES it instead of acquiring its own AND skips releasing it in `stopSession`
     * (the coordinator's `slot.release` closes it - single ownership). When absent
     * (null / local / non-pool) acp acquires AND releases its OWN endpoint exactly
     * as before.
     */
    mcpEndpoint?: AgentMcpEndpointLease | null;
    onUpdate?: (update: AgentUpdate) => void;
  }): Promise<Session> {
    const workspace = await validateWorkspaceCwd(
      input.settings,
      input.workspace,
      this.env,
      input.workerHost ?? null,
    );
    const agentKind = input.settings.agent.kind;
    const agentConfig = resolveAgentConfig(input.settings, agentKind);
    // The coordinator owns the lease ONLY when one was threaded in; otherwise acp
    // owns the endpoint it acquires below and must release it on stop.
    const threadedEndpoint = input.mcpEndpoint ?? null;
    const ownsMcpEndpoint = threadedEndpoint === null;
    const acpOptions = acpAgentOptions(agentConfig);
    let mcpEndpoint: AgentMcpEndpointLease | null = null;
    let child: ChildProcessWithoutNullStreams | null = null;
    let session: Session | null = null;
    try {
      mcpEndpoint =
        threadedEndpoint ??
        (await acquireAgentMcpEndpoint(
          input.settings,
          this.env,
          input.workerHost ?? null,
          mcpTunnelTransport,
        ));
      child = startBridgeProcess(
        acpOptions.bridgeCommand,
        workspace,
        input.workerHost ?? null,
        this.env,
      );
      const client = acpClient({
        workspace,
        workerHost: input.workerHost ?? null,
        currentSession: () => session,
        emit: (update) => this.emit(session, update),
      });
      const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
      const connection = new ClientSideConnection((_agent) => client, stream);
      const executorPid = child.pid === undefined ? null : String(child.pid);
      const init = await withTimeout(
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: clientCapabilities(input.workerHost ?? null),
        }),
        30_000,
        "acp initialize timed out",
      );

      const nextSession: Session = {
        agentKind,
        connection,
        process: child,
        settings: input.settings,
        workspace,
        agentConfig,
        acpOptions,
        init,
        mcpEndpoint,
        ownsMcpEndpoint,
        workerHost: input.workerHost ?? null,
        sessionId: null,
        executorPid,
        onUpdate: input.onUpdate,
        usageTotals: emptyUsageTotals(),
        sawCallUsageThisTurn: false,
        turnStartTotals: emptyUsageTotals(),
        lastCallUsageSeq: 0,
        stop: async () => {
          await this.stopSession(nextSession);
        },
      };
      session = nextSession;
      wireProcessEvents(session);

      const sessionId = await openSession(session, [mcpEndpoint.acpServer()]);
      session.sessionId = sessionId;
      this.emit(session, {
        type: "session_started",
        message: `session started (${sessionId})`,
        sessionId,
        executorPid,
        timestamp: new Date(),
      });
      return session;
    } catch (error) {
      if (session) await this.stopSession(session);
      else {
        if (child) await stopChild(child);
        // Only release the endpoint acp OWNS. A threaded lease belongs to the
        // coordinator's slot.release, so acp must never release it (even on a
        // startup error) or it would double-close the token+local-server+tunnel.
        if (ownsMcpEndpoint) await mcpEndpoint?.release();
      }
      throw error;
    }
  }

  async runTurn(session: Session, prompt: string, _issue?: Issue): Promise<AgentUpdate[]> {
    if (session.pendingTurn) throw new Error("ACP turn already running");
    const previous = session.onUpdate;
    const updates: AgentUpdate[] = [];
    let settled = false;

    return new Promise<AgentUpdate[]>((resolve, reject) => {
      const cancelTurn = () => {
        void session.connection.cancel({ sessionId: requireSessionId(session) }).catch((err) => {
          process.stderr.write(`session cancel failed: ${err}\n`);
        });
        finishReject(new Error("acp turn timed out"));
      };
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const resetStallTimer = () => {
        if (session.agentConfig.stallTimeoutMs <= 0) return;
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(cancelTurn, session.agentConfig.stallTimeoutMs);
      };
      const hardTimer = setTimeout(cancelTurn, session.agentConfig.turnTimeoutMs);

      const cleanup = () => {
        clearTimeout(hardTimer);
        if (stallTimer) clearTimeout(stallTimer);
        session.onUpdate = previous;
        session.pendingTurn = undefined;
      };

      const finishResolve = (value: AgentUpdate[]) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      resetStallTimer();
      session.sawCallUsageThisTurn = false;
      session.turnStartTotals = { ...session.usageTotals };
      session.pendingTurn = { reject: finishReject, allowSessionIdRotation: true };
      session.onUpdate = (update) => {
        resetStallTimer();
        updates.push(update);
        previous?.(update);
      };

      const sessionId = requireSessionId(session);
      this.emit(session, {
        type: "turn_started",
        sessionId,
        message: { prompt: [{ type: "text", text: prompt }] },
        timestamp: new Date(),
      });

      session.connection
        .prompt({
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        })
        .then((response) => {
          if (settled) return;
          const usage = finalizeTurnUsage(session, extractUsage(response.usage ?? undefined));
          const action = actionForStopReason(response.stopReason);
          const terminalType =
            action === "continue"
              ? "turn_completed"
              : action === "cancel"
                ? "turn_cancelled"
                : "turn_failed";
          const base = {
            sessionUpdate: acpProtocolUpdate(session, terminalType, { response }),
            sessionId: session.sessionId,
            executorPid: session.executorPid,
            message: { response },
            timestamp: new Date(),
            ...(usage && { usage, usageKind: "cumulative" as const }),
          };
          if (action === "continue") {
            this.emit(session, { ...base, type: "turn_completed" });
            finishResolve([...updates]);
          } else if (action === "cancel") {
            this.emit(session, { ...base, type: "turn_cancelled" });
            finishReject(new Error("acp_turn_cancelled"));
          } else {
            this.emit(session, { ...base, type: "turn_failed" });
            finishReject(new Error(`acp_turn_failed: ${response.stopReason}`));
          }
        })
        .catch((error: unknown) => {
          if (settled) return;
          const message = errorMessage(error);
          this.emit(session, {
            type: "turn_failed",
            sessionId,
            message,
            timestamp: new Date(),
          });
          finishReject(error instanceof Error ? error : new Error(message));
        });
    });
  }

  private emit(session: Session | null, update: AgentUpdate): void {
    session?.onUpdate?.(update);
  }

  private async stopSession(session: Session): Promise<void> {
    const sessionId = session.sessionId;
    session.pendingTurn?.reject(new Error("acp session stopped"));
    try {
      if (sessionId && supportsClose(session.init)) {
        await withTimeout(
          session.connection.closeSession({ sessionId }),
          5_000,
          "acp close timed out",
        );
      }
    } catch {
      // Closing is best effort because the bridge may already be gone.
    } finally {
      await stopChild(session.process);
      // Release ONLY the endpoint acp owns. When the coordinator threaded a
      // per-run lease in (`ownsMcpEndpoint === false`) the slot.release closes it,
      // so acp skips its own release to avoid a double-close of the shared
      // token+local-server+tunnel.
      if (session.ownsMcpEndpoint) await session.mcpEndpoint.release();
    }
  }
}

function handleSessionUpdate(session: Session, notification: SessionNotification): void {
  const canAcceptRotation =
    session.pendingTurn?.allowSessionIdRotation === true && Boolean(session.sessionId);
  if (session.sessionId && notification.sessionId !== session.sessionId && !canAcceptRotation) {
    session.onUpdate?.({
      type: "malformed",
      sessionUpdate: acpProtocolUpdate(session, "malformed", notification),
      sessionId: session.sessionId,
      executorPid: session.executorPid,
      message: `acp_session_update_mismatch: active session ${session.sessionId}, notification session ${notification.sessionId}`,
      timestamp: new Date(),
    });
    return;
  }
  if (session.pendingTurn) session.pendingTurn.allowSessionIdRotation = false;
  session.sessionId = notification.sessionId;
  const usage = consumeCallUsage(session, notification);
  session.onUpdate?.({
    type: "session_notification",
    sessionUpdate: acpProtocolUpdate(session, "session_notification", notification),
    sessionId: session.sessionId,
    executorPid: session.executorPid,
    message: notification,
    timestamp: new Date(),
    ...(usage && { usage, usageKind: "cumulative" as const }),
  });
}

/**
 * Patched bridges attach a per-model-call token bucket to usage_update
 * notifications under _meta["symphony/callUsage"] (see vendor/README.md).
 * Buckets are deltas for exactly one call, so they accumulate additively
 * regardless of the agent's turn-level usage accounting mode. Returns the
 * running session totals when a new bucket was consumed.
 */
function consumeCallUsage(
  session: Session,
  notification: SessionNotification,
): UsageTokenUpdate | undefined {
  if (notification.update?.sessionUpdate !== "usage_update") return undefined;
  const meta = (notification.update as { _meta?: Record<string, unknown> | null })._meta;
  if (!meta) return undefined;
  const rawCall = meta["symphony/callUsage"];
  const call = parseUsageBucket(rawCall);
  if (!call) return undefined;
  const seq = bucketSeq(rawCall);
  if (seq !== null) {
    if (seq <= session.lastCallUsageSeq) return undefined;
    session.lastCallUsageSeq = seq;
  }
  session.sawCallUsageThisTurn = true;
  addUsageTotals(session, call);
  const total = parseUsageBucket(meta["symphony/totalUsage"]);
  if (total) {
    // The bridge also reports its own cumulative counter; use it as a floor
    // so missed bucket notifications cannot under-count the session. The
    // baseline captures any spend already on the counter before the first
    // observed call.
    session.callUsageBaseline ??= subtractUsage(total, call);
    maxUsageTotals(session, subtractUsage(total, session.callUsageBaseline));
  }
  return usageSnapshot(session);
}

/**
 * Turn-end usage. The bridge's turn-level report is normalized to a
 * session-cumulative value (a per-turn report is the turn's delta, so it is
 * offset from the turn-start totals; a cumulative report already is one) and
 * applied as a monotonic floor on the session totals. With per-call buckets
 * this reconciles gaps without re-adding what the buckets already counted;
 * without buckets it reproduces plain turn-level accounting.
 */
function finalizeTurnUsage(
  session: Session,
  reported: UsageTokenUpdate | undefined,
): UsageTokenUpdate | undefined {
  if (!reported) return session.sawCallUsageThisTurn ? usageSnapshot(session) : undefined;
  const reportedCumulative =
    session.acpOptions.usageAccounting === "cumulative"
      ? reported
      : addUsage(session.turnStartTotals, reported);
  maxUsageTotals(session, reportedCumulative);
  return usageSnapshot(session);
}

function parseUsageBucket(value: unknown): UsageTokenUpdate | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const bucket = value as Record<string, unknown>;
  const field = (key: string): number => {
    const raw = bucket[key];
    return typeof raw === "number" ? nonNegativeFinite(raw) : 0;
  };
  const inputTokens = field("inputTokens") + field("cachedReadTokens") + field("cachedWriteTokens");
  const outputTokens = field("outputTokens");
  const rawTotal = bucket["totalTokens"];
  const totalTokens =
    (typeof rawTotal === "number" ? nonNegativeUsageValue(rawTotal) : undefined) ??
    inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function bucketSeq(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const seq = (value as Record<string, unknown>)["seq"];
  return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
}

function addUsageTotals(session: Session, usage: UsageTokenUpdate): void {
  session.usageTotals = {
    inputTokens: session.usageTotals.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: session.usageTotals.outputTokens + (usage.outputTokens ?? 0),
    totalTokens: session.usageTotals.totalTokens + (usage.totalTokens ?? 0),
    secondsRunning: session.usageTotals.secondsRunning,
  };
}

function maxUsageTotals(session: Session, usage: UsageTokenUpdate): void {
  session.usageTotals = {
    inputTokens: Math.max(session.usageTotals.inputTokens, usage.inputTokens ?? 0),
    outputTokens: Math.max(session.usageTotals.outputTokens, usage.outputTokens ?? 0),
    totalTokens: Math.max(session.usageTotals.totalTokens, usage.totalTokens ?? 0),
    secondsRunning: session.usageTotals.secondsRunning,
  };
}

function addUsage(left: UsageTokenUpdate, right: UsageTokenUpdate): UsageTokenUpdate {
  return {
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0),
    totalTokens: (left.totalTokens ?? 0) + (right.totalTokens ?? 0),
  };
}

function subtractUsage(left: UsageTokenUpdate, right: UsageTokenUpdate): UsageTokenUpdate {
  return {
    inputTokens: Math.max((left.inputTokens ?? 0) - (right.inputTokens ?? 0), 0),
    outputTokens: Math.max((left.outputTokens ?? 0) - (right.outputTokens ?? 0), 0),
    totalTokens: Math.max((left.totalTokens ?? 0) - (right.totalTokens ?? 0), 0),
  };
}

function usageSnapshot(session: Session): UsageTokenUpdate {
  return {
    inputTokens: session.usageTotals.inputTokens,
    outputTokens: session.usageTotals.outputTokens,
    totalTokens: session.usageTotals.totalTokens,
  };
}

function handlePermissionRequest(
  session: Session | null,
  request: RequestPermissionRequest,
  emit: (update: AgentUpdate) => void,
): RequestPermissionResponse {
  const selected =
    request.options.find((option) => option.kind.startsWith("allow")) ??
    request.options.find((option) => option.optionId.toLowerCase().includes("allow")) ??
    null;
  if (selected) {
    emit({
      type: "approval_auto_approved",
      sessionId: request.sessionId,
      executorPid: session?.executorPid,
      message: { request, selected },
      timestamp: new Date(),
    });
    return { outcome: { outcome: "selected", optionId: selected.optionId } };
  }
  emit({
    type: "approval_required",
    sessionId: request.sessionId,
    executorPid: session?.executorPid,
    message: { request, selected },
    timestamp: new Date(),
  });
  return { outcome: { outcome: "cancelled" } };
}

function acpClient(input: {
  workspace: string;
  workerHost: string | null;
  currentSession: () => Session | null;
  emit: (update: AgentUpdate) => void;
}): Client {
  const executor = new ClientAdapter(
    input.workspace,
    input.workerHost,
    input.currentSession,
    input.emit,
  );
  return executor.client();
}

class ClientAdapter {
  constructor(
    private readonly workspace: string,
    private readonly workerHost: string | null,
    private readonly currentSession: () => Session | null,
    private readonly emit: (update: AgentUpdate) => void,
  ) {}

  client(): Client {
    const client: Client = {
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const session = this.currentSession();
        if (!session) return Promise.resolve();
        handleSessionUpdate(session, params);
        return Promise.resolve();
      },
      requestPermission: async (params: RequestPermissionRequest) => {
        const session = this.currentSession();
        return Promise.resolve(handlePermissionRequest(session, params, this.emit));
      },
    };
    if (!this.workerHost) {
      client.readTextFile = async (params) => this.readTextFile(params);
      client.writeTextFile = async (params) => this.writeTextFile(params);
    }
    return client;
  }

  private async readTextFile(params: ReadTextFileRequest): Promise<{ content: string }> {
    const filePath = this.workspacePath(params.path);
    const text = await fs.readFile(filePath, "utf8");
    if (!params.line && !params.limit) return { content: text };
    const lines = text.split(/\r?\n/);
    const start = Math.max((params.line ?? 1) - 1, 0);
    const end = params.limit ? start + params.limit : undefined;
    return { content: lines.slice(start, end).join("\n") };
  }

  private async writeTextFile(params: WriteTextFileRequest): Promise<Record<string, never>> {
    const filePath = this.workspacePath(params.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, params.content);
    this.emit({
      type: "fs_write",
      sessionId: params.sessionId,
      message: { path: params.path },
      timestamp: new Date(),
    });
    return {};
  }

  private workspacePath(rawPath: string): string {
    if (!path.isAbsolute(rawPath)) throw new Error("acp_fs_path_must_be_absolute");
    const root = path.resolve(this.workspace);
    const resolved = path.resolve(rawPath);
    const relative = path.relative(root, resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return resolved;
    }
    throw new Error("acp_fs_path_outside_workspace");
  }
}

async function openSession(session: Session, mcpServers: McpServer[]): Promise<string> {
  const meta = providerConfigMeta(session);
  const created = await withTimeout(
    session.connection.newSession({
      cwd: session.workspace,
      mcpServers,
      ...(meta && { _meta: meta }),
    }),
    30_000,
    "acp new session timed out",
  );
  return created.sessionId;
}

/**
 * Provider config rides the session request's _meta instead of config files
 * written into the workspace. The vendored claude bridge consumes a
 * settings.json-shaped overlay under symphony/settings; the vendored codex
 * bridge consumes config.toml-shaped overrides under symphony/config (see
 * vendor/README.md). Bridges that don't know the keys ignore them.
 */
function providerConfigMeta(session: Session): Record<string, unknown> | undefined {
  const providerConfig = session.acpOptions.providerConfig;
  if (!providerConfig) return undefined;
  const isClaudeBridge =
    session.agentKind === "claude" ||
    isClaudeCompatibleBridgeCommand(session.acpOptions.bridgeCommand);
  return { [isClaudeBridge ? "symphony/settings" : "symphony/config"]: providerConfig };
}

const VENDORED_BRIDGE_PACKAGES: Record<string, string> = {
  "codex-acp": "@agentclientprotocol/codex-acp",
  "claude-agent-acp": "@agentclientprotocol/claude-agent-acp",
};

interface BridgePackageManifest {
  bin?: string | Record<string, string> | undefined;
}

function binTargetForManifest(manifest: BridgePackageManifest, bin: string): string {
  if (typeof manifest.bin === "string") return manifest.bin;
  return manifest.bin?.[bin] ?? "dist/index.js";
}

/**
 * Resolve bare bridge names to the vendored workspace packages so local runs
 * always use Lorenz's patched bridges rather than whatever PATH provides.
 * Remote hosts keep the configured command verbatim (the vendored install
 * only exists locally), as do custom commands and explicit paths.
 */
export function resolveBridgeCommand(bridgeCommand: string, workerHost: string | null): string {
  if (workerHost) return bridgeCommand;
  const [bin, ...args] = bridgeCommand.trim().split(/\s+/);
  if (!bin) return bridgeCommand;
  const packageName = VENDORED_BRIDGE_PACKAGES[bin];
  if (!packageName) return bridgeCommand;
  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve(`${packageName}/package.json`);
    const manifest = require(manifestPath) as BridgePackageManifest;
    const binPath = path.join(path.dirname(manifestPath), binTargetForManifest(manifest, bin));
    return [shellEscape(process.execPath), shellEscape(binPath), ...args].join(" ");
  } catch {
    return bridgeCommand;
  }
}

// Packaged builds of the CLI do not bundle the claude/codex agent binaries, so the local bridge
// resolves them from the host. codex already falls back to `codex` on PATH, but claude needs an
// explicit path, so both are set for consistency. An explicit value in the environment always wins.
const HOST_AGENT_BINARIES: ReadonlyArray<{ env: string; command: string }> = [
  { env: "CLAUDE_CODE_EXECUTABLE", command: "claude" },
  { env: "CODEX_PATH", command: "codex" },
];

const hostBinaryPaths = new Map<string, string | null>();

function lookupHostBinary(command: string): string | null {
  const cached = hostBinaryPaths.get(command);
  if (cached !== undefined) return cached;
  let resolved: string | null;
  try {
    // A login shell matches the PATH the bridge itself sees when it is spawned under `bash -lc`.
    resolved =
      execFileSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" }).trim() || null;
  } catch {
    resolved = null;
  }
  hostBinaryPaths.set(command, resolved);
  return resolved;
}

export function hostAgentBinaryEnv(
  currentEnv: NodeJS.ProcessEnv = process.env,
  lookup: (command: string) => string | null = lookupHostBinary,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { env: name, command } of HOST_AGENT_BINARIES) {
    if (currentEnv[name]) continue;
    const resolved = lookup(command);
    if (resolved) env[name] = resolved;
  }
  return env;
}

function startBridgeProcess(
  bridgeCommand: string,
  workspace: string,
  workerHost: string | null,
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const command = `exec ${resolveBridgeCommand(bridgeCommand, workerHost)}`;
  if (workerHost) {
    // Remote bridges resolve their own binaries on the worker host.
    return startSshProcess(workerHost, `cd ${shellEscape(workspace)} && ${command}`, env);
  }
  // Derive the child environment from the resolved env plus any agent-binary paths it lacks, rather
  // than execa's default of layering overrides onto the ambient process environment.
  return execa("bash", ["-lc", command], {
    cwd: workspace,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    reject: false,
    extendEnv: false,
    env: { ...env, ...hostAgentBinaryEnv(env) },
  }) as unknown as ChildProcessWithoutNullStreams;
}

function wireProcessEvents(session: Session): void {
  let stderr = "";
  session.process.stderr.setEncoding("utf8");
  session.process.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    const lines = stderr.split(/\r?\n/);
    stderr = lines.pop() ?? "";
    for (const line of lines) {
      session.onUpdate?.({ type: "stderr", message: line, timestamp: new Date() });
    }
  });
  session.process.on("close", (code, signal) => {
    if (stderr) {
      session.onUpdate?.({ type: "stderr", message: stderr, timestamp: new Date() });
      stderr = "";
    }
    const message = `acp bridge exited${code === null ? "" : ` with status ${code}`}${signal ? ` signal ${signal}` : ""}`;
    session.onUpdate?.({ type: "process_exit", message, timestamp: new Date() });
    session.pendingTurn?.reject(new Error(message));
  });
}

function clientCapabilities(workerHost: string | null): ClientCapabilities {
  const capabilities: ClientCapabilities = {};
  if (!workerHost) {
    capabilities.fs = {
      readTextFile: true,
      writeTextFile: true,
    };
  }
  return capabilities;
}

function acpProtocolUpdate(
  session: Session,
  type: AgentUpdateType,
  message: unknown,
): NonNullable<AgentUpdate["sessionUpdate"]> {
  return {
    kind: type,
    sessionId: session.sessionId,
    agentKind: session.agentKind,
    message,
    at: new Date(),
    _meta: {
      executorPid: session.executorPid,
    },
  };
}

function extractUsage(usage: Usage | undefined): UsageTokenUpdate | undefined {
  if (!usage) return undefined;
  const inputTokens =
    nonNegativeFinite(usage.inputTokens) +
    nonNegativeFinite(usage.cachedReadTokens) +
    nonNegativeFinite(usage.cachedWriteTokens);
  const outputTokens = nonNegativeFinite(usage.outputTokens);
  const totalTokens = nonNegativeUsageValue(usage.totalTokens) ?? inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0,
  };
}

function nonNegativeFinite(value: number | null | undefined): number {
  return nonNegativeUsageValue(value) ?? 0;
}

function nonNegativeUsageValue(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function resolveAgentConfig(settings: Settings, kind: AgentKind): AgentConfig {
  const agent = settings.agents[kind];
  if (!agent) throw new Error(`agents.${kind} is required`);
  if (agent.executor !== "acp") throw new Error(`agents.${kind}.executor must be acp`);
  return agent;
}

function supportsClose(init: InitializeResponse): boolean {
  return Boolean(init.agentCapabilities?.sessionCapabilities?.close);
}

function requireSessionId(session: Session): string {
  if (!session.sessionId) throw new Error("acp session not started");
  return session.sessionId;
}
