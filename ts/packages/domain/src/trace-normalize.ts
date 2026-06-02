/**
 * Normalization helpers that the ACP executor calls to produce structured,
 * typed message payloads from native event formats.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";

import type {
  TraceTextMessage,
  TraceToolCall,
  TraceToolResult,
  TraceToolCallUpdate,
  TraceUsageMessage,
} from "./index.js";

// --- ACP SDK -> Normalized ---

function extractOutput(update: Record<string, unknown>): string | null {
  if (typeof update.rawOutput === "string") {
    return update.rawOutput;
  } else if (update.rawOutput != null) {
    return JSON.stringify(update.rawOutput);
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
    return texts.join("\n") || null;
  }
  return null;
}

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
  return {
    toolCallId: (update.toolCallId as string) ?? "",
    status: (update.status as TraceToolCallUpdate["status"]) ?? null,
    output: extractOutput(update),
  };
}

export function normalizeToolResult(
  notification: SessionNotification,
  isError: boolean,
): TraceToolResult {
  const update = notification.update as Record<string, unknown>;
  return {
    toolCallId: (update.toolCallId as string) ?? "",
    toolName: (update.title as string) ?? undefined,
    status: isError ? "failed" : "completed",
    output: extractOutput(update),
    isError,
  };
}

export function normalizeUsage(used: number): TraceUsageMessage {
  return { totalTokens: used };
}
