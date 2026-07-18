/**
 * Display event types for the traceviz frontend.
 * These are the parsed, presentation-ready events derived from raw AgentUpdate JSONL traces.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ThoughtDisplayEvent {
  kind: "thought";
  text: string;
  timestamp: string;
  durationMs?: number | undefined;
}

export interface MessageDisplayEvent {
  kind: "message";
  text: string;
  timestamp: string;
}

export interface ToolCallDisplayEvent {
  kind: "tool_call";
  toolName: string;
  input: Record<string, unknown>;
  output: string | unknown[] | null;
  isError: boolean;
  durationMs: number | null;
  nestedEvents: DisplayEvent[];
  timestamp: string;
}

export interface TurnCompletedDisplayEvent {
  kind: "turn_completed";
  usage: TokenUsage | null;
  durationMs: number | null;
  timestamp: string;
}

export interface TurnStartedDisplayEvent {
  kind: "turn_started";
  turnIndex: number;
  timestamp: string;
}

export interface TurnFailedDisplayEvent {
  kind: "turn_failed";
  text: string;
  timestamp: string;
}

export interface NotificationDisplayEvent {
  kind: "notification";
  text: string;
  timestamp: string;
}

export interface UnknownDisplayEvent {
  kind: "unknown";
  raw: Record<string, unknown>;
  timestamp: string;
}

export type DisplayEvent =
  | ThoughtDisplayEvent
  | MessageDisplayEvent
  | ToolCallDisplayEvent
  | TurnCompletedDisplayEvent
  | TurnStartedDisplayEvent
  | TurnFailedDisplayEvent
  | NotificationDisplayEvent
  | UnknownDisplayEvent;
