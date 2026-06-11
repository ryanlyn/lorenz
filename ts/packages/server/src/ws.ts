/**
 * WebSocket support for the unified dashboard.
 *
 * Manages WebSocket connections on `/ws`, the single push transport for the
 * dashboard: it broadcasts trace watcher updates, streams ops-state snapshots
 * from the runtime, and handles subscribe messages for individual tickets.
 */

import type { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { statePayload, type OpsStatePayload } from "@symphony/presenter";
import type { DisplayEvent, TicketInfo, TraceWatcher } from "@symphony/traceviz-server";
import type { WSContext } from "hono/ws";

import type { RuntimeServerSource } from "./index.js";

type WsServerMessage =
  | { type: "init"; tickets: TicketInfo[] }
  | { type: "update"; issueId: string; tickets: TicketInfo[] }
  | { type: "events"; issueId: string; events: DisplayEvent[] }
  | { type: "events_append"; issueId: string; events: DisplayEvent[]; fromIndex: number }
  | { type: "ops_state"; state: OpsStatePayload };

export interface WsSetupResult {
  /** Call after the HTTP server starts listening to enable WebSocket upgrades. */
  injectWebSocket: (server: unknown) => void;
  /** Stops the trace watcher and the runtime ops-state subscription. */
  stop: () => void;
}

/**
 * Sets up WebSocket handling on the given Hono app.
 *
 * - On connect: sends { type: "init", tickets: [...] } followed by the current
 *   ops state as { type: "ops_state", state: {...} } when a snapshot is available
 * - On message "subscribe" with { issueId }: sends events for that ticket
 * - Broadcasts watcher updates and runtime ops-state updates to all clients
 */
interface ClientState {
  subscribedIssueId: string | null;
  sentEvents: DisplayEvent[];
}

function findFirstChangedEventIndex(previous: DisplayEvent[], next: DisplayEvent[]): number | null {
  const commonLength = Math.min(previous.length, next.length);
  for (let index = 0; index < commonLength; index++) {
    if (JSON.stringify(previous[index]) !== JSON.stringify(next[index])) return index;
  }

  return previous.length === next.length ? null : commonLength;
}

export function createWsHandler(
  app: Hono,
  runtime: RuntimeServerSource,
  watcher: TraceWatcher | null,
): WsSetupResult {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const connections = new Map<WSContext, ClientState>();

  const send = (ws: WSContext, message: WsServerMessage) => {
    ws.send(JSON.stringify(message));
  };

  const broadcast = (message: WsServerMessage) => {
    const data = JSON.stringify(message);
    for (const [ws] of connections) {
      try {
        ws.send(data);
      } catch {
        cleanupClient(ws);
      }
    }
  };

  function cleanupClient(ws: WSContext) {
    const state = connections.get(ws);
    if (state?.subscribedIssueId && watcher) {
      watcher.unsubscribe(state.subscribedIssueId);
    }
    connections.delete(ws);
  }

  // Register the WebSocket upgrade route
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event: unknown, ws: WSContext) {
        connections.set(ws, { subscribedIssueId: null, sentEvents: [] });
        send(ws, { type: "init", tickets: watcher?.getTickets() ?? [] });
        const state = currentOpsState(runtime);
        if (state) send(ws, { type: "ops_state", state });
      },
      onMessage(event: { data: unknown }, ws: WSContext) {
        try {
          const data = typeof event.data === "string" ? event.data : String(event.data);
          const message = JSON.parse(data) as Record<string, unknown>;
          if (watcher && message.type === "subscribe" && typeof message.issueId === "string") {
            const clientState = connections.get(ws);
            if (!clientState) return;

            if (
              clientState.subscribedIssueId &&
              clientState.subscribedIssueId !== message.issueId
            ) {
              watcher.unsubscribe(clientState.subscribedIssueId);
            }

            if (clientState.subscribedIssueId !== message.issueId) {
              watcher.subscribe(message.issueId);
              clientState.subscribedIssueId = message.issueId;
            }

            const events = watcher.getEventsForTicket(message.issueId);
            clientState.sentEvents = events;
            send(ws, { type: "events", issueId: message.issueId, events });
          }
        } catch {
          // Ignore malformed messages
        }
      },
      onClose(_event: unknown, ws: WSContext) {
        cleanupClient(ws);
      },
    })),
  );

  // Wire up the watcher to broadcast trace updates
  watcher?.start((issueId) => {
    const tickets = watcher.getTickets();

    for (const [ws, clientState] of connections) {
      try {
        // Always send the ticket list update
        send(ws, { type: "update", issueId, tickets });

        // Send delta events to subscribed clients
        if (clientState.subscribedIssueId === issueId) {
          const events = watcher.getEventsForTicket(issueId);
          const fromIndex = findFirstChangedEventIndex(clientState.sentEvents, events);
          if (fromIndex !== null) {
            send(ws, {
              type: "events_append",
              issueId,
              events: events.slice(fromIndex),
              fromIndex,
            });
            clientState.sentEvents = events;
          }
        }
      } catch {
        cleanupClient(ws);
      }
    }
  });

  // Wire up the runtime to broadcast ops-state updates
  const unsubscribe = subscribeToRuntime(runtime, (snapshot) => {
    if (connections.size === 0) return;
    broadcast({ type: "ops_state", state: statePayload(snapshot) });
  });

  return {
    injectWebSocket: injectWebSocket as (server: unknown) => void,
    stop() {
      unsubscribe?.();
      watcher?.stop();
    },
  };
}

function currentOpsState(runtime: RuntimeServerSource): OpsStatePayload | null {
  try {
    return statePayload(runtime.snapshot());
  } catch {
    return null;
  }
}

function subscribeToRuntime(
  runtime: RuntimeServerSource,
  listener: Parameters<RuntimeServerSource["subscribe"]>[0],
): (() => void) | null {
  try {
    return runtime.subscribe(listener);
  } catch {
    return null;
  }
}
