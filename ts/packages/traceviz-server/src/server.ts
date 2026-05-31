/**
 * Fastify application for the traceviz server.
 *
 * Endpoints:
 *   GET  /health                       - Health check
 *   GET  /api/tickets                  - List all tracked tickets
 *   GET  /api/tickets/:issueId/events  - Get parsed events for a ticket
 *   GET  /api/tickets/:issueId/stats   - Get computed stats for a ticket
 *   WS   /ws                           - WebSocket for live event streaming
 */

import fs from "node:fs";

import fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import type { WebSocket } from "@fastify/websocket";

import type {
  HealthResponse,
  TicketsResponse,
  TicketTraceResponse,
  TraceStats,
} from "./models/api.js";
import type { DisplayEvent } from "./models/display-events.js";
import { TraceWatcher } from "./watcher.js";
import { computeStats } from "./stats.js";

export interface CreateAppOptions {
  traceDir: string;
  staticDir?: string | undefined;
}

export async function createApp(options: CreateAppOptions) {
  const { traceDir, staticDir } = options;

  const app = fastify({ logger: false });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Serve static frontend if directory exists
  if (staticDir && fs.existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: "/",
      wildcard: true,
    });
  }

  // State
  const connections = new Set<WebSocket>();
  const watcher = new TraceWatcher(traceDir);

  // Start watching and broadcast updates
  watcher.start((issueId: string, events: DisplayEvent[]) => {
    if (connections.size > 0) {
      const message = JSON.stringify({
        type: "events_update",
        issueId,
        eventCount: events.length,
      });
      broadcast(message);
    }
  });

  function broadcast(msg: string): void {
    for (const ws of connections) {
      try {
        ws.send(msg);
      } catch (err) {
        connections.delete(ws);
        console.debug("[traceviz] WebSocket send failed, removing connection:", err);
      }
    }
  }

  // --- Routes ---

  app.get("/health", (): HealthResponse => {
    return { status: "ok" };
  });

  app.get("/api/tickets", (): TicketsResponse => {
    return { tickets: watcher.getTickets() };
  });

  app.get<{ Params: { issueId: string } }>(
    "/api/tickets/:issueId/events",
    (request): TicketTraceResponse => {
      const { issueId } = request.params;
      const events = watcher.getEventsForTicket(issueId);
      const tickets = watcher.getTickets();
      const ticket = tickets.find((t) => t.issueId === issueId);
      return {
        issueId,
        identifier: ticket?.identifier ?? issueId,
        events,
      };
    },
  );

  app.get<{ Params: { issueId: string } }>("/api/tickets/:issueId/stats", (request): TraceStats => {
    const { issueId } = request.params;
    const events = watcher.getEventsForTicket(issueId);
    return computeStats(events);
  });

  // WebSocket endpoint for live updates
  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    connections.add(socket);

    // Send initial state
    const tickets = watcher.getTickets();
    socket.send(JSON.stringify({ type: "init", tickets }));

    socket.on("message", (data: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof data === "string" ? data : data.toString()) as Record<
          string,
          unknown
        >;
        if (msg.type === "subscribe" && typeof msg.issueId === "string") {
          // Client wants events for a specific ticket
          const events = watcher.getEventsForTicket(msg.issueId);
          socket.send(JSON.stringify({ type: "events", issueId: msg.issueId, events }));
        }
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on("close", () => {
      connections.delete(socket);
    });
  });

  // Cleanup on close
  app.addHook("onClose", () => {
    watcher.stop();
    for (const ws of connections) {
      ws.close();
    }
    connections.clear();
  });

  return app;
}
