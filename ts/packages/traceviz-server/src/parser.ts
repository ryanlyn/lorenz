import type { ToolCallContent } from "@agentclientprotocol/sdk";
import { isRecord, type TraceEvent } from "@symphony/domain";

import type { DisplayEvent, ToolCallDisplayEvent, TokenUsage } from "./models/display-events.js";

interface PendingToolCall {
  event: ToolCallDisplayEvent;
  toolUseId: string;
  startTs: string;
}

interface TurnStartedRecord {
  timestamp: string;
  consumed: boolean;
}

/**
 * Parse a single JSONL line into a TraceEvent, or null if invalid.
 * Validates the envelope (type + identifier); the cast to TraceEvent enables
 * discriminated narrowing in the switch. Per-branch guards protect against
 * message shape mismatches.
 */
function parseLine(line: string): TraceEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj: unknown = JSON.parse(trimmed);
    if (!isRecord(obj)) return null;
    const rec = obj;
    if (typeof rec.type !== "string") return null;
    if (!rec.issueId && !rec.issueIdentifier) return null;
    return rec as unknown as TraceEvent;
  } catch {
    return null;
  }
}

function getSessionNotificationUpdate(message: unknown): Record<string, unknown> | null {
  if (!isRecord(message)) return null;
  const update = message.update;
  return isRecord(update) ? update : null;
}

function extractTextFromUpdate(update: Record<string, unknown>): string {
  if (
    update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "user_message_chunk" ||
    update.sessionUpdate === "agent_thought_chunk"
  ) {
    const block = update.content;
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

function formatHookExecutionMessage(message: unknown): string {
  if (!isRecord(message)) return "Hook execution update";
  const status = typeof message.status === "string" ? message.status : "updated";
  const hookName = typeof message.hookName === "string" ? message.hookName : "hook";
  const parts = [`${hookName} hook ${status}`];
  if (typeof message.command === "string" && message.command.length > 0) {
    parts.push(`command: ${inlineText(message.command)}`);
  }
  if ("exitCode" in message) {
    parts.push(`exit code: ${hookExitCodeText(message.exitCode)}`);
  }
  if (typeof message.error === "string" && message.error.length > 0) {
    const suffix = message.errorTruncated === true ? " (truncated)" : "";
    parts.push(`error: ${inlineText(message.error)}${suffix}`);
  }
  if (typeof message.output === "string" && message.output.length > 0) {
    const suffix = message.outputTruncated === true ? " (truncated)" : "";
    parts.push(`output: ${inlineText(message.output)}${suffix}`);
  }
  return parts.join("; ");
}

function inlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hookExitCodeText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown";
}

function getToolCallId(update: { toolCallId?: unknown }): string | null {
  return typeof update.toolCallId === "string" && update.toolCallId.length > 0
    ? update.toolCallId
    : null;
}

function extractTextFromToolCallContent(content: ToolCallContent[]): string | null {
  const texts = content
    .map((item: unknown) => {
      if (!isRecord(item)) return "";
      if (item.type === "content") {
        const block = item.content;
        return isRecord(block) && block.type === "text" && typeof block.text === "string"
          ? block.text
          : "";
      }
      if (item.type === "terminal") {
        return typeof item.output === "string" ? item.output : "";
      }
      return "";
    })
    .filter(Boolean);

  return texts.join("\n") || null;
}

function displayEventTimestampMs(event: DisplayEvent): number {
  const timestampMs = new Date(event.timestamp).getTime();
  return Number.isNaN(timestampMs) ? Infinity : timestampMs;
}

function sortDisplayEventsChronologically(events: DisplayEvent[]): DisplayEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const timestampDiff =
        displayEventTimestampMs(left.event) - displayEventTimestampMs(right.event);
      return timestampDiff === 0 ? left.index - right.index : timestampDiff;
    })
    .map(({ event }) => event);
}

/**
 * Parse all lines from a JSONL trace file content into DisplayEvents.
 */
