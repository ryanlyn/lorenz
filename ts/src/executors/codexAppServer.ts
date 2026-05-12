import type {
  AgentExecutor,
  AgentSession,
  AgentUpdate,
  Issue,
  Settings,
  UsageTotals,
} from "../types.js";
import type { SessionUpdate } from "../spec/session.js";
import { executeTool, toolSpecs } from "../tools.js";
import { shellEscape, startSshProcess } from "../ssh.js";
import { validateWorkspaceCwd } from "../workspace.js";
import { JsonLineProcess } from "./jsonLineProcess.js";
import { match, P } from "ts-pattern";
import { z } from "zod";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexSession extends AgentSession {
  process: JsonLineProcess;
  threadId: string;
  settings: Settings;
  workspace: string;
  onUpdate?: ((update: AgentUpdate) => void) | undefined;
  pending: Map<number, PendingRequest>;
  nextId: number;
}

export class CodexAppServerExecutor implements AgentExecutor {
  readonly kind = "codex" as const;

  async startSession(input: {
    workspace: string;
    issue?: Issue;
    settings: Settings;
    resumeId?: string | null;
    workerHost?: string | null;
    onUpdate?: (update: AgentUpdate) => void;
  }): Promise<CodexSession> {
    const workspace = await validateWorkspaceCwd(
      input.settings,
      input.workspace,
      input.workerHost ?? null,
    );
    const process = input.workerHost
      ? new JsonLineProcess(
          startSshProcess(
            input.workerHost,
            `cd ${shellEscape(workspace)} && ${input.settings.codex.command}`,
          ),
        )
      : new JsonLineProcess(input.settings.codex.command, workspace);
    const session: CodexSession = {
      agentKind: "codex",
      process,
      threadId: "",
      settings: input.settings,
      workspace,
      sessionId: null,
      resumeId: input.resumeId ?? null,
      executorPid: process.child.pid === undefined ? null : String(process.child.pid),
      onUpdate: input.onUpdate,
      pending: new Map(),
      nextId: 1,
      stop: () => process.stop(),
    };

    process.onJson((value) => this.handleMessage(session, value));
    process.onStderr((line) => {
      session.onUpdate?.({ type: "stderr", message: line, timestamp: new Date() });
    });
    process.onMalformed((line) => {
      if (protocolMessageCandidate(line)) {
        this.emit(session, { type: "malformed", message: line, timestamp: new Date() });
      } else {
        session.onUpdate?.({ type: "stderr", message: line, timestamp: new Date() });
      }
    });
    process.onExit((code, signal) => {
      const message = `codex app-server exited${code === null ? "" : ` with status ${code}`}${signal ? ` signal ${signal}` : ""}`;
      for (const [id, pending] of session.pending.entries()) {
        session.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
      }
      this.emit(session, { type: "process_exit", message, timestamp: new Date() });
    });

    await this.request(session, "initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: "symphony-typescript-orchestrator",
        title: "Symphony TypeScript Orchestrator",
        version: "0.1.0",
      },
    });
    process.send({ method: "initialized", params: {} });

    const threadResult = input.resumeId
      ? await this.request(session, "thread/resume", {
          threadId: input.resumeId,
          cwd: workspace,
          approvalPolicy: approvalPolicyForWire(input.settings.codex.approvalPolicy),
          sandbox: input.settings.codex.threadSandbox,
          persistExtendedHistory: true,
        })
      : await this.request(session, "thread/start", {
          cwd: workspace,
          approvalPolicy: approvalPolicyForWire(input.settings.codex.approvalPolicy),
          sandbox: input.settings.codex.threadSandbox,
          dynamicTools: toolSpecs(),
        });

    const threadId = readNestedString(threadResult, ["thread", "id"]);
    if (!threadId) throw new Error("invalid thread response from codex app-server");
    session.threadId = threadId;
    session.resumeId = threadId;
    session.sessionId = null;
    this.emit(session, {
      type: "session_started",
      sessionId: null,
      resumeId: threadId,
      executorPid: session.executorPid,
    });
    return session;
  }

  async runTurn(session: CodexSession, prompt: string, issue?: Issue): Promise<AgentUpdate[]> {
    const previous = session.onUpdate;
    const updates: AgentUpdate[] = [];
    let resolveCompletion: (() => void) | null = null;
    let rejectCompletion: ((error: Error) => void) | null = null;
    let completionTimer: NodeJS.Timeout | null = null;

    const resetCompletionTimer = () => {
      if (completionTimer) clearTimeout(completionTimer);
      completionTimer = setTimeout(
        () => rejectCompletion?.(new Error("codex turn timed out")),
        session.settings.codex.turnTimeoutMs,
      );
    };

    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
      completionTimer = setTimeout(
        () => reject(new Error("codex turn timed out")),
        session.settings.codex.turnTimeoutMs,
      );
    });

    session.onUpdate = (update) => {
      updates.push(update);
      previous?.(update);

      if (update.type === "turn_completed") {
        if (completionTimer) clearTimeout(completionTimer);
        resolveCompletion?.();
      } else if (
        update.type === "turn_failed" ||
        update.type === "turn_cancelled" ||
        update.type === "approval_required" ||
        update.type === "turn_input_required" ||
        update.type === "process_exit"
      ) {
        if (completionTimer) clearTimeout(completionTimer);
        rejectCompletion?.(
          new Error(typeof update.message === "string" ? update.message : update.type),
        );
      } else {
        resetCompletionTimer();
      }
    };
    try {
      const turnResult = await this.request(session, "turn/start", {
        threadId: session.threadId,
        input: [{ type: "text", text: prompt }],
        cwd: session.workspace,
        approvalPolicy: approvalPolicyForWire(session.settings.codex.approvalPolicy),
        sandboxPolicy: sandboxPolicyForWire(
          session.settings.codex.turnSandboxPolicy,
          session.workspace,
        ),
        title: turnTitle(issue),
      });
      const turnId = readNestedString(turnResult, ["turn", "id"]);
      const sessionId = turnId ? `${session.threadId}-${turnId}` : (session.sessionId ?? null);
      session.sessionId = sessionId;
      this.emit(session, { type: "turn_started", sessionId, resumeId: session.resumeId });
      await completion;
    } finally {
      if (completionTimer) clearTimeout(completionTimer);
      session.onUpdate = previous;
    }

    return updates;
  }

  private request(
    session: CodexSession,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = session.nextId;
    session.nextId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`codex read timeout waiting for ${method}`));
      }, session.settings.codex.readTimeoutMs);

      session.pending.set(id, { resolve, reject, timer });
      const cleanParams = Object.fromEntries(
        Object.entries(params).filter(([, value]) => value !== undefined),
      );
      if (!session.process.send({ id, method, params: cleanParams })) {
        session.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`codex send failed for ${method}: process unavailable`));
      }
    });
  }

  private handleMessage(session: CodexSession, value: unknown): void {
    if (!isRecord(value)) return;
    const id = typeof value.id === "number" ? value.id : null;
    if (id !== null && session.pending.has(id)) {
      const pending = session.pending.get(id);
      if (!pending) return;
      session.pending.delete(id);
      clearTimeout(pending.timer);
      if (value.error) pending.reject(new Error(JSON.stringify(value.error)));
      else pending.resolve(value.result ?? {});
      return;
    }

    const parsed = codexNotificationSchema.safeParse(value);
    const method = parsed.success ? parsed.data.method : readString(value.method);
    if (method !== "thread/tokenUsage/updated") {
      const usage = extractUsage(value);
      if (Object.keys(usage).length > 0) {
        this.emit(session, {
          type: "usage",
          usage,
          message: value,
          timestamp: new Date(),
        });
      }
    }

    if (!parsed.success) {
      this.emit(session, { type: "notification", message: value, timestamp: new Date() });
      return;
    }

    match(parsed.data)
      .with({ method: "turn/completed" }, (message) =>
        this.emit(session, { type: "turn_completed", message, timestamp: new Date() }),
      )
      .with({ method: "turn/failed" }, (message) =>
        this.emit(session, { type: "turn_failed", message, timestamp: new Date() }),
      )
      .with({ method: "turn/cancelled" }, (message) =>
        this.emit(session, { type: "turn_cancelled", message, timestamp: new Date() }),
      )
      .with({ method: "thread/tokenUsage/updated" }, (message) =>
        this.emit(session, {
          type: "usage",
          usage: extractUsage(message),
          message,
          timestamp: new Date(),
        }),
      )
      .with({ method: "rateLimits/updated" }, (message) =>
        this.emit(session, {
          type: "rate_limit",
          rateLimits: message.params,
          message,
          timestamp: new Date(),
        }),
      )
      .with({ method: "item/tool/call" }, (message) => {
        void this.handleDynamicToolCall(session, message);
      })
      .with({ method: P.union(...approvalRequestMethods) }, (message) =>
        this.handleApprovalRequest(session, message, message.method),
      )
      .with({ method: P.union(...userInputRequestMethods) }, (message) =>
        this.handleUserInputRequest(session, message),
      )
      .exhaustive();
  }

  private handleApprovalRequest(
    session: CodexSession,
    value: Record<string, unknown>,
    method: string,
  ): void {
    const id = typeof value.id === "number" || typeof value.id === "string" ? value.id : null;
    if (!autoApproveRequests(session)) {
      this.emit(session, {
        type: "approval_required",
        message: value,
        timestamp: new Date(),
      });
      return;
    }
    const decision =
      method === "execCommandApproval" || method === "applyPatchApproval"
        ? "approved_for_session"
        : "acceptForSession";
    const sent = id !== null && session.process.send({ id, result: { decision } });
    this.emit(session, {
      type: sent ? "approval_auto_approved" : "approval_reply_failed",
      message: { request: value, decision },
      timestamp: new Date(),
    });
  }

  private handleUserInputRequest(session: CodexSession, value: Record<string, unknown>): void {
    const id = typeof value.id === "number" || typeof value.id === "string" ? value.id : null;
    const answers = autoApproveRequests(session)
      ? autoUserInputAnswers(value)
      : nonInteractiveUserInputAnswers(value);
    if (Object.keys(answers).length === 0) {
      this.emit(session, {
        type: "turn_input_required",
        message: value,
        timestamp: new Date(),
      });
      return;
    }
    const sent = id !== null && session.process.send({ id, result: { answers } });
    this.emit(session, {
      type: sent ? "tool_input_auto_answered" : "tool_input_reply_failed",
      message: { request: value, answers },
      timestamp: new Date(),
    });
  }

  private async handleDynamicToolCall(
    session: CodexSession,
    value: Record<string, unknown>,
  ): Promise<void> {
    const id = typeof value.id === "number" || typeof value.id === "string" ? value.id : null;
    const params = isRecord(value.params) ? value.params : {};
    const toolName = readString(params.name) ?? readString(params.tool);
    const args = isRecord(params.arguments) ? params.arguments : {};

    const toolResult =
      toolName === null
        ? { success: false, error: "missing dynamic tool name" }
        : await executeTool(toolName, args, session.settings);

    const output =
      toolResult.result === undefined
        ? (toolResult.error ?? "")
        : JSON.stringify(toolResult.result);
    const wireResult = {
      success: toolResult.success,
      output,
      contentItems: [{ type: "inputText", text: output }],
    };

    if (id !== null) {
      session.process.send({ id, result: wireResult });
    }

    this.emit(session, {
      type: wireResult.success ? "tool_call_completed" : "tool_call_failed",
      message: { request: value, result: wireResult },
      timestamp: new Date(),
    });
  }

  private emit(session: CodexSession, update: AgentUpdate): void {
    update.sessionUpdate ??= codexProtocolUpdate(session, update);
    session.onUpdate?.(update);
  }
}

