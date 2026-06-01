export interface TicketInfo {
  issueId: string;
  identifier: string;
  title?: string;
  agentKind?: string;
  startedAt?: string;
  turnCount: number;
  status: "idle" | "running" | "completed" | "failed";
}

export interface ToolBreakdownEntry {
  category: string;
  count: number;
  errorCount: number;
  totalDurationMs: number;
}

export interface Stats {
  durationMs: number;
  totalEvents: number;
  totalTurns: number;
  tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
  toolBreakdown: ToolBreakdownEntry[];
}

export type ToolCategory =
  | "plan_mode"
  | "agent"
  | "bash_command"
  | "search"
  | "file_operation"
  | "web"
  | "todo"
  | "skill"
  | "unknown";

export interface ThoughtEvent {
  kind: "thought";
  text: string;
  timestamp: string;
  durationMs?: number;
}

export interface MessageEvent {
  kind: "message";
  text: string;
  timestamp: string;
}

export interface ToolCallEvent {
  kind: "tool_call";
  category: ToolCategory;
  toolName: string;
  input: Record<string, unknown>;
  output: string | unknown[] | null;
  isError: boolean;
  durationMs: number | null;
  nestedEvents: DisplayEvent[];
  timestamp: string;
}

export interface TurnCompletedEvent {
  kind: "turn_completed";
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  durationMs: number | null;
  timestamp: string;
}

export interface TurnStartedEvent {
  kind: "turn_started";
  turnIndex: number;
  timestamp: string;
}

export interface TurnFailedEvent {
  kind: "turn_failed";
  text: string;
  timestamp: string;
}

export interface NotificationEvent {
  kind: "notification";
  text: string;
  timestamp: string;
}

export interface UnknownEvent {
  kind: "unknown";
  raw: Record<string, unknown>;
  timestamp: string;
}

export type DisplayEvent =
  | ThoughtEvent
  | MessageEvent
  | ToolCallEvent
  | TurnCompletedEvent
  | TurnStartedEvent
  | TurnFailedEvent
  | NotificationEvent
  | UnknownEvent;

export type WsMessage =
  | { type: "init"; tickets: TicketInfo[] }
  | { type: "events_update"; issueId: string; eventCount: number }
  | { type: "events"; issueId: string; events: DisplayEvent[] }
  | { type: "ping" };
