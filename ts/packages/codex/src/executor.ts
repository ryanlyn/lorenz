import type {
  AgentExecutor,
  AgentSession,
  AgentUpdate,
  AgentUpdateType,
  CodexSettings,
  Issue,
  Settings,
  UsageTotals,
} from "@symphony/domain";
import type { SessionUpdate, SessionUpdateKind } from "@symphony/protocol";
import { executeTool, toolSpecs } from "@symphony/mcp";
import { shellEscape, startSshProcess } from "@symphony/ssh";
import { validateWorkspaceCwd } from "@symphony/workspace";
import { match, P } from "ts-pattern";
import {
  CancellationTokenSource,
  ResponseError,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc";
import { z } from "zod";

import { CodexProcess } from "./process.js";
import { CodexNdjsonMessageReader, CodexNdjsonMessageWriter } from "./transport.js";

export interface CodexSession extends AgentSession {
  process: CodexProcess;
  connection: MessageConnection;
  threadId: string;
  settings: Settings;
  workspace: string;
  onUpdate?: ((update: AgentUpdate) => void) | undefined;
  inboundRequests: Map<string, Array<Record<string, unknown> & { method: string }>>;
  exitMessage?: string | undefined;
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
      ? new CodexProcess(
          startSshProcess(
            input.workerHost,
            `cd ${shellEscape(workspace)} && ${input.settings.codex.command}`,
          ),
        )
      : new CodexProcess(input.settings.codex.command, workspace);
    const reader = new CodexNdjsonMessageReader(process.child.stdout, {
      requestIdOffset: 1,
      onMalformedLine: (line) => {
        if (protocolMessageCandidate(line)) {
          this.emit(session, { type: "malformed", message: line, timestamp: new Date() });
        } else {
          session.onUpdate?.({ type: "stderr", message: line, timestamp: new Date() });
        }
      },
      onNotification: (message) => this.handleNotification(session, message),
      onRequest: (message) => {
        const queue = session.inboundRequests.get(message.method) ?? [];
        queue.push(message);
        session.inboundRequests.set(message.method, queue);
      },
    });
    const connection = createMessageConnection(
      reader,
      new CodexNdjsonMessageWriter(process.child.stdin, { requestIdOffset: 1 }),
    );
    const session: CodexSession = {
      agentKind: "codex",
      process,
      connection,
      threadId: "",
      settings: input.settings,
      workspace,
      sessionId: null,
      resumeId: input.resumeId ?? null,
      executorPid: process.child.pid === undefined ? null : String(process.child.pid),
      onUpdate: input.onUpdate,
      inboundRequests: new Map(),
      stop: async () => {
        connection.dispose();
        await process.stop();
      },
    };

    this.registerConnectionHandlers(session);
    connection.listen();

    process.onStderr((line) => {
      session.onUpdate?.({ type: "stderr", message: line, timestamp: new Date() });
    });
    process.onExit((code, signal) => {
      const message = `codex app-server exited${code === null ? "" : ` with status ${code}`}${signal ? ` signal ${signal}` : ""}`;
      session.exitMessage = message;
      connection.dispose();
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
    await connection.sendNotification("initialized", {});

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
          dynamicTools: toolSpecs(input.settings),
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
        summary: session.settings.codex.reasoning?.summary ?? undefined,
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

  private async request(
    session: CodexSession,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!canWriteToProcess(session.process)) {
      return Promise.reject(new Error(`codex send failed for ${method}: process unavailable`));
    }

    const source = new CancellationTokenSource();
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined),
    );
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      source.cancel();
    }, session.settings.codex.readTimeoutMs);

    return session.connection
      .sendRequest(method, cleanParams, source.token)
      .catch((error: unknown) => {
        if (timedOut) throw new Error(`codex read timeout waiting for ${method}`);
        if (session.exitMessage) throw new Error(session.exitMessage);
        if (error instanceof ResponseError) throw new Error(JSON.stringify(error.toJson()));
        throw error;
      })
      .finally(() => {
        clearTimeout(timeout);
        source.dispose();
      });
  }

  private registerConnectionHandlers(session: CodexSession): void {
    for (const method of approvalRequestMethods) {
      session.connection.onRequest(method, async () => {
        const message = this.consumeInboundRequest(session, method);
        return this.handleApprovalRequest(session, message, method);
      });
    }

    for (const method of userInputRequestMethods) {
      session.connection.onRequest(method, async () => {
        const message = this.consumeInboundRequest(session, method);
        return this.handleUserInputRequest(session, message);
      });
    }

    session.connection.onRequest("item/tool/call", async () => {
      const message = this.consumeInboundRequest(session, "item/tool/call");
      return this.handleDynamicToolCall(session, message);
    });

    session.connection.onRequest(async (method) => {
      const message = this.consumeInboundRequest(session, method);
      this.emit(session, { type: "notification", message, timestamp: new Date() });
      return unresolvedRequest();
    });
  }

  private consumeInboundRequest(
    session: CodexSession,
    method: string,
  ): Record<string, unknown> & { method: string } {
    const queue = session.inboundRequests.get(method);
    const message = queue?.shift();
    if (queue && queue.length === 0) session.inboundRequests.delete(method);
    return message ?? { method };
  }

  private handleNotification(session: CodexSession, value: unknown): void {
    if (!isRecord(value)) return;

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

    void Promise.resolve(
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
          void this.handleDynamicToolCall(session, message).catch((err) => {
            process.stderr.write(`handleDynamicToolCall failed: ${err}\n`);
          });
        })
        .with({ method: P.union(...approvalRequestMethods) }, async (message) =>
          this.handleApprovalRequest(session, message, message.method),
        )
        .with({ method: P.union(...userInputRequestMethods) }, async (message) =>
          this.handleUserInputRequest(session, message),
        )
        .exhaustive(),
    ).catch((err) => {
      process.stderr.write(`message dispatch failed: ${err}\n`);
    });
  }

  private handleApprovalRequest(
    session: CodexSession,
    value: Record<string, unknown>,
    method: ApprovalRequestMethod,
  ): Record<string, string> | Promise<never> {
    if (!autoApproveRequests(session)) {
      this.emit(session, {
        type: "approval_required",
        message: value,
        timestamp: new Date(),
      });
      return unresolvedRequest();
    }
    const decision =
      method === "execCommandApproval" || method === "applyPatchApproval"
        ? "approved_for_session"
        : "acceptForSession";
    this.emit(session, {
      type: "approval_auto_approved",
      message: { request: value, decision },
      timestamp: new Date(),
    });
    return { decision };
  }

  private handleUserInputRequest(
    session: CodexSession,
    value: Record<string, unknown>,
  ): { answers: UserInputAnswers } | Promise<never> {
    const answers = autoApproveRequests(session)
      ? autoUserInputAnswers(value)
      : nonInteractiveUserInputAnswers(value);
    if (Object.keys(answers).length === 0) {
      this.emit(session, {
        type: "turn_input_required",
        message: value,
        timestamp: new Date(),
      });
      return unresolvedRequest();
    }
    this.emit(session, {
      type: "tool_input_auto_answered",
      message: { request: value, answers },
      timestamp: new Date(),
    });
    return { answers };
  }

  private async handleDynamicToolCall(
    session: CodexSession,
    value: Record<string, unknown>,
  ): Promise<DynamicToolWireResult> {
    const params = dynamicToolCallParamsSchema.parse(value.params);
    const toolName = params.name ?? params.tool ?? null;
    const args = params.arguments;

    const toolResult =
      toolName === null
        ? { success: false, error: "missing dynamic tool name" }
        : await executeTool(toolName, args, session.settings);

    const output =
      toolResult.result === undefined
        ? (toolResult.error ?? "")
        : JSON.stringify(toolResult.result);
    const wireResult: DynamicToolWireResult = {
      success: toolResult.success,
      output,
      contentItems: [{ type: "inputText", text: output }],
    };

    this.emit(session, {
      type: wireResult.success ? "tool_call_completed" : "tool_call_failed",
      message: { request: value, result: wireResult },
      timestamp: new Date(),
    });
    return wireResult;
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

function codexProtocolKind(type: AgentUpdateType): SessionUpdateKind {
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
  const result = usageTotalsSchema.safeParse(value);
  if (!result.success) return {};
  const out: Partial<UsageTotals> = {};
  if (result.data.inputTokens !== undefined) out.inputTokens = result.data.inputTokens;
  if (result.data.outputTokens !== undefined) out.outputTokens = result.data.outputTokens;
  if (result.data.totalTokens !== undefined) out.totalTokens = result.data.totalTokens;
  return out;
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

type ApprovalRequestMethod = (typeof approvalRequestMethods)[number];

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

const rawParamsSchema = z.record(z.string(), z.unknown());

const optionalNonEmptyStringSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined),
  z.string().optional(),
);

