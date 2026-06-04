import { useState, useEffect, useRef, useCallback } from "react";

import type { OpsState } from "../api/types";
import { fetchOpsState } from "../api/client";

const RECONNECT_DELAY_MS = 3000;

interface OpsStreamCallbacks {
  setConnected(connected: boolean): void;
  setState(state: OpsState): void;
  scheduleReconnect(): void;
}

interface OpsEventSourceLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export function wireOpsStream(stream: OpsEventSourceLike, callbacks: OpsStreamCallbacks): void {
  stream.onopen = () => {
    callbacks.setConnected(true);
  };

  stream.addEventListener("state", (event: MessageEvent<string>) => {
    try {
      const data = JSON.parse(event.data) as OpsState;
      callbacks.setState(data);
    } catch {
      // Ignore malformed messages
    }
  });

  stream.onerror = () => {
    callbacks.setConnected(false);
    stream.close();
    callbacks.scheduleReconnect();
  };
}

export function useOpsStream() {
  const [state, setState] = useState<OpsState | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    // Clean up any existing connection
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const es = new EventSource("/api/v1/events");
    esRef.current = es;

    wireOpsStream(es, {
      setConnected,
      setState,
      scheduleReconnect: () => {
        esRef.current = null;
        reconnectTimer.current = setTimeout(() => {
          reconnectTimer.current = null;
          connect();
        }, RECONNECT_DELAY_MS);
      },
    });
  }, []);

  useEffect(() => {
    // Initial fetch for immediate data
    void fetchOpsState().then((data) => {
      if (data) setState(data);
    });

    // Start SSE connection
    connect();

    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    };
  }, [connect]);

  return { state, connected };
}
