/**
 * WebSocket support for the unified dashboard.
 *
 * Manages WebSocket connections, broadcasts watcher updates, and handles
 * subscribe messages for individual tickets.
 */

import type { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import type { TraceWatcher } from "@symphony/traceviz-server";
import type { WSContext } from "hono/ws";

export interface WsSetupResult {
  /** Call after the HTTP server starts listening to enable WebSocket upgrades. */
  injectWebSocket: (server: unknown) => void;
}

/**
 * Sets up WebSocket handling on the given Hono app for trace data streaming.
 *
 * - On connect: sends { type: "init", tickets: [...] }
 * - On message "subscribe" with { issueId }: sends events for that ticket
 * - Broadcasts watcher updates to all connected clients
 */
export function createWsHandler(app: Hono, watcher: TraceWatcher): WsSetupResult {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const connections = new Set<WSContext>();

  // Register the WebSocket upgrade route
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event: unknown, ws: WSContext) {
        connections.add(ws);
        // Send initial ticket list
        const tickets = watcher.getTickets();
        ws.send(JSON.stringify({ type: "init", tickets }));
      },
      onMessage(event: { data: unknown }, ws: WSContext) {
        try {
          const data =
            typeof event.data === "string" ? event.data : String(event.data);
          const message = JSON.parse(data) as Record<string, unknown>;
          if (message.type === "subscribe" && typeof message.issueId === "string") {
            const events = watcher.getEventsForTicket(message.issueId);
            ws.send(
              JSON.stringify({
                type: "events",
                issueId: message.issueId,
                events,
              }),
            );
          }
        } catch {
          // Ignore malformed messages
        }
      },
      onClose(_event: unknown, ws: WSContext) {
        connections.delete(ws);
      },
    })),
  );

  // Wire up the watcher to broadcast updates
  watcher.start((issueId, events) => {
    const message = JSON.stringify({
      type: "update",
      issueId,
      events,
      tickets: watcher.getTickets(),
    });
    for (const ws of connections) {
      try {
        ws.send(message);
      } catch {
        connections.delete(ws);
      }
    }
  });

  return { injectWebSocket: injectWebSocket as (server: unknown) => void };
}
