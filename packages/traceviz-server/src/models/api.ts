/**
 * API response types for the traceviz server endpoints.
 */

import type { DisplayEvent, TokenUsage } from "./display-events.js";

export interface HealthResponse {
  status: string;
}

export interface TicketInfo {
  issueId: string;
  identifier: string;
  title?: string | undefined;
  url?: string | undefined;
  agentKind?: string | undefined;
  startedAt?: string | undefined;
  turnCount: number;
  status: "running" | "completed" | "failed" | "idle";
}

export interface TicketsResponse {
  tickets: TicketInfo[];
}

export interface TicketTraceResponse {
  issueId: string;
  identifier: string;
  events: DisplayEvent[];
}

/**
 * Messages a trace client may send over the dashboard `/ws` connection.
 * Shared by the ws handler in @lorenz/server and the dashboard client so
 * the two sides cannot drift.
 */
export type WsClientMessage =
  | { type: "subscribe"; issueId: string }
  | { type: "unsubscribe"; issueId: string };

export interface ToolBreakdownEntry {
  toolName: string;
  count: number;
  errorCount: number;
  totalDurationMs: number;
}

export interface TraceStats {
  durationMs: number;
  totalEvents: number;
  totalTurns: number;
  tokenUsage: TokenUsage;
  toolBreakdown: ToolBreakdownEntry[];
}
