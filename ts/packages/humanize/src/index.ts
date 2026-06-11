export function humanizeAgentMessage(message: unknown): string {
  if (message === null || message === undefined) return "no agent message yet";
  const record = isRecord(message) ? message : null;
  if (record?.agent_kind === "claude")
    return truncate(humanizeClaudeMessage(record) ?? humanizeCodexMessage(record), 140);
  if (record && isRecord(record.message) && typeof record.message.type === "string") {
    return truncate(humanizeClaudeMessage(record) ?? humanizeCodexMessage(record), 140);
  }
  return truncate(humanizeCodexMessage(message), 140);
}

export function humanizeCodexMessage(message: unknown): string {
  if (message === null || message === undefined) return "no codex message yet";
  if (isRecord(message) && "event" in message) {
    const payload = unwrapPayload(message.message);
    return (
      humanizeCodexEvent(String(message.event), message, payload) ?? humanizeCodexPayload(payload)
    );
  }
  if (isRecord(message) && "message" in message)
    return humanizeCodexPayload(unwrapPayload(message.message));
  return humanizeCodexPayload(unwrapPayload(message));
}

export function humanizeClaudeMessage(message: unknown): string | null {
  const record = isRecord(message) ? message : {};
  const event = typeof record.event === "string" ? record.event : null;
  const payload = unwrapPayload(record.message ?? message);
  return humanizeClaudeEvent(event, payload);
}

function humanizeClaudeEvent(event: string | null, payload: unknown): string | null {
  if (event === "session_started") {
    const sessionId = stringAt(payload, ["session_id"]) ?? stringAt(payload, ["sessionId"]);
    return sessionId ? `claude session started (${sessionId})` : "claude session started";
  }
  if (event === "turn_started") return "claude turn started";
  if (event === "turn_completed") return "claude turn completed";
  if (event === "permission_denied") return "claude permission denied";
  if (event === "turn_failed") return `claude turn failed: ${formatReason(payload)}`;
  if (event === "malformed") return "malformed JSON event from claude";
  return humanizeClaudePayload(payload);
}

function humanizeClaudePayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (
    payload.type === "assistant" &&
    isRecord(payload.message) &&
    Array.isArray(payload.message.content)
  ) {
    for (const content of payload.message.content) {
      if (!isRecord(content)) continue;
      if (content.type === "text" && typeof content.text === "string")
        return inlineText(content.text);
      if (content.type === "thinking") return "claude thinking";
      if (content.type === "tool_use" && typeof content.name === "string")
        return `tool requested (${content.name})`;
    }
    return "assistant update";
  }
  if (payload.type === "user" && isRecord(payload.tool_use_result)) {
    const toolName =
      stringAt(payload.tool_use_result, ["tool_name"]) ??
      stringAt(payload.tool_use_result, ["tool", "name"]);
    return toolName ? `tool completed (${toolName})` : "tool completed";
  }
  if (payload.type === "rate_limit_event" && isRecord(payload.rate_limit_info)) {
    return typeof payload.rate_limit_info.status === "string"
      ? `rate limit status: ${payload.rate_limit_info.status}`
      : "rate limit update";
  }
  if (payload.type === "result" && typeof payload.result === "string")
    return inlineText(payload.result);
  return null;
}

function humanizeCodexEvent(event: string, message: unknown, payload: unknown): string | null {
  if (event === "session_started") {
    const sessionId = stringAt(payload, ["session_id"]) ?? stringAt(payload, ["sessionId"]);
    return sessionId ? `session started (${sessionId})` : "session started";
  }
  if (event === "turn_input_required") return "turn blocked: waiting for user input";
  if (event === "approval_auto_approved") {
    const method =
      stringAt(payload, ["method"]) ??
      stringAt(message, ["payload", "method"]) ??
      stringAt(message, ["request", "method"]);
    const decision = stringAt(message, ["decision"]) ?? stringAt(message, ["message", "decision"]);
    const methodPayload = recordAt(payload, ["request"]) ?? payload;
    const base = method
      ? `${humanizeCodexMethod(method, methodPayload)} (auto-approved)`
      : "approval request auto-approved";
    return decision ? `${base}: ${decision}` : base;
  }
  if (event === "tool_input_auto_answered") {
    const answer = stringAt(message, ["answer"]);
    const base = `${humanizeCodexMethod("item/tool/requestUserInput", payload)} (auto-answered)`;
    return answer ? `${base}: ${inlineText(answer)}` : base;
  }
  if (event === "tool_call_update") {
    const status =
      (isRecord(payload) ? stringAt(payload, ["status"]) : null) ??
      (isRecord(payload) ? stringAt(payload, ["params", "status"]) : null);
    if (status === "completed")
      return humanizeDynamicToolEvent("dynamic tool call completed", payload);
    if (status === "failed") return humanizeDynamicToolEvent("dynamic tool call failed", payload);
  }
  if (event === "unsupported_tool_call")
    return humanizeDynamicToolEvent("unsupported dynamic tool call rejected", payload);
  if (event === "turn_ended_with_error") return `turn ended with error: ${formatReason(message)}`;
  if (event === "startup_failed") return `startup failed: ${formatReason(message)}`;
  if (event === "turn_completed") return "turn completed";
  if (event === "turn_failed") return humanizeCodexMethod("turn/failed", payload);
  if (event === "turn_cancelled") return "turn cancelled";
  if (event === "malformed") return "malformed JSON event from codex";
  return null;
}

