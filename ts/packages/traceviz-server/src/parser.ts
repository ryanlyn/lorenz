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
 * Extract the ACP `update` envelope from a SessionNotification message.
 * All AgentUpdates from the ACP executor use this shape: {sessionId, update: {...}}
 */
function extractAcpUpdate(msg: unknown): Record<string, unknown> | null {
  if (typeof msg !== "object" || msg === null) return null;
  const rec = msg as Record<string, unknown>;
  const update = rec.update as Record<string, unknown> | undefined;
  return update ?? null;
}

function extractText(msg: unknown): string {
  if (typeof msg === "string") return msg;
  const update = extractAcpUpdate(msg);
  if (update) {
    const content = update.content as Record<string, unknown> | undefined;
    if (content && typeof content.text === "string") return content.text;
  }
  return "";
}

function extractToolCall(msg: unknown): { name: string; id: string; input: Record<string, unknown> } | null {
  const update = extractAcpUpdate(msg);
  if (!update || update.sessionUpdate !== "tool_call") return null;
  const name = (update.title as string) ?? (update.kind as string) ?? "unknown";
  const id = (update.toolCallId as string) ?? "";
  const input = (update.rawInput as Record<string, unknown>) ?? {};
  return { name, id, input };
}

function extractToolResult(msg: unknown): { id: string; output: string | unknown[] | null; isError: boolean } | null {
  const update = extractAcpUpdate(msg);
  if (!update || update.sessionUpdate !== "tool_call_update") return null;
  const id = (update.toolCallId as string) ?? "";
  let output: string | unknown[] | null = null;
  if (typeof update.rawOutput === "string") {
    output = update.rawOutput;
  } else if (update.rawOutput != null) {
    output = JSON.stringify(update.rawOutput);
  } else {
    const content = update.content as Array<Record<string, unknown>> | undefined;
    if (content && content.length > 0) {
      const texts = content
        .map((c) => {
          if (c.type === "content") {
            const block = c.content as Record<string, unknown> | undefined;
            return (block?.text as string) ?? "";
          }
          if (c.type === "terminal") {
            return (c.output as string) ?? "";
          }
          return "";
        })
        .filter(Boolean);
      output = texts.join("\n") || null;
    }
  }
  const isError = update.status === "failed";
  return { id, output, isError };
}

/**
 * Parse an `item/completed` notification params into a DisplayEvent.
 */
