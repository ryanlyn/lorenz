export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export const SESSION_UPDATE_KINDS = [
  "usage_update",
  "session_started",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "tool_call",
  "tool_result",
  "notification",
] as const;

export type SessionUpdateKind = (typeof SESSION_UPDATE_KINDS)[number];

type AgentKind = string;

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

export interface SymphonyMeta {
  executorPid?: string | null | undefined;
  rateLimits?: unknown;
  usage?: Partial<UsageTotals> | undefined;
}

interface SessionUpdateBase {
  kind: SessionUpdateKind;
  sessionId?: string | null | undefined;
  agentKind?: AgentKind | undefined;
  message?: unknown;
  at?: Date | undefined;
  _meta?: SymphonyMeta | undefined;
}

export interface UsageUpdate extends SessionUpdateBase {
  kind: "usage_update";
  usage: Partial<UsageTotals>;
}

export interface TurnUpdate extends SessionUpdateBase {
  kind:
    | "session_started"
    | "turn_started"
    | "turn_completed"
    | "turn_failed"
    | "turn_cancelled"
    | "tool_call"
    | "tool_result"
    | "notification";
  message?: unknown;
}

export type SessionUpdate = UsageUpdate | TurnUpdate | SessionUpdateBase;

export interface TurnResult {
  stopReason: StopReason;
  sessionId: string;
  _meta?: SymphonyMeta | undefined;
}