function humanizeCodexPayload(payload: unknown): string {
  if (isRecord(payload)) {
    const hookExecution = humanizeHookExecution(payload);
    if (hookExecution) return hookExecution;
    const method = stringAt(payload, ["method"]);
    if (method) return humanizeCodexMethod(method, payload);
    const sessionId = stringAt(payload, ["session_id"]) ?? stringAt(payload, ["sessionId"]);
    if (sessionId) return `session started (${sessionId})`;
    if ("error" in payload) return `error: ${formatReason(payload.error)}`;
    return sanitize(JSON.stringify(payload));
  }
  return sanitize(String(payload));
}

function humanizeHookExecution(payload: Record<string, unknown>): string | null {
  const status = stringAt(payload, ["status"]);
  const command = stringAt(payload, ["command"]);
  if (!status || !command) return null;
  const hookName = stringAt(payload, ["hookName"]) ?? "hook";
  const exitCode = numberAt(payload, ["exitCode"]);
  const error = stringAt(payload, ["error"]);
  const suffix =
    exitCode !== null ? ` exit ${exitCode}` : error ? ` error: ${inlineText(error)}` : "";
  return `${hookName} hook ${status}: ${inlineText(command)}${suffix}`;
}

function humanizeCodexMethod(method: string, payload: unknown): string {
  if (method === "thread/started") {
    const threadId = stringAt(payload, ["params", "thread", "id"]);
    return threadId ? `thread started (${threadId})` : "thread started";
  }
  if (method === "turn/started") {
    const turnId = stringAt(payload, ["params", "turn", "id"]);
    return turnId ? `turn started (${turnId})` : "turn started";
  }
  if (method === "turn/completed") {
    const status = stringAt(payload, ["params", "turn", "status"]) ?? "completed";
    const usage =
      recordAt(payload, ["params", "usage"]) ??
      recordAt(payload, ["params", "tokenUsage"]) ??
      recordAt(payload, ["usage"]);
    const suffix = usage ? ` (${formatUsageCounts(usage)})` : "";
    return `turn completed (${status})${suffix}`;
  }
  if (method === "turn/failed") {
    const errorMessage = stringAt(payload, ["params", "error", "message"]);
    return errorMessage ? `turn failed: ${errorMessage}` : "turn failed";
  }
  if (method === "turn/cancelled") return "turn cancelled";
  if (method === "turn/diff/updated") {
    const diff = stringAt(payload, ["params", "diff"]);
    return diff
      ? `turn diff updated (${diff.split("\n").filter(Boolean).length} lines)`
      : "turn diff updated";
  }
  if (method === "turn/plan/updated") {
    const plan =
      arrayAt(payload, ["params", "plan"]) ??
      arrayAt(payload, ["params", "steps"]) ??
      arrayAt(payload, ["params", "items"]);
    return Array.isArray(plan) ? `plan updated (${plan.length} steps)` : "plan updated";
  }
  if (method === "thread/tokenUsage/updated") {
    const usage =
      recordAt(payload, ["params", "tokenUsage", "total"]) ?? recordAt(payload, ["usage"]);
    return usage
      ? `thread token usage updated (${formatUsageCounts(usage)})`
      : "thread token usage updated";
  }
  if (method === "item/started") return humanizeItemLifecycle("started", payload);
  if (method === "item/completed") return humanizeItemLifecycle("completed", payload);
  if (method === "item/agentMessage/delta")
    return humanizeStreamingEvent("agent message streaming", payload);
  if (method === "item/plan/delta") return humanizeStreamingEvent("plan streaming", payload);
  if (method === "item/reasoning/summaryTextDelta")
    return humanizeStreamingEvent("reasoning summary streaming", payload);
  if (method === "item/reasoning/summaryPartAdded")
    return humanizeStreamingEvent("reasoning summary section added", payload);
  if (method === "item/reasoning/textDelta")
    return humanizeStreamingEvent("reasoning text streaming", payload);
  if (method === "item/commandExecution/outputDelta")
    return humanizeStreamingEvent("command output streaming", payload);
  if (method === "item/fileChange/outputDelta")
    return humanizeStreamingEvent("file change output streaming", payload);
  if (method === "item/commandExecution/requestApproval") {
    const command = stringAt(payload, ["params", "command"]);
    return command ? `command approval requested (${command})` : "command approval requested";
  }
  if (method === "item/fileChange/requestApproval") {
    const count =
      numberAt(payload, ["params", "fileChangeCount"]) ??
      numberAt(payload, ["params", "changeCount"]);
    return count && count > 0
      ? `file change approval requested (${count} files)`
      : "file change approval requested";
  }
  if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
    const question =
      stringAt(payload, ["params", "question"]) ?? stringAt(payload, ["params", "prompt"]);
    return question
      ? `tool requires user input: ${inlineText(question)}`
      : "tool requires user input";
  }
  if (method === "account/updated")
    return `account updated (auth ${stringAt(payload, ["params", "authMode"]) ?? "unknown"})`;
  if (method === "account/rateLimits/updated") return "rate limits updated";
  if (method === "account/chatgptAuthTokens/refresh") return "account auth token refresh requested";
  if (method === "item/tool/call") {
    const tool = dynamicToolName(payload);
    return tool ? `dynamic tool call requested (${tool})` : "dynamic tool call requested";
  }
  if (method.startsWith("codex/event/"))
    return humanizeCodexWrapperEvent(method.slice("codex/event/".length), payload);
  return method;
}

