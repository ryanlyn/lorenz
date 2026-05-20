import fs from "node:fs/promises";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
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
import { acquireAgentMcpEndpoint, type AgentMcpEndpointLease } from "@symphony/mcp";
import { stopChild, withTimeout } from "@symphony/child-process";
import { actionForStopReason } from "@symphony/policies/stopReason";
import { shellEscape, startSshProcess } from "@symphony/ssh";
import { validateWorkspaceCwd } from "@symphony/workspace";
import { execa } from "execa";
import type {
  AcpAgentConfig,
  AgentKind,
  AgentExecutor,
  AgentSession,
  AgentUpdate,
  AgentUpdateType,
  Issue,
  Settings,
  UsageTotals,
} from "@symphony/domain";
import type { SessionUpdateKind } from "@symphony/protocol";

export interface AcpSession extends AgentSession {
  connection: ClientSideConnection;
  process: ChildProcessWithoutNullStreams;
  settings: Settings;
  workspace: string;
  agentConfig: AcpAgentConfig;
  init: InitializeResponse;
  mcpEndpoint: AgentMcpEndpointLease;
  workerHost?: string | null | undefined;
  onUpdate?: ((update: AgentUpdate) => void) | undefined;
  loadingReplay: boolean;
  replayedUpdateCount: number;
  pendingTurn?: { reject: (error: Error) => void } | undefined;
}

export class AcpExecutor implements AgentExecutor {
  readonly kind: AgentKind;

  constructor(kind = "acp") {
    this.kind = kind;
  }

  async startSession(input: {
    workspace: string;
    issue?: Issue;
    settings: Settings;
    resumeId?: string | null;
    workerHost?: string | null;
    onUpdate?: (update: AgentUpdate) => void;
  }): Promise<AcpSession> {
    const workspace = await validateWorkspaceCwd(
      input.settings,
      input.workspace,
      input.workerHost ?? null,
    );
    const agentKind = input.settings.agent.kind;
    const agentConfig = acpAgentConfig(input.settings, agentKind);
    let mcpEndpoint: AgentMcpEndpointLease | null = null;
    let child: ChildProcessWithoutNullStreams | null = null;
    let session: AcpSession | null = null;
    try {
      mcpEndpoint = await acquireAgentMcpEndpoint(input.settings, input.workerHost ?? null);
      child = startBridgeProcess(agentConfig, workspace, input.workerHost ?? null);
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

      const nextSession: AcpSession = {
        agentKind,
        connection,
        process: child,
        settings: input.settings,
        workspace,
        agentConfig,
        init,
        mcpEndpoint,
        workerHost: input.workerHost ?? null,
        sessionId: input.resumeId ?? null,
        resumeId: input.resumeId ?? null,
        executorPid,
        onUpdate: input.onUpdate,
        loadingReplay: false,
        replayedUpdateCount: 0,
        stop: async () => {
          await this.stopSession(nextSession);
        },
      };
      session = nextSession;
      wireProcessEvents(session);

      const sessionId = await openAcpSession(session, input.resumeId ?? null, [
        mcpEndpoint.acpServer(),
      ]);
      session.sessionId = sessionId;
      session.resumeId = sessionId;
      this.emit(session, {
        type: "session_started",
        sessionId,
        resumeId: sessionId,
        executorPid,
        timestamp: new Date(),
      });
      return session;
    } catch (error) {
      if (session) await this.stopSession(session);
      else {
        if (child) await stopChild(child);
        await mcpEndpoint?.release();
      }
      throw error;
    }
  }

