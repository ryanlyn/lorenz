import type { SessionNotification, ToolCallContent } from "@agentclientprotocol/sdk";
import type { TraceEvent } from "@symphony/domain";

import type {
  DisplayEvent,
  ToolCallDisplayEvent,
  ToolCategory,
  TokenUsage,
} from "./models/display-events.js";

/** Tool name -> category mapping for common Claude tools. */
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
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
    const rec = obj as Record<string, unknown>;
    if (typeof rec.type !== "string") return null;
    if (!rec.issueId && !rec.issueIdentifier) return null;
    return rec as unknown as TraceEvent;
  } catch {
    return null;
  }
}

function extractTextFromNotification(msg: SessionNotification): string {
  const update = msg.update;
  if (
    update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "user_message_chunk" ||
    update.sessionUpdate === "agent_thought_chunk"
  ) {
    const block = update.content;
    if (block.type === "text") return block.text;
  }
  return "";
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

    switch (raw.type) {
      case "session_notification": {
        const msg = raw.message;
        if (!msg || !("update" in msg)) break;
        const update = msg.update;
        const sessionUpdate = update.sessionUpdate;
        if (sessionUpdate === "agent_message_chunk" || sessionUpdate === "user_message_chunk") {
          const text = extractTextFromNotification(msg);
          if (text) events.push({ kind: "message", text, timestamp: ts });
        } else if (sessionUpdate === "agent_thought_chunk") {
          const text = extractTextFromNotification(msg);
          if (text) events.push({ kind: "thought", text, timestamp: ts });
        } else if (sessionUpdate === "tool_call") {
          const name = update.title ?? (update.kind as string) ?? "unknown";
          const id = update.toolCallId ?? "";
          const input = (update.rawInput as Record<string, unknown>) ?? {};

          const toolCall: ToolCallDisplayEvent = {
            kind: "tool_call",
            category: detectToolCategory(name),
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
          const toolUseId = update.toolCallId ?? "";
          const status = update.status;

          if (status === "completed" || status === "failed") {
            let output: string | unknown[] | null = null;
            if (typeof update.rawOutput === "string") {
              output = update.rawOutput;
            } else if (update.rawOutput != null) {
              output = JSON.stringify(update.rawOutput);
            } else {
              const content = update.content as Array<ToolCallContent> | undefined;
              if (content && content.length > 0) {
                const texts = content
                  .map((c) => {
                    if (c.type === "content") {
                      const block = c.content;
                      return block.type === "text" ? block.text : "";
                    }
                    if (c.type === "terminal") {
                      return ((c as Record<string, unknown>).output as string) ?? "";
                    }
                    return "";
                  })
                  .filter(Boolean);
                output = texts.join("\n") || null;
              }
            }
            const isError = status === "failed";
            const pending = toolUseId ? pendingToolCalls.get(toolUseId) : undefined;
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
              events.push(toolCallEvent);
            } else {
              events.push({
                kind: "tool_call",
                category: "unknown",
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
        for (let i = turnStartedRecords.length - 1; i >= 0; i--) {
          const record = turnStartedRecords[i];
          if (record !== undefined && !record.consumed) {
            record.consumed = true;
            break;
          }
        }
        const msg = raw.message;
        events.push({
          kind: "turn_failed",
          text: `Turn ${raw.type}: ${typeof msg === "string" ? msg : JSON.stringify(msg ?? "")}`,
          timestamp: ts,
        });
        break;
      }

      case "rate_limit":
      case "workspace_prepared":
      case "session_started":
      case "session_replay_suppressed":
      case "process_exit":
      case "stderr":
      case "fs_write":
      case "approval_auto_approved":
      case "approval_required":
      case "resume_state_warning": {
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
