/**
 * API response types for the traceviz server endpoints.
 */

import type { OpsStatePayload } from "@lorenz/presenter";

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

/** Messages the dashboard server may push over the `/ws` connection. */
export type WsServerMessage =
  | { type: "init"; tickets: TicketInfo[] }
  | { type: "update"; issueId: string; tickets: TicketInfo[] }
  | { type: "events"; issueId: string; events: DisplayEvent[] }
  | { type: "events_append"; issueId: string; events: DisplayEvent[]; fromIndex: number }
  | { type: "ops_state"; state: OpsStatePayload }
  | { type: "ping" };

type ExpectedWsServerMessage =
  | { type: "init"; tickets: TicketInfo[] }
  | { type: "update"; issueId: string; tickets: TicketInfo[] }
  | { type: "events"; issueId: string; events: DisplayEvent[] }
  | { type: "events_append"; issueId: string; events: DisplayEvent[]; fromIndex: number }
  | { type: "ops_state"; state: OpsStatePayload }
  | { type: "ping" };

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;

type Assert<Condition extends true> = Condition;

// Compile-time protocol assertion: any payload drift must fail the package build.
type _WsServerMessageContract = Assert<Equal<WsServerMessage, ExpectedWsServerMessage>>;

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
