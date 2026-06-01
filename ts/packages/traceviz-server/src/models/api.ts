/**
 * API response types for the traceviz server endpoints.
 */

import type { DisplayEvent, TokenUsage, ToolCategory } from "./display-events.js";

export interface HealthResponse {
  status: string;
}

export interface TicketInfo {
  issueId: string;
  identifier: string;
  title?: string | undefined;
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

export interface ToolBreakdownEntry {
  category: ToolCategory;
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