function codexProtocolUpdate(session: CodexSession, update: AgentUpdate): SessionUpdate {
  const base = {
    kind: codexProtocolKind(update.type),
    sessionId: update.sessionId ?? session.sessionId,
    agentKind: session.agentKind,
    at: update.timestamp ?? new Date(),
    _meta: {
      executorPid: update.executorPid ?? session.executorPid,
      rateLimits: update.rateLimits,
      usage: update.usage,
    },
  };
  if (update.type === "usage" && update.usage) {
    return { ...base, kind: "usage_update", usage: update.usage };
  }
  return { ...base, message: update.message };
}

function codexProtocolKind(type: string): string {
  if (type === "tool_use_requested" || type === "tool_call_completed") return "tool_call";
  if (type === "tool_result" || type === "tool_call_failed") return "tool_result";
  if (type === "turn_cancelled") return "turn_cancelled";
  if (type === "turn_completed") return "turn_completed";
  if (type === "turn_failed") return "turn_failed";
  if (type === "turn_started") return "turn_started";
  if (type === "session_started") return "session_started";
  return "notification";
}

function extractUsage(value: Record<string, unknown>): Partial<UsageTotals> {
  const payload = isRecord(value.params) ? value.params : value;
  const usage = isRecord(payload.usage)
    ? payload.usage
    : isRecord(payload.total_token_usage)
      ? payload.total_token_usage
      : payload;
  const out: Partial<UsageTotals> = {};
  const inputTokens = numberFromAny(usage, [
    "input_tokens",
    "inputTokens",
    "input",
    "prompt_tokens",
  ]);
  const outputTokens = numberFromAny(usage, [
    "output_tokens",
    "outputTokens",
    "output",
    "completion_tokens",
  ]);
  const totalTokens = numberFromAny(usage, ["total_tokens", "totalTokens", "total"]);
  if (inputTokens !== undefined) out.inputTokens = inputTokens;
  if (outputTokens !== undefined) out.outputTokens = outputTokens;
  if (totalTokens !== undefined) out.totalTokens = totalTokens;
  return out;
}