  async runTurn(session: AcpSession, prompt: string, _issue?: Issue): Promise<AgentUpdate[]> {
    if (session.pendingTurn) throw new Error("ACP turn already running");
    const previous = session.onUpdate;
    const updates: AgentUpdate[] = [];
    let settled = false;

    return new Promise<AgentUpdate[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        void session.connection.cancel({ sessionId: requireAcpSessionId(session) });
        finishReject(new Error("acp turn timed out"));
      }, session.agentConfig.turnTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
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

      session.pendingTurn = { reject: finishReject };
      session.onUpdate = (update) => {
        updates.push(update);
        previous?.(update);
      };

      const sessionId = requireAcpSessionId(session);
      this.emit(session, {
        type: "turn_started",
        sessionId,
        resumeId: session.resumeId,
        message: { prompt: [{ type: "text", text: prompt }] },
        timestamp: new Date(),
      });

      session.connection
        .prompt({
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        })
        .then((response) => {
          const usage = extractAcpUsage(response.usage ?? undefined);
          if (usage) {
            this.emit(session, {
              type: "usage",
              sessionId,
              resumeId: session.resumeId,
              usage,
              message: { response },
              timestamp: new Date(),
            });
          }
          const action = actionForStopReason(response.stopReason);
          if (action === "continue") {
            const completion = this.update(session, "turn_completed", { response }, usage);
            this.emit(session, completion);
            finishResolve([...updates]);
          } else if (action === "cancel") {
            const cancellation = this.update(session, "turn_cancelled", { response }, usage);
            this.emit(session, cancellation);
            finishReject(new Error("acp_turn_cancelled"));
          } else {
            const failure = this.update(session, "turn_failed", { response }, usage);
            this.emit(session, failure);
            finishReject(new Error(`acp_turn_failed: ${response.stopReason}`));
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.emit(session, {
            type: "turn_failed",
            sessionId,
            resumeId: session.resumeId,
            message,
            timestamp: new Date(),
          });
          finishReject(error instanceof Error ? error : new Error(message));
        });
    });
  }

  private update(
    session: AcpSession,
    type: AgentUpdateType,
    message: unknown,
    usage?: Partial<UsageTotals>,
  ): AgentUpdate {
    const update: AgentUpdate = {
      type,
      sessionUpdate: acpProtocolUpdate(session, type, message, usage),
      sessionId: session.sessionId,
      resumeId: session.resumeId,
      executorPid: session.executorPid,
      message,
      timestamp: new Date(),
    };
    if (usage) update.usage = usage;
    return update;
  }

  private emit(session: AcpSession | null, update: AgentUpdate): void {
    session?.onUpdate?.(update);
  }

  private async stopSession(session: AcpSession): Promise<void> {
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
      await session.mcpEndpoint.release();
    }
  }
}

function handleAcpSessionUpdate(session: AcpSession, notification: SessionNotification): void {
  session.sessionId = notification.sessionId;
  session.resumeId = notification.sessionId;
  if (session.loadingReplay) {
    session.replayedUpdateCount += 1;
    return;
  }
  const update: AgentUpdate = {
    type: eventTypeForAcpUpdate(notification.update),
    sessionUpdate: acpProtocolUpdate(
      session,
      eventTypeForAcpUpdate(notification.update),
      notification,
      extractUsageUpdate(notification.update),
    ),
    sessionId: session.sessionId,
    resumeId: session.resumeId,
    executorPid: session.executorPid,
    message: notification,
    usage: extractUsageUpdate(notification.update),
    timestamp: new Date(),
  };
  if (!update.usage) delete update.usage;
  session.onUpdate?.(update);
}

function handleAcpPermissionRequest(
  session: AcpSession | null,
  request: RequestPermissionRequest,
  emit: (update: AgentUpdate) => void,
): RequestPermissionResponse {
  const selected =
    request.options.find((option) => option.kind.startsWith("allow")) ??
    request.options.find((option) => option.optionId.toLowerCase().includes("allow")) ??
    null;
  emit({
    type: selected ? "approval_auto_approved" : "approval_required",
    sessionId: request.sessionId,
    resumeId: session?.resumeId,
    executorPid: session?.executorPid,
    message: { request, selected },
    timestamp: new Date(),
  });
  if (!selected) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: selected.optionId } };
}

function acpClient(input: {
  workspace: string;
  workerHost: string | null;
  currentSession: () => AcpSession | null;
  emit: (update: AgentUpdate) => void;
}): Client {
  const executor = new AcpClientAdapter(
    input.workspace,
    input.workerHost,
    input.currentSession,
    input.emit,
  );
  return executor.client();
}

class AcpClientAdapter {
  constructor(
    private readonly workspace: string,
    private readonly workerHost: string | null,
    private readonly currentSession: () => AcpSession | null,
    private readonly emit: (update: AgentUpdate) => void,
  ) {}

