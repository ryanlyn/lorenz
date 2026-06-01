import { useState, useEffect, useRef, useCallback } from "react";

import type { OpsState } from "../api/types";
import { fetchOpsState } from "../api/client";

const RECONNECT_DELAY_MS = 3000;

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

    es.onopen = () => {
      setConnected(true);
    };

    es.onmessage = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as OpsState;
        setState(data);
      } catch {
        // Ignore malformed messages
      }
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;
      // Schedule reconnect
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        connect();
      }, RECONNECT_DELAY_MS);
    };
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
