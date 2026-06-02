import type {
  TraceTextMessage,
  TraceToolCall,
  TraceToolResult,
  TraceToolCallUpdate,
  TraceNotificationMessage,
} from "@symphony/domain";

export function isTraceTextMessage(msg: unknown): msg is TraceTextMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return typeof m.text === "string" && !("update" in m) && !("sessionId" in m);
}

export function isTraceToolCall(msg: unknown): msg is TraceToolCall {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as TraceToolCall;
  return typeof m.toolCallId === "string" && typeof m.toolName === "string" && "input" in m;
}

export function isTraceToolResult(msg: unknown): msg is TraceToolResult {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as TraceToolResult;
  return typeof m.toolCallId === "string" && typeof m.isError === "boolean" && "status" in m;
}

export function isTraceToolCallUpdate(msg: unknown): msg is TraceToolCallUpdate {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return typeof m.toolCallId === "string" && !("isError" in m) && !("input" in m);
}

export function isTraceNotification(msg: unknown): msg is TraceNotificationMessage {
  if (typeof msg !== "object" || msg === null) return false;
  return typeof (msg as TraceNotificationMessage).method === "string";
}