export function parseTraceLines(lines: string[]): DisplayEvent[] {
  const events: DisplayEvent[] = [];
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const turnStartedRecords: TurnStartedRecord[] = [];
  let turnIndex = 0;
  let pendingText: { kind: "thought" | "message"; text: string; timestamp: string } | null = null;

  function flushPendingText(): void {
    if (pendingText) {
      events.push({
        kind: pendingText.kind,
        text: pendingText.text,
        timestamp: pendingText.timestamp,
      });
      pendingText = null;
    }
  }

  function consumeLatestTurnStart(): void {
    for (let i = turnStartedRecords.length - 1; i >= 0; i--) {
      const record = turnStartedRecords[i];
      if (record !== undefined && !record.consumed) {
        record.consumed = true;
        break;
      }
    }
  }

  for (const line of lines) {
    const raw = parseLine(line);
    if (!raw) continue;

    const ts = raw.timestamp ?? new Date().toISOString();

    switch (raw.type) {
      case "session_notification": {
        const update = getSessionNotificationUpdate(raw.message);
        if (!update) break;
        const sessionUpdate = update.sessionUpdate;
        if (sessionUpdate === "agent_message_chunk" || sessionUpdate === "user_message_chunk") {
          const text = extractTextFromUpdate(update);
          if (text) {
            if (pendingText && pendingText.kind === "message") {
              pendingText.text += text;
            } else {
              flushPendingText();
              pendingText = { kind: "message", text, timestamp: ts };
            }
          }
        } else if (sessionUpdate === "agent_thought_chunk") {
          const text = extractTextFromUpdate(update);
          if (text) {
            if (pendingText && pendingText.kind === "thought") {
              pendingText.text += text;
            } else {
              flushPendingText();
              pendingText = { kind: "thought", text, timestamp: ts };
            }
          }
        } else if (sessionUpdate === "tool_call") {
          const id = getToolCallId(update);
          if (!id) break;
          flushPendingText();
          const name =
            typeof update.title === "string"
              ? update.title
              : typeof update.kind === "string"
                ? update.kind
                : "unknown";
          const input = isRecord(update.rawInput) ? update.rawInput : {};

          const toolCall: ToolCallDisplayEvent = {
            kind: "tool_call",
            toolName: name,
            input,
            output: null,
            isError: false,
            durationMs: null,
            nestedEvents: [],
            timestamp: ts,
          };
          pendingToolCalls.set(id, { event: toolCall, toolUseId: id, startTs: ts });
        } else if (sessionUpdate === "tool_call_update") {
          const toolUseId = getToolCallId(update);
          if (!toolUseId) break;
          const status = update.status;

          if (status === "completed" || status === "failed") {
            let output: string | unknown[] | null = null;
            if (typeof update.rawOutput === "string") {
              output = update.rawOutput;
            } else if (update.rawOutput != null) {
              output = JSON.stringify(update.rawOutput);
            } else {
              const content = update.content;
              if (Array.isArray(content) && content.length > 0) {
                output = extractTextFromToolCallContent(content as ToolCallContent[]);
              }
            }
            const isError = status === "failed";
            const pending = pendingToolCalls.get(toolUseId);
            if (pending) {
              pendingToolCalls.delete(toolUseId);
              const toolCallEvent = pending.event;
              if (output !== null) {
                toolCallEvent.output = output;
              }
              toolCallEvent.isError = isError;
              const startMs = new Date(pending.startTs).getTime();
              const endMs = new Date(ts).getTime();
              toolCallEvent.durationMs =
                Number.isNaN(startMs) || Number.isNaN(endMs) ? null : endMs - startMs;
              toolCallEvent.timestamp = ts;
              events.push(toolCallEvent);
            } else {
              events.push({
                kind: "tool_call",
                toolName: "unknown",
                input: {},
                output,
                isError,
                durationMs: null,
                nestedEvents: [],
                timestamp: ts,
              });
            }
          } else {
            const pending = pendingToolCalls.get(toolUseId);
            if (pending) {
              const partialOutput = typeof update.rawOutput === "string" ? update.rawOutput : null;
              if (partialOutput !== null && typeof pending.event.output === "string") {
                pending.event.output = pending.event.output + partialOutput;
              } else if (partialOutput !== null) {
                pending.event.output = partialOutput;
              }
            }
          }
        }
        break;
      }

      case "turn_started": {
        flushPendingText();
        turnIndex++;
        turnStartedRecords.push({ timestamp: ts, consumed: false });
        events.push({ kind: "turn_started", turnIndex, timestamp: ts });
        break;
      }

      case "turn_completed": {
        flushPendingText();
        let usage: TokenUsage | null = null;
        if (raw.usage) {
          usage = {
            inputTokens: raw.usage.inputTokens ?? 0,
            outputTokens: raw.usage.outputTokens ?? 0,
            totalTokens:
              raw.usage.totalTokens ?? (raw.usage.inputTokens ?? 0) + (raw.usage.outputTokens ?? 0),
          };
        }
        let durationMs: number | null = null;
        for (let i = turnStartedRecords.length - 1; i >= 0; i--) {
          const record = turnStartedRecords[i];
          if (record !== undefined && !record.consumed) {
            record.consumed = true;
            const startMs = new Date(record.timestamp).getTime();
            const endMs = new Date(ts).getTime();
            if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
              durationMs = endMs - startMs;
            }
            break;
          }
        }
        events.push({ kind: "turn_completed", usage, durationMs, timestamp: ts });
        break;
      }

      case "turn_failed": {
        flushPendingText();
        consumeLatestTurnStart();
        const msg = raw.message;
        events.push({
          kind: "turn_failed",
          text: `Turn ${raw.type}: ${typeof msg === "string" ? msg : JSON.stringify(msg ?? "")}`,
          timestamp: ts,
        });
        break;
      }

      case "turn_cancelled": {
        flushPendingText();
        consumeLatestTurnStart();
        const response = isRecord(raw.message) ? raw.message.response : null;
        const stopReason = isRecord(response) ? response.stopReason : null;
        events.push({
          kind: "turn_failed",
          text:
            typeof stopReason === "string" && stopReason.length > 0
              ? `Turn cancelled: ${stopReason}`
              : "Turn cancelled",
          timestamp: ts,
        });
        break;
      }

      case "hook_execution": {
        flushPendingText();
        events.push({
          kind: "notification",
          text: formatHookExecutionMessage(raw.message),
          timestamp: ts,
        });
        break;
      }

      case "rate_limit":
      case "workspace_prepared":
      case "session_started":
      case "process_exit":
      case "stderr":
      case "fs_write":
      case "approval_auto_approved":
      case "approval_required": {
        break;
      }

      default: {
        events.push({
          kind: "unknown",
          raw: raw as unknown as Record<string, unknown>,
          timestamp: ts,
        });
        break;
      }
    }
  }

  flushPendingText();

  return sortDisplayEventsChronologically(events);
}

export interface TicketMetadata {
  issueId: string;
  issueIdentifier: string;
}

/**
 * Extract the issueId and issueIdentifier from the first valid line of a trace file.
 */
export function extractTicketMetadata(lines: string[]): TicketMetadata | null {
  for (const line of lines) {
    const raw = parseLine(line);
    if (raw && raw.issueId && raw.issueIdentifier) {
      return {
        issueId: raw.issueId,
        issueIdentifier: raw.issueIdentifier,
      };
    }
  }
  return null;
}