function numberFromAny(raw: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readNestedString(raw: unknown, path: string[]): string | null {
  let current = raw;
  for (const segment of path) {
    if (!isRecord(current)) return null;
    current = current[segment];
  }
  return typeof current === "string" ? current : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const codexMessageSchema = <const Method extends string>(method: Method) =>
  z.object({ method: z.literal(method) }).passthrough();

const approvalRequestMethods = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
] as const;

const userInputRequestMethods = [
  "item/tool/requestUserInput",
  "tool/requestUserInput",
  "turn/input_required",
] as const;

const codexNotificationSchema = z.discriminatedUnion("method", [
  codexMessageSchema("turn/completed"),
  codexMessageSchema("turn/failed"),
  codexMessageSchema("turn/cancelled"),
  codexMessageSchema("thread/tokenUsage/updated"),
  codexMessageSchema("rateLimits/updated"),
  codexMessageSchema("item/tool/call"),
  ...approvalRequestMethods.map(codexMessageSchema),
  ...userInputRequestMethods.map(codexMessageSchema),
]);

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function turnTitle(issue: Issue | undefined): string | undefined {
  if (!issue) return undefined;
  const raw = issue as unknown as Record<string, unknown>;
  const identifier = readString(raw.identifier);
  const title = readString(raw.title);
  if (identifier && title) return `${identifier}: ${title}`;
  if (identifier) return identifier;
  return undefined;
}

function protocolMessageCandidate(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function autoApproveRequests(session: CodexSession): boolean {
  return session.settings.codex.approvalPolicy === "never";
}

type UserInputAnswers = Record<string, { answers: string[] }>;

const nonInteractiveToolInputAnswer =
  "Unable to provide interactive input in this non-interactive Symphony run.";

function autoUserInputAnswers(value: Record<string, unknown>): UserInputAnswers {
  const params = isRecord(value.params) ? value.params : {};
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const answers: UserInputAnswers = {};
  for (const question of questions) {
    if (!isRecord(question)) continue;
    const id =
      readString(question.id) ??
      readString(question.header) ??
      `question_${Object.keys(answers).length + 1}`;
    const options = Array.isArray(question.options) ? question.options : [];
    const first = options.find(isRecord);
    const answer =
      first && typeof first.label === "string" ? first.label : nonInteractiveToolInputAnswer;
    answers[id] = { answers: [answer] };
  }
  return answers;
}

function nonInteractiveUserInputAnswers(value: Record<string, unknown>): UserInputAnswers {
  const params = isRecord(value.params) ? value.params : {};
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const answers: UserInputAnswers = {};
  for (const question of questions) {
    if (!isRecord(question)) continue;
    const id = readString(question.id);
    if (!id) continue;
    answers[id] = { answers: [nonInteractiveToolInputAnswer] };
  }
  return answers;
}

function approvalPolicyForWire(
  value: string | Record<string, unknown>,
): string | Record<string, unknown> {
  return value;
}

function sandboxPolicyForWire(
  value: Record<string, unknown> | null,
  workspace: string,
): Record<string, unknown> {
  if (value !== null) return value;
  return {
    type: "workspaceWrite",
    writableRoots: [workspace],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}
