import fs from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
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
  type QueuedTurnOptions,
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
   * True when ACP created the endpoint lease. A coordinator-provided lease remains
   * under the coordinator's lifecycle so only one owner can release it.
   */
  ownsMcpEndpoint: boolean;
  workerHost?: string | null | undefined;
  onUpdate?: ((update: AgentUpdate) => void) | undefined;
  usageTotals: UsageTotals;
  sawCallUsageThisTurn: boolean;
  turnStartTotals: UsageTotals;
  lastCallUsageSeq: number;
  callUsageBaseline?: UsageTokenUpdate | undefined;
  pendingTurns: PendingTurn[];
  terminalError?: Error | undefined;
  shutdown?: Promise<void> | undefined;
}

const bridgeProcessCleanupDirs = new WeakMap<ChildProcessWithoutNullStreams, string>();

interface PendingTurn {
  active: boolean;
  settled: boolean;
  allowSessionIdRotation: boolean;
  activate(): void;
  trySubmitPrompt(): boolean;
  touch(): void;
  reject(error: Error): void;
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
  createExecutor: (kind) => new Executor(kind),
};

export class Executor implements AgentExecutor {
  readonly kind: AgentKind;

  constructor(kind = "acp") {
    this.kind = kind;
  }

  async startSession(input: {
    workspace: string;
    issue?: Issue;
    settings: Settings;
    workerHost?: string | null;
    /**
     * A coordinator-owned MCP endpoint lease for this run. ACP uses the supplied
     * lease without acquiring or releasing it. When absent, ACP owns the lease it
     * acquires.
     */
    mcpEndpoint?: AgentMcpEndpointLease | null;
    onUpdate?: (update: AgentUpdate) => void;
  }): Promise<Session> {
    const workspace = await validateWorkspaceCwd(
      input.settings,
      input.workspace,
      input.workerHost ?? null,
    );
    const agentKind = input.settings.agent.kind;
    const agentConfig = resolveAgentConfig(input.settings, agentKind);
    // Exactly one component owns endpoint release for the run.
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
          input.workerHost ?? null,
          mcpTunnelTransport,
        ));
      child = startBridgeProcess(acpOptions.bridgeCommand, workspace, input.workerHost ?? null);
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
        pendingTurns: [],
        terminalError: undefined,
        shutdown: undefined,
        ...(supportsPromptQueue(init) && {
          queueTurn: async (prompt: string, options?: QueuedTurnOptions) =>
            this.queueTurn(nextSession, prompt, options),
        }),
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
        if (child) await stopBridgeProcess(child, !input.workerHost);
        // Coordinator-provided leases remain under coordinator ownership.
        if (ownsMcpEndpoint) await mcpEndpoint?.release();
      }
      throw error;
    }
  }

  /**
   * Send one prompt and resolve with the turn's TERMINAL update only (the
   * `turn_completed` that ended it). Everything the turn streams goes through
   * the session's `onUpdate`; retaining the full batch here would hold every
   * (potentially large) update - and, via V8 sliced strings, the raw receive
   * buffers behind them - for the whole lifetime of a turn that can run for
   * an hour, across every concurrent run. That is a real memory leak in a
   * long-running daemon, so the batch is not kept.
   */
  async runTurn(session: Session, prompt: string, _issue?: Issue): Promise<AgentUpdate[]> {
    if (session.terminalError) throw session.terminalError;
    if (session.pendingTurns.length > 0) throw new Error("ACP turn already running");
    return this.startTurn(session, prompt);
  }

  private async queueTurn(
    session: Session,
    prompt: string,
    options?: QueuedTurnOptions,
  ): Promise<AgentUpdate[]> {
    if (session.terminalError) throw session.terminalError;
    return this.startTurn(session, prompt, options);
  }

  private async startTurn(
    session: Session,
    prompt: string,
    options?: QueuedTurnOptions,
  ): Promise<AgentUpdate[]> {
    let settled = false;
    let backendCompletion: (() => void) | undefined;

    return new Promise<AgentUpdate[]>((resolve, reject) => {
      const cancelTurn = () => {
        if (turn.settled) return;
        rejectTimedOutSession(session);
        void this.beginSessionShutdown(session, 1_000).catch((err) => {
          process.stderr.write(`acp session shutdown failed: ${err}\n`);
        });
      };
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      const resetStallTimer = () => {
        if (!turn.active || turn.settled || session.agentConfig.stallTimeoutMs <= 0) return;
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(cancelTurn, session.agentConfig.stallTimeoutMs);
      };

      const clearTimers = () => {
        if (hardTimer) clearTimeout(hardTimer);
        if (stallTimer) clearTimeout(stallTimer);
      };

      const releaseBackendSlot = () => {
        clearTimers();
        const index = session.pendingTurns.indexOf(turn);
        if (index === -1) return;
        const wasActive = index === 0;
        session.pendingTurns.splice(index, 1);
        submitEligiblePrompts(session);
        if (wasActive) session.pendingTurns[0]?.activate();
      };

      const flushBackendCompletion = () => {
        if (!turn.active || !backendCompletion) return;
        const complete = backendCompletion;
        backendCompletion = undefined;
        try {
          complete();
        } catch (error) {
          if (!settled) {
            finishReject(error instanceof Error ? error : new Error(errorMessage(error)));
          }
        } finally {
          releaseBackendSlot();
        }
      };

      const finishResolve = (value: AgentUpdate[]) => {
        if (settled) return;
        settled = true;
        turn.settled = true;
        clearTimers();
        resolve(value);
      };

      const finishReject = (error: Error) => {
        clearTimers();
        if (settled) return;
        settled = true;
        turn.settled = true;
        reject(error);
      };

      let backendSlotAvailable = false;
      let activationReady = options?.startWhen === undefined;
      let promptSubmitted = false;
      const emitUpdate = (update: AgentUpdate): void => this.emit(session, update);
      const submitPrompt = (): void => {
        if (promptSubmitted || turn.settled) return;
        promptSubmitted = true;
        session.connection
          .prompt({
            sessionId: requireSessionId(session),
            prompt: [{ type: "text", text: prompt }],
          })
          .then(
            (response) => {
              backendCompletion = () => {
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
                  const terminal: AgentUpdate = { ...base, type: "turn_completed" };
                  this.emit(session, terminal);
                  finishResolve([terminal]);
                } else if (action === "cancel") {
                  this.emit(session, { ...base, type: "turn_cancelled" });
                  finishReject(new Error("acp_turn_cancelled"));
                } else {
                  this.emit(session, { ...base, type: "turn_failed" });
                  finishReject(new Error(`acp_turn_failed: ${response.stopReason}`));
                }
              };
              flushBackendCompletion();
            },
            (error: unknown) => {
              backendCompletion = () => {
                if (settled) return;
                const message = errorMessage(error);
                this.emit(session, {
                  type: "turn_failed",
                  sessionId: requireSessionId(session),
                  message,
                  timestamp: new Date(),
                });
                finishReject(error instanceof Error ? error : new Error(message));
              };
              flushBackendCompletion();
            },
          );
      };
      function beginTurn(): void {
        if (!backendSlotAvailable || !activationReady || turn.active || turn.settled) return;
        turn.active = true;
        submitPrompt();
        session.sawCallUsageThisTurn = false;
        session.turnStartTotals = { ...session.usageTotals };
        hardTimer = setTimeout(cancelTurn, session.agentConfig.turnTimeoutMs);
        resetStallTimer();
        emitUpdate({
          type: "turn_started",
          sessionId: requireSessionId(session),
          message: { prompt: [{ type: "text", text: prompt }] },
          timestamp: new Date(),
        });
        flushBackendCompletion();
      }
      const turn: PendingTurn = {
        active: false,
        settled: false,
        allowSessionIdRotation: true,
        activate: () => {
          backendSlotAvailable = true;
          beginTurn();
        },
        trySubmitPrompt: () => {
          if (turn.settled || promptSubmitted) return true;
          if (!activationReady) return false;
          submitPrompt();
          return true;
        },
        touch: resetStallTimer,
        reject: finishReject,
      };
      session.pendingTurns.push(turn);
      submitEligiblePrompts(session);
      if (session.pendingTurns[0] === turn) turn.activate();
      void options?.startWhen?.then(
        () => {
          activationReady = true;
          submitEligiblePrompts(session);
          beginTurn();
        },
        (error: unknown) => {
          if (turn.settled) return;
          finishReject(error instanceof Error ? error : new Error(errorMessage(error)));
          releaseBackendSlot();
        },
      );
    });
  }

  private emit(session: Session | null, update: AgentUpdate): void {
    session?.pendingTurns[0]?.touch();
    session?.onUpdate?.(update);
  }

  private async stopSession(session: Session): Promise<void> {
    session.terminalError ??= new Error("acp session stopped");
    rejectPendingTurns(session, session.terminalError);
    await this.beginSessionShutdown(session, 5_000);
  }

  private async beginSessionShutdown(session: Session, closeTimeoutMs: number): Promise<void> {
    session.shutdown ??= this.shutdownSession(session, closeTimeoutMs);
    return session.shutdown;
  }

  private async shutdownSession(session: Session, closeTimeoutMs: number): Promise<void> {
    const sessionId = session.sessionId;
    try {
      if (sessionId && supportsClose(session.init)) {
        await withTimeout(
          session.connection.closeSession({ sessionId }),
          closeTimeoutMs,
          "acp close timed out",
        );
      }
    } catch {
      // Closing is best effort because the bridge may already be gone.
    } finally {
      try {
        await stopBridgeProcess(session.process, !session.workerHost);
      } finally {
        // A coordinator-provided per-run lease owns its endpoint lifecycle.
        // ACP releases only endpoints that it created itself.
        if (session.ownsMcpEndpoint) await session.mcpEndpoint.release();
      }
    }
  }
}