const USAGE_INPUT_KEYS = ["input_tokens", "inputTokens", "input", "prompt_tokens"];
const USAGE_OUTPUT_KEYS = ["output_tokens", "outputTokens", "output", "completion_tokens"];
const USAGE_TOTAL_KEYS = ["total_tokens", "totalTokens", "total"];

// Token usage can arrive either nested under `params` (e.g.
// thread/tokenUsage/updated → params.tokenUsage.total) or as a top-level field
// on the message itself, a sibling of `params` (e.g. the `usage` field on
// turn/completed). Collect every plausible container from both levels so the
// first one carrying token numbers wins.
function usageCandidates(value: unknown): Record<string, unknown>[] {
  const record = isRecord(value) ? value : {};
  const params = isRecord(record.params) ? record.params : {};
  const candidates: Record<string, unknown>[] = [];
  for (const container of [record, params]) {
    const tokenUsage = isRecord(container.tokenUsage) ? container.tokenUsage : undefined;
    if (tokenUsage && isRecord(tokenUsage.total)) candidates.push(tokenUsage.total);
    if (tokenUsage) candidates.push(tokenUsage);
    if (isRecord(container.usage)) candidates.push(container.usage);
    if (isRecord(container.total_token_usage)) candidates.push(container.total_token_usage);
    candidates.push(container);
  }
  return candidates;
}