function humanizeCodexWrapperEvent(event: string, payload: unknown): string {
  if (event === "agent_message_delta")
    return humanizeStreamingEvent("agent message streaming", payload);
  if (event === "agent_message_content_delta")
    return humanizeStreamingEvent("agent message content streaming", payload);
  if (event === "agent_reasoning_delta")
    return humanizeStreamingEvent("reasoning streaming", payload);
  if (event === "reasoning_content_delta")
    return humanizeStreamingEvent("reasoning content streaming", payload);
  if (event === "exec_command_output_delta") return "command output streaming";
  return event;
}

function humanizeDynamicToolEvent(base: string, payload: unknown): string {
  const tool = dynamicToolName(payload);
  return tool ? `${base} (${tool})` : base;
}

function dynamicToolName(payload: unknown): string | null {
  return (
    stringAt(payload, ["params", "tool"]) ??
    stringAt(payload, ["params", "name"]) ??
    stringAt(payload, ["request", "params", "tool"]) ??
    stringAt(payload, ["request", "params", "name"])
  );
}

function humanizeItemLifecycle(state: string, payload: unknown): string {
  const item = recordAt(payload, ["params", "item"]);
  const itemType = item ? stringAt(item, ["type"]) : null;
  return itemType ? `item ${state} (${itemType})` : `item ${state}`;
}

function humanizeStreamingEvent(base: string, payload: unknown): string {
  const delta = stringAt(payload, ["params", "delta"]) ?? stringAt(payload, ["params", "text"]);
  return delta ? `${base}: ${inlineText(delta)}` : base;
}

function unwrapPayload(message: unknown): unknown {
  if (isRecord(message)) {
    if (
      typeof message.method === "string" ||
      typeof message.session_id === "string" ||
      typeof message.reason === "string"
    )
      return message;
    if ("payload" in message) return message.payload;
  }
  return message;
}

function formatUsageCounts(usage: Record<string, unknown>): string {
  const input = numberAt(usage, ["input_tokens"]) ?? numberAt(usage, ["inputTokens"]);
  const output = numberAt(usage, ["output_tokens"]) ?? numberAt(usage, ["outputTokens"]);
  const total =
    numberAt(usage, ["total_tokens"]) ??
    numberAt(usage, ["totalTokens"]) ??
    numberAt(usage, ["total"]);
  return `in ${input ?? 0} out ${output ?? 0} total ${total ?? 0}`;
}

function formatReason(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value))
    return stringAt(value, ["message"]) ?? stringAt(value, ["reason"]) ?? JSON.stringify(value);
  return String(value);
}

function inlineText(value: string): string {
  return sanitize(value.replace(/\s+/g, " "));
}

const escapeCharacter = String.fromCharCode(27);
const asciiControlCharacters = `${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}`;
const ANSI_CONTROL_SEQUENCE = new RegExp(`${escapeCharacter}\\[[0-9;]*[A-Za-z]`, "g");
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${escapeCharacter}.`, "g");
const ASCII_CONTROL_CHARACTER = new RegExp(`[${asciiControlCharacters}]`, "g");

function sanitize(value: string): string {
  return value
    .replace(ANSI_CONTROL_SEQUENCE, "")
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(ASCII_CONTROL_CHARACTER, "")
    .trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, path: string[]): Record<string, unknown> | null {
  const found = valueAt(value, path);
  return isRecord(found) ? found : null;
}

function arrayAt(value: unknown, path: string[]): unknown[] | null {
  const found = valueAt(value, path);
  return Array.isArray(found) ? found : null;
}

function stringAt(value: unknown, path: string[]): string | null {
  const found = valueAt(value, path);
  return typeof found === "string" && found.trim() !== "" ? found : null;
}

function numberAt(value: unknown, path: string[]): number | null {
  const found = valueAt(value, path);
  return typeof found === "number" && Number.isFinite(found) ? found : null;
}

function valueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}
