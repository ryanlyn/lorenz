import { useEffect, useRef, useState, useCallback } from "react";
import type { OpsStatePayload } from "@lorenz/presenter";
import type { TicketInfo, DisplayEvent, WsClientMessage } from "@lorenz/traceviz-server";

/** Messages pushed by the server over the `/ws` connection. */
export type WsMessage =
  | { type: "init"; tickets: TicketInfo[] }
  | { type: "update"; issueId: string; tickets: TicketInfo[] }
  | { type: "events"; issueId: string; events: DisplayEvent[] }
  | { type: "events_append"; issueId: string; events: DisplayEvent[]; fromIndex: number }
  | { type: "ops_state"; state: OpsStatePayload }
  | { type: "ping" };

type WsStatus = "connecting" | "connected" | "disconnected";

export function useWebSocket() {
  const [status, setStatus] = useState<WsStatus>("disconnected");
  const [lastMessage, setLastMessage] = useState<WsMessage | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);

  const connect = useCallback(() => {
    if (disposedRef.current) return;
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    )
      return;

    setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as WsMessage;
        if (message.type !== "ping") {
          setLastMessage(message);
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
      if (disposedRef.current) return;
      if (wsRef.current === ws) {
        wsRef.current = null;
        reconnectTimer.current = setTimeout(connect, 3000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  const sendMessage = useCallback((message: WsClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    connect();
    return () => {
      disposedRef.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [connect]);

  return { status, lastMessage, sendMessage };
}