function handleSessionUpdate(session: Session, notification: SessionNotification): void {
  session.pendingTurns[0]?.touch();
  const canAcceptRotation =
    session.pendingTurns[0]?.allowSessionIdRotation === true && Boolean(session.sessionId);
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
  if (session.pendingTurns[0]) session.pendingTurns[0].allowSessionIdRotation = false;
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
): ChildProcessWithoutNullStreams {
  const bridge = resolveBridgeCommand(bridgeCommand, workerHost);
  if (workerHost) {
    // Remote bridges resolve their own binaries on the worker host.
    const script = remoteBridgeScript(workspace, bridge);
    return startSshProcess(workerHost, script);
  }
  if (process.platform === "win32") {
    const cleanupDir = mkdtempSync(path.join(os.tmpdir(), "lorenz-acp-"));
    const scriptPath = path.join(cleanupDir, "bridge.sh");
    try {
      writeFileSync(scriptPath, `IFS= read -r _lorenz_ready || exit 1\nexec ${bridge}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      const child = execa(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          windowsBridgeGuardianScript(workspace, scriptPath),
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          reject: false,
          buffer: false,
          env: hostAgentBinaryEnv(),
        },
      ) as unknown as ChildProcessWithoutNullStreams;
      bridgeProcessCleanupDirs.set(child, cleanupDir);
      return child;
    } catch (error) {
      rmSync(cleanupDir, { recursive: true, force: true });
      throw error;
    }
  }
  return execa("bash", ["-lc", `exec ${bridge}`], {
    cwd: workspace,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    reject: false,
    // Never accumulate the child's output for `result.stdout`: the bridge
    // streams the WHOLE agent session over stdout (potentially gigabytes over
    // an hours-long run), the session consumes it incrementally, and nothing
    // reads the buffered result - with buffering on, execa retains every byte
    // until the process exits, a leading memory leak in a long-running daemon.
    buffer: false,
    env: hostAgentBinaryEnv(),
    detached: true,
  }) as unknown as ChildProcessWithoutNullStreams;
}

async function stopBridgeProcess(
  child: ChildProcessWithoutNullStreams,
  processGroup: boolean,
): Promise<void> {
  try {
    await stopChild(child, { processGroup });
  } finally {
    const cleanupDir = bridgeProcessCleanupDirs.get(child);
    if (cleanupDir) {
      bridgeProcessCleanupDirs.delete(child);
      await fs.rm(cleanupDir, { recursive: true, force: true });
    }
  }
}

function windowsBridgeGuardianScript(workspace: string, scriptPath: string): string {
  const encodedWorkspace = Buffer.from(workspace, "utf8").toString("base64");
  const encodedScriptPath = Buffer.from(scriptPath, "utf8").toString("base64");
  return String.raw`
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

public static class LorenzProcessJob
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static IntPtr Create()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        uint length = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref information, length))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error);
        }
        return job;
    }

    public static void Assign(IntPtr job, IntPtr process)
    {
        if (!AssignProcessToJobObject(job, process))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public static void Close(IntPtr job)
    {
        if (job != IntPtr.Zero && !CloseHandle(job))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public static async Task CopyInput(Stream source, Stream target)
    {
        try
        {
            await source.CopyToAsync(target);
        }
        finally
        {
            target.Close();
        }
    }

    public static Task CopyOutput(Stream source, Stream target)
    {
        return source.CopyToAsync(target);
    }
}
"@

$workspace = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedWorkspace}"))
$scriptPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedScriptPath}"))

