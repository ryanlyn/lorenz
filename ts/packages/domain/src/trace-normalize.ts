/**
 * Normalization helpers that both ACP and Codex executors call to produce
 * structured, typed message payloads from their native event formats.
 *
 * These functions ensure that regardless of which executor produced the trace,
 * the `message` field on AgentUpdate carries structurally identical payloads
 * for semantically equivalent events.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";

import type {
  TraceTextMessage,
  TraceToolCall,
  TraceToolResult,
  TraceToolCallUpdate,
  TraceUsageMessage,
  TraceNotificationMessage,
  TraceApprovalMessage,
  TraceFsWriteMessage,
  TraceProcessMessage,
} from "./index.js";

// --- ACP SDK -> Normalized ---

export function normalizeTextChunk(notification: SessionNotification): TraceTextMessage {
  const update = notification.update as Record<string, unknown>;
  const content = update.content as Record<string, unknown> | undefined;
  return {
    text: content && typeof content.text === "string" ? content.text : "",
    messageId: (update.messageId as string) ?? null,
  };
}

export function normalizeToolCall(notification: SessionNotification): TraceToolCall {
  const update = notification.update as Record<string, unknown>;
  return {
    toolCallId: (update.toolCallId as string) ?? "",
    toolName: (update.title as string) ?? (update.kind as string) ?? "unknown",
    kind: (update.kind as string) ?? null,
    input: (update.rawInput as Record<string, unknown>) ?? {},
  };
}

export function normalizeToolCallUpdate(notification: SessionNotification): TraceToolCallUpdate {
  const update = notification.update as Record<string, unknown>;
  let output: string | null = null;
  if (typeof update.rawOutput === "string") {
    output = update.rawOutput;
  } else if (update.rawOutput != null) {
    output = JSON.stringify(update.rawOutput);
  } else if (Array.isArray(update.content) && update.content.length > 0) {
    const texts = (update.content as Array<Record<string, unknown>>)
      .map((c) => {
        if (c.type === "content") {
          const block = c.content as Record<string, unknown> | undefined;
          return (block?.text as string) ?? "";
        }
        return "";
      })
      .filter(Boolean);
    output = texts.join("\n") || null;
  }
  return {
    toolCallId: (update.toolCallId as string) ?? "",
    status: (update.status as TraceToolCallUpdate["status"]) ?? null,
    output,
  };
}

export function normalizeToolResult(
  notification: SessionNotification,
  isError: boolean,
): TraceToolResult {
  const update = notification.update as Record<string, unknown>;
  let output: string | null = null;
  if (typeof update.rawOutput === "string") {
    output = update.rawOutput;
  } else if (update.rawOutput != null) {
    output = JSON.stringify(update.rawOutput);
  } else if (Array.isArray(update.content) && update.content.length > 0) {
    const texts = (update.content as Array<Record<string, unknown>>)
      .map((c) => {
        if (c.type === "content") {
          const block = c.content as Record<string, unknown> | undefined;
          return (block?.text as string) ?? "";
        }
        return "";
      })
      .filter(Boolean);
    output = texts.join("\n") || null;
  }
  return {
    toolCallId: (update.toolCallId as string) ?? "",
    toolName: (update.title as string) ?? undefined,
    status: isError ? "failed" : "completed",
    output,
    isError,
  };
}

export function normalizeUsage(used: number): TraceUsageMessage {
  return { totalTokens: used };
}

// --- Codex -> Normalized ---

export function normalizeCodexToolCompleted(value: Record<string, unknown>): TraceToolResult {
  const request = value.request as Record<string, unknown> | undefined;
  const result = value.result as Record<string, unknown> | undefined;
  const params = (request?.params as Record<string, unknown>) ?? {};
  const toolName = (params.tool as string) ?? (params.name as string) ?? "unknown";
  const callId = (params.callId as string) ?? "";
  const output =
    (result?.output as string | null) ??
    (result?.contentItems as Array<{ text?: string }> | undefined)?.[0]?.text ??
    null;
  const isError = (result?.success as boolean) === false;
  return {
    toolCallId: callId,
    toolName,
    status: isError ? "failed" : "completed",
    output,
    isError,
  };
}

export function normalizeCodexNotification(
  value: Record<string, unknown>,
): TraceNotificationMessage {
  return {
    method: (value.method as string) ?? "unknown",
    params: (value.params as Record<string, unknown>) ?? undefined,
  };
}

// --- Shared helpers ---

export function normalizeApproval(
  toolCallId: string | null,
  toolName: string | null,
  decision: string | null,
): TraceApprovalMessage {
  return { toolCallId, toolName, decision };
}

export function normalizeFsWrite(filePath: string): TraceFsWriteMessage {
  return { path: filePath };
}

export function normalizeProcessExit(
  code: number | null,
  signal: string | null,
): TraceProcessMessage {
  const text = `exited${code === null ? "" : ` with status ${code}`}${signal ? ` signal ${signal}` : ""}`;
  return { exitCode: code, signal, text };
}