function parseItemCompleted(params: Record<string, unknown>, ts: string): DisplayEvent | null {
  const item = params.item as Record<string, unknown> | undefined;
  if (!item) return null;
  const itemType = item.type as string | undefined;

  switch (itemType) {
    case "reasoning": {
      let text = typeof item.text === "string" ? item.text : "";
      if (!text) {
        const summary = item.summary as Array<Record<string, unknown>> | undefined;
        if (summary && summary.length > 0) {
          text = summary
            .map((s) => (s.text as string) ?? "")
            .filter(Boolean)
            .join("\n");
        }
      }
      if (!text) {
        const content = item.content as Array<Record<string, unknown>> | undefined;
        if (content && content.length > 0) {
          text = content
            .map((c) => (c.text as string) ?? "")
            .filter(Boolean)
            .join("\n");
        }
      }
      if (!text) return null;
      return { kind: "thought", text, timestamp: ts };
    }

    case "agentMessage":
      return {
        kind: "message",
        text: typeof item.text === "string" ? item.text : "",
        timestamp: ts,
      };

    case "userMessage": {
      const content = item.content as Array<Record<string, unknown>> | undefined;
      const text = content?.[0]?.text as string | undefined;
      return { kind: "message", text: text ?? "", timestamp: ts };
    }

    case "commandExecution":
      return {
        kind: "tool_call",
        category: "bash_command",
        toolName: "command_execution",
        input: { command: item.command },
        output: (item.aggregatedOutput as string) ?? null,
        isError: (item.exitCode as number) !== 0,
        durationMs: (item.durationMs as number) ?? null,
        nestedEvents: [],
        timestamp: ts,
      };

    case "dynamicToolCall": {
      const toolName = (item.tool as string) ?? "unknown";
      const args = (item.arguments as Record<string, unknown>) ?? {};
      const contentItems = item.contentItems as Array<Record<string, unknown>> | undefined;
      const output = (contentItems?.[0]?.text as string | null) ?? null;
      return {
        kind: "tool_call",
        category: detectToolCategory(toolName),
        toolName,
        input: args,
        output,
        isError: (item.success as boolean) === false,
        durationMs: (item.durationMs as number) ?? null,
        nestedEvents: [],
        timestamp: ts,
      };
    }

    default:
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
        const text = extractText(msg);
        if (text) events.push({ kind: "thought", text, timestamp: ts });
        break;
      }

      case "assistant_message":
      case "user_message": {
        const text = extractText(msg);
        if (text) events.push({ kind: "message", text, timestamp: ts });
        break;
      }

      case "tool_use_requested": {
        const tool = extractToolCall(msg);
        if (!tool) break;

        const toolCall: ToolCallDisplayEvent = {
          kind: "tool_call",
          category: detectToolCategory(tool.name),
          toolName: tool.name,
          input: tool.input,
          output: null,
          isError: false,
          durationMs: null,
          nestedEvents: [],
          timestamp: ts,
        };
        pendingToolCalls.set(tool.id, { event: toolCall, toolUseId: tool.id, startTs: ts });
        break;
      }

      case "tool_call_update": {
        const update = extractAcpUpdate(msg);
        const toolUseId = (update?.toolCallId as string) ?? "";
        const pending = pendingToolCalls.get(toolUseId);
        if (pending) {
          const partialOutput = (update?.rawOutput as string | null) ?? null;
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
        const result = extractToolResult(msg);
        if (!result) break;

        const pending = result.id ? pendingToolCalls.get(result.id) : undefined;
        if (pending) {
          pendingToolCalls.delete(result.id);
          const toolCall = pending.event;
          if (result.output !== null) {
            toolCall.output = result.output;
          }
          toolCall.isError = result.isError || raw.type === "tool_call_failed";
          const startMs = new Date(pending.startTs).getTime();
          const endMs = new Date(ts).getTime();
          toolCall.durationMs =
            Number.isNaN(startMs) || Number.isNaN(endMs) ? null : endMs - startMs;
          events.push(toolCall);
        } else {
          events.push({
            kind: "tool_call",
            category: "unknown",
            toolName: "unknown",
            input: {},
            output: result.output,
            isError: result.isError || raw.type === "tool_call_failed",
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
        if (typeof msg !== "object" || msg === null) break;
        const method = (msg as Record<string, unknown>).method as string | undefined;
        const params = (msg as Record<string, unknown>).params as
          | Record<string, unknown>
          | undefined;
        if (!method || !params) break;

        if (method === "item/completed") {
          const displayEvent = parseItemCompleted(params, ts);
          if (displayEvent) events.push(displayEvent);
        } else if (method === "turn/started") {
          // Deduplicate: if the last event is already a turn_started (from raw event), update it
          const lastEvent = events[events.length - 1];
          if (lastEvent && lastEvent.kind === "turn_started") {
            // Update timestamp if the raw one had null/fallback
            if (ts && new Date(ts).getTime() > 0) {
              lastEvent.timestamp = ts;
              // Also update the corresponding turnStartedRecord timestamp
              const lastRecord = turnStartedRecords[turnStartedRecords.length - 1];
              if (lastRecord) {
                lastRecord.timestamp = ts;
              }
            }
          } else {
            turnIndex++;
            turnStartedRecords.push({ timestamp: ts, consumed: false });
            events.push({ kind: "turn_started", turnIndex, timestamp: ts });
          }
        } else if (method === "turn/completed") {
          // turn/completed from notification form (usage extracted from params if available)
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
          events.push({ kind: "turn_completed", usage: null, durationMs, timestamp: ts });
        }
        break;
      }

      case "usage":
      case "rate_limit":
      case "workspace_prepared":
      case "session_started":
      case "session_replay_suppressed":
      case "process_exit":
      case "stderr":
      case "fs_write":
      case "plan":
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