const usageTotalsSchema = z.preprocess(
  (value) => {
    const candidates = usageCandidates(value);
    const usage =
      candidates.find(
        (candidate) =>
          tokenNumberFromAny(candidate, USAGE_INPUT_KEYS) !== undefined ||
          tokenNumberFromAny(candidate, USAGE_OUTPUT_KEYS) !== undefined ||
          tokenNumberFromAny(candidate, USAGE_TOTAL_KEYS) !== undefined,
      ) ?? {};
    return {
      inputTokens: tokenNumberFromAny(usage, USAGE_INPUT_KEYS),
      outputTokens: tokenNumberFromAny(usage, USAGE_OUTPUT_KEYS),
      totalTokens: tokenNumberFromAny(usage, USAGE_TOTAL_KEYS),
    };
  },
  z.object({
    inputTokens: z.number().finite().optional(),
    outputTokens: z.number().finite().optional(),
    totalTokens: z.number().finite().optional(),
  }),
);

const dynamicToolCallParamsSchema = z.preprocess(
  (value) => (isRecord(value) ? value : {}),
  z
    .object({
      name: optionalNonEmptyStringSchema,
      tool: optionalNonEmptyStringSchema,
      arguments: z.preprocess((value) => (isRecord(value) ? value : {}), rawParamsSchema),
    })
    .passthrough()
    .transform((params) => ({
      ...params,
      arguments: params.arguments ?? {},
    })),
);

const userInputParamsSchema = z.preprocess(
  (value) => (isRecord(value) ? value : {}),
  z
    .object({
      questions: z.array(z.unknown()).optional(),
    })
    .passthrough()
    .transform((params) => ({ questions: params.questions ?? [] })),
);

function tokenNumberFromAny(raw: unknown, keys: string[]): number | undefined {
  if (!isRecord(raw)) return undefined;
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

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

interface DynamicToolWireResult {
  success: boolean;
  output: string;
  contentItems: Array<{ type: "inputText"; text: string }>;
}

const nonInteractiveToolInputAnswer =
  "Unable to provide interactive input in this non-interactive Symphony run.";

async function unresolvedRequest(): Promise<never> {
  return new Promise<never>(() => {});
}

function canWriteToProcess(process: CodexProcess): boolean {
  return process.child.stdin.writable && process.child.exitCode === null && !process.child.killed;
}

function autoUserInputAnswers(value: Record<string, unknown>): UserInputAnswers {
  const { questions } = userInputParamsSchema.parse(value.params);
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
  const { questions } = userInputParamsSchema.parse(value.params);
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
  value: CodexSettings["approvalPolicy"],
): CodexSettings["approvalPolicy"] {
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
