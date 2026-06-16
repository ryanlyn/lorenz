import { useState, useEffect } from "react";

import { useWebSocket } from "../../../shared/hooks/useWebSocket";
import type { OpsState } from "../api/types";
import { fetchOpsState } from "../api/client";

/** Streams ops state over the shared `/ws` connection, seeded by an initial REST fetch. */
export function useOpsState() {
  const [state, setState] = useState<OpsState | null>(null);
  const { status, lastMessage } = useWebSocket();

  useEffect(() => {
    // Initial fetch for immediate data
    void fetchOpsState().then((data) => {
      if (data) setState(data);
    });
  }, []);

  useEffect(() => {
    if (lastMessage?.type === "ops_state") setState(lastMessage.state);
  }, [lastMessage]);

  return { state, connected: status === "connected" };
}
