/**
 * JSONL trace parser for Symphony AgentUpdate events.
 *
 * Each line in a trace file is a JSON object with at minimum:
 *   { type, issueId, issueIdentifier, timestamp, message, usage, ... }
 *
 * This module maps raw AgentUpdate types to DisplayEvent types for the frontend.
 */

import type {
  DisplayEvent,
  ToolCallDisplayEvent,
  ToolCategory,
  TokenUsage,
} from "./models/display-events.js";

/** Tool name -> category mapping for common Claude/Codex tools. */
const TOOL_NAME_CATEGORIES: Record<string, ToolCategory> = {
  // plan_mode
  Task: "plan_mode",
  TaskOutput: "plan_mode",
  TaskStop: "plan_mode",
  TaskCreate: "plan_mode",
  TaskUpdate: "plan_mode",
  TaskGet: "plan_mode",
  TaskList: "plan_mode",
  EnterPlanMode: "plan_mode",
  ExitPlanMode: "plan_mode",
  AskUserQuestion: "plan_mode",
  EnterWorktree: "plan_mode",
  ExitWorktree: "plan_mode",
  // skill
  Skill: "skill",
  // search
  ToolSearch: "search",
  Glob: "search",
  Grep: "search",
  // bash_command
  Bash: "bash_command",
  // file_operation
  Read: "file_operation",
  Write: "file_operation",
  Edit: "file_operation",
  NotebookEdit: "file_operation",
  // web
  WebFetch: "web",
  // agent
  Agent: "agent",
  // todo
  TodoWrite: "todo",
  TodoRead: "todo",
};

export function detectToolCategory(toolName: string): ToolCategory {
  return TOOL_NAME_CATEGORIES[toolName] ?? "unknown";
}

/**
 * Represents a raw trace line as emitted by TraceEmitter.
 */
interface RawTraceLine {
  type: string;
  issueId: string;
  issueIdentifier: string;
  timestamp: string | null;
  message?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  workspacePath?: string | null;
  sessionId?: string | null;
  executorPid?: string | null;
}

interface PendingToolCall {
  event: ToolCallDisplayEvent;
  toolUseId: string;
  startTs: string;
}

/** Tracks a turn_started event and whether it has been consumed by a completion/failure/cancellation. */
interface TurnStartedRecord {
  timestamp: string;
  consumed: boolean;
}

/**
 * Parse a single JSONL line into a RawTraceLine, or null if invalid.
 */
function parseLine(line: string): RawTraceLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj !== "object" || obj === null) return null;
    return obj as unknown as RawTraceLine;
  } catch {
    return null;
  }
}

/**
 * Parse all lines from a JSONL trace file content into DisplayEvents.
 */
