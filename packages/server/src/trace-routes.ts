/** Trace routes shared by watcher-backed observability and fixed snapshots. */

import { Hono } from "hono";
import {
  TraceWatcher,
  type TicketInfo,
  type TicketTraceResponse,
  type TicketsResponse,
} from "@lorenz/traceviz-server";

import type { IssueStore } from "./issue-store.js";
import { decodePathParam, invalidPathParameterError } from "./path-params.js";

export interface TraceRoutesResult {
  app: Hono;
  watcher: TraceWatcher;
}

export interface TraceDataSource {
  getTickets(): TicketInfo[];
  getTicketTrace(issueId: string): TicketTraceResponse | null;
}

type WatcherTraceSource = Pick<TraceWatcher, "getEventsForTicket" | "getTicketInfo" | "getTickets">;

type IssueMetadataSource = Pick<IssueStore, "get" | "getMany">;

export function createTraceTicketRoutes(source: TraceDataSource): Hono {
  const app = new Hono();

  app.get("/api/v1/tickets", (c) => {
    const response: TicketsResponse = { tickets: source.getTickets() };
    return c.json(response);
  });

  app.get("/api/v1/tickets/:id/events", (c) => {
    const issueId = decodePathParam(c.req.param("id"));
    if (issueId === null) return c.json({ error: invalidPathParameterError }, 400);

    const trace = source.getTicketTrace(issueId);
    if (trace === null) return c.json({ error: "Ticket not found" }, 404);
    return c.json(trace);
  });

  return app;
}

export function createLiveTraceDataSource(
  watcher: WatcherTraceSource,
  issueStore: IssueMetadataSource,
): TraceDataSource {
  return {
    getTickets() {
      const tickets = watcher.getTickets();
      const records = issueStore.getMany(tickets.map((ticket) => ticket.issueId));
      return tickets.map((ticket) => {
        const record = records.get(ticket.issueId);
        return {
          ...ticket,
          ...(record && { title: record.title, url: record.url }),
        };
      });
    },
    getTicketTrace(issueId) {
      const ticketInfo = watcher.getTicketInfo(issueId);
      if (!ticketInfo) return null;

      const record = issueStore.get(issueId);
      return {
        issueId,
        identifier: record?.issueIdentifier ?? ticketInfo?.identifier ?? issueId,
        events: watcher.getEventsForTicket(issueId),
      };
    },
  };
}

export function createFixedTraceDataSource(
  trace: TicketTraceResponse,
  turnCount: number,
): TraceDataSource {
  const ticket: TicketInfo = {
    issueId: trace.issueId,
    identifier: trace.identifier,
    turnCount,
    status: "completed",
    startedAt: trace.events[0]?.timestamp,
  };

  return {
    getTickets: () => [ticket],
    getTicketTrace: (requestedIssueId) => (requestedIssueId === trace.issueId ? trace : null),
  };
}

/**
 * Creates a Hono sub-app exposing trace routes and a TraceWatcher instance.
 *
 * The caller can wire the watcher's callback to WebSocket broadcast externally.
 */
export function createTraceRoutes(traceDir: string, issueStore: IssueStore): TraceRoutesResult {
  const watcher = new TraceWatcher(traceDir);
  const app = new Hono();
  const source = createLiveTraceDataSource(watcher, issueStore);

  app.get("/api/v1/issues/recent", (c) => {
    const limit = Math.min(
      100,
      Math.max(1, Number(new URL(c.req.url).searchParams.get("limit")) || 5),
    );
    const issues = issueStore.getRecent(limit);
    return c.json({ issues });
  });

  app.get("/api/v1/issues/search", (c) => {
    const params = new URL(c.req.url).searchParams;
    const q = params.get("q") ?? "";
    const limit = Math.min(100, Math.max(1, Number(params.get("limit")) || 20));
    const issues = issueStore.search(q, limit);
    return c.json({ issues });
  });

  app.get("/api/v1/tickets/:id/exists", (c) => {
    const issueId = decodePathParam(c.req.param("id"));
    if (issueId === null) return c.json({ error: invalidPathParameterError }, 400);
    const exists = watcher.hasTicket(issueId);
    return c.json({ exists });
  });

  app.route("/", createTraceTicketRoutes(source));

  return { app, watcher };
}

export { decodePathParam, invalidPathParameterError } from "./path-params.js";