$job = [LorenzProcessJob]::Create()
$process = $null
$exitCode = 1
try {
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = "bash.exe"
  $startInfo.Arguments = '"' + $scriptPath + '"'
  $startInfo.WorkingDirectory = $workspace
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw "bridge process did not start"
  }
  [LorenzProcessJob]::Assign($job, $process.Handle)
  $process.StandardInput.WriteLine("ready")
  $process.StandardInput.Flush()

  $stdinTask = [LorenzProcessJob]::CopyInput(
    [Console]::OpenStandardInput(),
    $process.StandardInput.BaseStream
  )
  $stdoutTask = [LorenzProcessJob]::CopyOutput(
    $process.StandardOutput.BaseStream,
    [Console]::OpenStandardOutput()
  )
  $stderrTask = [LorenzProcessJob]::CopyOutput(
    $process.StandardError.BaseStream,
    [Console]::OpenStandardError()
  )
  $process.WaitForExit()
  $exitCode = $process.ExitCode
  [LorenzProcessJob]::Close($job)
  $job = [IntPtr]::Zero
  [Threading.Tasks.Task]::WaitAll(
    [Threading.Tasks.Task[]]@($stdoutTask, $stderrTask)
  )
} finally {
  if ($job -ne [IntPtr]::Zero) {
    try {
      [LorenzProcessJob]::Close($job)
    } catch {
    }
  }
  if ($null -ne $process) {
    try {
      if (-not $process.HasExited) {
        $process.Kill()
        $process.WaitForExit()
      }
    } catch {
    }
    $process.Dispose()
  }
}
exit $exitCode
`;
}

function remoteBridgeScript(workspace: string, bridge: string): string {
  return [
    "set -m",
    `cd ${shellEscape(workspace)} || exit 1`,
    `bash -c ${shellEscape(bridge)} <&0 &`,
    "bridge_pid=$!",
    "cleaned=0",
    "cleanup() {",
    '  [ "$cleaned" -eq 1 ] && return',
    "  cleaned=1",
    "  trap - HUP INT TERM EXIT",
    '  kill -TERM -- "-$bridge_pid" 2>/dev/null || true',
    "  (",
    "    sleep 1",
    '    kill -KILL -- "-$bridge_pid" 2>/dev/null || true',
    "  ) &",
    "  force_pid=$!",
    '  wait "$bridge_pid" 2>/dev/null || true',
    '  wait "$force_pid" 2>/dev/null || true',
    "}",
    "trap cleanup HUP INT TERM EXIT",
    'wait "$bridge_pid"',
    "status=$?",
    "cleanup",
    'exit "$status"',
  ].join("\n");
}

function wireProcessEvents(session: Session): void {
  let stderr = "";
  session.process.stderr.setEncoding("utf8");
  session.process.stderr.on("data", (chunk: string) => {
    session.pendingTurns[0]?.touch();
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
    session.terminalError ??= new Error(message);
    session.onUpdate?.({ type: "process_exit", message, timestamp: new Date() });
    rejectPendingTurns(session, session.terminalError);
  });
}

function rejectPendingTurns(session: Session, error: Error): void {
  const pending = session.pendingTurns.splice(0);
  for (const turn of pending) turn.reject(error);
}

function rejectTimedOutSession(session: Session): void {
  const [timedOut, ...queued] = session.pendingTurns.splice(0);
  const queuedError = new Error("acp session stopped after turn timeout");
  session.terminalError = queuedError;
  timedOut?.reject(new Error("acp turn timed out"));
  for (const turn of queued) turn.reject(queuedError);
}

function submitEligiblePrompts(session: Session): void {
  for (const turn of session.pendingTurns) {
    if (!turn.trySubmitPrompt()) return;
  }
}

function supportsPromptQueue(init: InitializeResponse): boolean {
  return init.agentCapabilities?._meta?.["symphony/promptQueueing"] === true;
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