export function parseTraceLines(lines: string[]): DisplayEvent[] {
  const events: DisplayEvent[] = [];
  const pendingToolCalls = new Map<string, PendingToolCall>();
  const turnStartedRecords: TurnStartedRecord[] = [];
  let turnIndex = 0;

  for (const line of lines) {
    const raw = parseLine(line);
    if (!raw) continue;

    const ts = raw.timestamp ?? new Date().toISOString();
    const msg = raw.message;

    switch (raw.type) {
      case "agent_thought": {
        const text =
          typeof msg === "string"
            ? msg
            : typeof msg === "object" && msg !== null
              ? (((msg as Record<string, unknown>).text as string) ?? "")
              : "";
        events.push({ kind: "thought", text, timestamp: ts });
        break;
      }

      case "assistant_message": {
        const text =
          typeof msg === "string"
            ? msg
            : typeof msg === "object" && msg !== null
              ? (((msg as Record<string, unknown>).text as string) ?? "")
              : "";
        events.push({ kind: "message", text, timestamp: ts });
        break;
      }

      case "user_message": {
        const text =
          typeof msg === "string"
            ? msg
            : typeof msg === "object" && msg !== null
              ? (((msg as Record<string, unknown>).text as string) ?? "")
              : "";
        events.push({ kind: "message", text, timestamp: ts });
        break;
      }

      case "tool_use_requested": {
        const payload =
          typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>) : {};
        const toolName = (payload.name as string) ?? (payload.toolName as string) ?? "unknown";
        const toolUseId =
          (payload.id as string) ??
          (payload.toolUseId as string) ??
          `tool-${Date.now()}-${Math.random()}`;
        const input = (payload.input as Record<string, unknown>) ?? {};

        const toolCall: ToolCallDisplayEvent = {
          kind: "tool_call",
          category: detectToolCategory(toolName),
          toolName,
          input,
          output: null,
          isError: false,
          durationMs: null,
          nestedEvents: [],
          timestamp: ts,
        };
        pendingToolCalls.set(toolUseId, { event: toolCall, toolUseId, startTs: ts });
        break;
      }

      case "tool_call_update": {
        // Partial update for a pending tool call (e.g., streaming output).
        // Attach partial output to the pending event; it will be finalized by tool_result/tool_call_completed.
        const payload =
          typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>) : {};
        const toolUseId = (payload.id as string) ?? (payload.toolUseId as string) ?? "";
        const pending = pendingToolCalls.get(toolUseId);
        if (pending) {
          // Accumulate partial output if provided
          const partialOutput = (payload.output as string | null) ?? null;
          if (partialOutput !== null && typeof pending.event.output === "string") {
            pending.event.output = pending.event.output + partialOutput;
          } else if (partialOutput !== null) {
            pending.event.output = partialOutput;
          }
        }
        break;
      }

      case "tool_result":
      case "tool_call_completed":
      case "tool_call_failed": {
        const payload =
          typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>) : {};
        const toolUseId = (payload.id as string) ?? (payload.toolUseId as string) ?? "";
        const pending = pendingToolCalls.get(toolUseId);

        if (pending) {
          pendingToolCalls.delete(toolUseId);
          const toolCall = pending.event;
          // Only overwrite accumulated partial output if the result provides explicit output
          const resultOutput =
            (payload.output as string | unknown[] | null) ??
            (payload.content as string | unknown[] | null) ??
            null;
          if (resultOutput !== null) {
            toolCall.output = resultOutput;
          }
          toolCall.isError =
            raw.type === "tool_call_failed" || (payload.is_error as boolean) === true;
          const startMs = new Date(pending.startTs).getTime();
          const endMs = new Date(ts).getTime();
          toolCall.durationMs =
            Number.isNaN(startMs) || Number.isNaN(endMs) ? null : endMs - startMs;
          events.push(toolCall);
        } else {
          // No pending tool call found; emit as standalone
          const toolName = (payload.name as string) ?? (payload.toolName as string) ?? "unknown";
          events.push({
            kind: "tool_call",
            category: detectToolCategory(toolName),
            toolName,
            input: {},
            output:
              (payload.output as string | unknown[] | null) ??
              (payload.content as string | unknown[] | null) ??
              null,
            isError: raw.type === "tool_call_failed" || (payload.is_error as boolean) === true,
            durationMs: null,
            nestedEvents: [],
            timestamp: ts,
          });
        }
        break;
      }

      case "turn_started": {
        turnIndex++;
        turnStartedRecords.push({ timestamp: ts, consumed: false });
        events.push({ kind: "turn_started", turnIndex, timestamp: ts });
        break;
      }

      case "turn_completed": {
        let usage: TokenUsage | null = null;
        if (raw.usage) {
          usage = {
            inputTokens: raw.usage.inputTokens ?? 0,
            outputTokens: raw.usage.outputTokens ?? 0,
            totalTokens:
              raw.usage.totalTokens ?? (raw.usage.inputTokens ?? 0) + (raw.usage.outputTokens ?? 0),
          };
        }
        // Try to compute duration from the most recent unconsumed turn_started
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

      case "turn_failed":
      case "turn_cancelled": {
        // Mark the most recent unconsumed turn_started as consumed
        for (let i = turnStartedRecords.length - 1; i >= 0; i--) {
          const record = turnStartedRecords[i];
          if (record !== undefined && !record.consumed) {
            record.consumed = true;
            break;
          }
        }
        events.push({
          kind: "turn_failed",
          text: `Turn ${raw.type}: ${typeof msg === "string" ? msg : JSON.stringify(msg ?? "")}`,
          timestamp: ts,
        });
        break;
      }

      case "notification": {
        const text =
          typeof msg === "string"
            ? msg
            : typeof msg === "object" && msg !== null
              ? (((msg as Record<string, unknown>).text as string) ?? JSON.stringify(msg))
              : msg != null
                ? JSON.stringify(msg)
                : "";
        events.push({ kind: "notification", text, timestamp: ts });
        break;
      }

      case "usage":
      case "rate_limit":
      case "workspace_prepared":
      case "session_started":
      case "stderr":
      case "fs_write":
      case "plan": {
        // Known types we skip or store as unknown for debugging
        events.push({
          kind: "unknown",
          raw: raw as unknown as Record<string, unknown>,
          timestamp: ts,
        });
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

  // Flush any remaining pending tool calls that never got a result
  for (const [, pending] of pendingToolCalls) {
    events.push(pending.event);
  }

  return events;
}

/**
 * Extract the issueId and issueIdentifier from the first valid line of a trace file.
 */
export function extractTicketMetadata(
  lines: string[],
): { issueId: string; issueIdentifier: string } | null {
  for (const line of lines) {
    const raw = parseLine(line);
    if (raw && raw.issueId && raw.issueIdentifier) {
      return { issueId: raw.issueId, issueIdentifier: raw.issueIdentifier };
    }
  }
  return null;
}
