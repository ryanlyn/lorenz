/**
 * Trace routes for the unified dashboard.
 *
 * Exposes ticket/event/stats data from TraceWatcher via REST endpoints.
 */

import { Hono } from "hono";
import { TraceWatcher, computeStats } from "@symphony/traceviz-server";

export interface TraceRoutesResult {
  app: Hono;
  watcher: TraceWatcher;
}

/**
 * Creates a Hono sub-app exposing trace routes and a TraceWatcher instance.
 *
 * The caller can wire the watcher's callback to WebSocket broadcast externally.
 */
export function createTraceRoutes(traceDir: string): TraceRoutesResult {
  const watcher = new TraceWatcher(traceDir);
  const app = new Hono();

  app.get("/api/v1/tickets", (c) => {
    return c.json({ tickets: watcher.getTickets() });
  });

  app.get("/api/v1/tickets/:id/events", (c) => {
    const issueId = decodeURIComponent(c.req.param("id"));
    const events = watcher.getEventsForTicket(issueId);
    const tickets = watcher.getTickets();
    const ticket = tickets.find((t) => t.issueId === issueId);
    return c.json({
      issueId,
      identifier: ticket?.identifier ?? issueId,
      events,
    });
  });

  app.get("/api/v1/tickets/:id/stats", (c) => {
    const issueId = decodeURIComponent(c.req.param("id"));
    const events = watcher.getEventsForTicket(issueId);
    return c.json(computeStats(events));
  });

  return { app, watcher };
}