  client(): Client {
    const client: Client = {
      sessionUpdate: async (params: SessionNotification) => {
        const session = this.currentSession();
        if (!session) return;
        handleAcpSessionUpdate(session, params);
      },
      requestPermission: async (params: RequestPermissionRequest) => {
        const session = this.currentSession();
        return handleAcpPermissionRequest(session, params, this.emit);
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

async function openAcpSession(
  session: AcpSession,
  resumeId: string | null,
  mcpServers: McpServer[],
): Promise<string> {
  if (resumeId && supportsResume(session.init)) {
    try {
      await withTimeout(
        session.connection.resumeSession({
          sessionId: resumeId,
          cwd: session.workspace,
          mcpServers,
        }),
        30_000,
        "acp resume timed out",
      );
      return resumeId;
    } catch (error) {
      session.onUpdate?.({
        type: "resume_state_warning",
        workspacePath: session.workspace,
        message: `acp_resume_failed: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date(),
      });
    }
  }

  if (resumeId && session.init.agentCapabilities?.loadSession) {
    try {
      session.loadingReplay = true;
      await withTimeout(
        session.connection.loadSession({ sessionId: resumeId, cwd: session.workspace, mcpServers }),
        30_000,
        "acp load timed out",
      );
      session.loadingReplay = false;
      if (session.replayedUpdateCount > 0) {
        session.onUpdate?.({
          type: "session_replay_suppressed",
          sessionId: resumeId,
          resumeId,
          message: { replayedUpdateCount: session.replayedUpdateCount },
          timestamp: new Date(),
        });
      }
      return resumeId;
    } catch (error) {
      session.loadingReplay = false;
      session.onUpdate?.({
        type: "resume_state_warning",
        workspacePath: session.workspace,
        message: `acp_load_failed: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date(),
      });
    }
  }

  const created = await withTimeout(
    session.connection.newSession({ cwd: session.workspace, mcpServers }),
    30_000,
    "acp new session timed out",
  );
  return created.sessionId;
}

function startBridgeProcess(
  agentConfig: AcpAgentConfig,
  workspace: string,
  workerHost: string | null,
): ChildProcessWithoutNullStreams {
  const command = `exec ${[agentConfig.bridgeCommand, ...agentConfig.bridgeArgs]
    .map(shellEscape)
    .join(" ")}`;
  if (workerHost) {
    return startSshProcess(workerHost, `cd ${shellEscape(workspace)} && ${command}`);
  }
  return execa("bash", ["-lc", command], {
    cwd: workspace,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    reject: false,
  }) as unknown as ChildProcessWithoutNullStreams;
}

function wireProcessEvents(session: AcpSession): void {
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

function eventTypeForAcpUpdate(update: SessionNotification["update"]): AgentUpdateType {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return "assistant_message";
    case "user_message_chunk":
      return "user_message";
    case "agent_thought_chunk":
      return "agent_thought";
    case "tool_call":
      return "tool_use_requested";
    case "tool_call_update":
      if (update.status === "completed") return "tool_result";
      if (update.status === "failed") return "tool_call_failed";
      return "tool_call_update";
    case "usage_update":
      return "usage";
    case "plan":
      return "plan";
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
      return "notification";
  }
}

function acpProtocolUpdate(
  session: AcpSession,
  type: AgentUpdateType,
  message: unknown,
  usage?: Partial<UsageTotals>,
): NonNullable<AgentUpdate["sessionUpdate"]> {
  const base = {
    kind: acpProtocolKind(type),
    sessionId: session.sessionId,
    agentKind: session.agentKind,
    message,
    at: new Date(),
    _meta: {
      executorPid: session.executorPid,
      usage,
    },
  };
  if (type === "usage" && usage) return { ...base, kind: "usage_update", usage };
  return base;
}

function acpProtocolKind(type: AgentUpdateType): SessionUpdateKind {
  if (type === "tool_use_requested") return "tool_call";
  if (type === "tool_result" || type === "tool_call_failed") return "tool_result";
  if (type === "turn_cancelled") return "turn_cancelled";
  if (type === "turn_completed") return "turn_completed";
  if (type === "turn_failed") return "turn_failed";
  if (type === "turn_started") return "turn_started";
  if (type === "session_started") return "session_started";
  return "notification";
}

function extractUsageUpdate(
  update: SessionNotification["update"],
): Partial<UsageTotals> | undefined {
  if (update.sessionUpdate !== "usage_update") return undefined;
  if (typeof update.used !== "number" || !Number.isFinite(update.used)) return undefined;
  return { totalTokens: update.used };
}

function extractAcpUsage(usage: Usage | undefined): Partial<UsageTotals> | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

function acpAgentConfig(settings: Settings, kind: AgentKind): AcpAgentConfig {
  const agent = settings.agents[kind];
  if (!agent) throw new Error(`agents.${kind} is required`);
  if (agent.executor !== "acp") throw new Error(`agents.${kind}.executor must be acp`);
  return agent;
}

function supportsResume(init: InitializeResponse): boolean {
  return Boolean(init.agentCapabilities?.sessionCapabilities?.resume);
}

function supportsClose(init: InitializeResponse): boolean {
  return Boolean(init.agentCapabilities?.sessionCapabilities?.close);
}

function requireAcpSessionId(session: AcpSession): string {
  if (!session.sessionId) throw new Error("acp session not started");
  return session.sessionId;
}
