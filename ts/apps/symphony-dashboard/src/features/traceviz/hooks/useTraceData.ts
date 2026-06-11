import { useState, useEffect, useCallback, useRef } from "react";
// The stats subpath avoids pulling the server's Node-only watcher into the browser bundle.
import { computeStats } from "@symphony/traceviz-server/stats";

import { useWebSocket } from "../../../shared/hooks/useWebSocket";
import type { TicketInfo, DisplayEvent, Stats } from "../api/types";
import { fetchTickets, fetchEvents } from "../api/client";

const FOLLOW_THRESHOLD_PX = 50;

interface EventAppendReconcileResult {
  events: DisplayEvent[];
  needsRefresh: boolean;
}

export function reconcileEventAppend(
  current: DisplayEvent[],
  appended: DisplayEvent[],
  fromIndex: number,
): EventAppendReconcileResult {
  if (fromIndex < 0 || fromIndex > current.length) {
    return { events: current, needsRefresh: true };
  }

  return { events: [...current.slice(0, fromIndex), ...appended], needsRefresh: false };
}

function useFollowMode() {
  const [following, setFollowing] = useState(true);
  const [hasNewUpdates, setHasNewUpdates] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      const atTop = window.scrollY < FOLLOW_THRESHOLD_PX;
      setFollowing(atTop);
      if (atTop) setHasNewUpdates(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const markNewUpdates = useCallback(() => setHasNewUpdates(true), []);
  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return { following, hasNewUpdates, markNewUpdates, scrollToTop };
}

export function useTraceData() {
  const [tickets, setTickets] = useState<TicketInfo[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [events, setEvents] = useState<DisplayEvent[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traceExists, setTraceExists] = useState<boolean | null>(null);

  const { status: wsStatus, lastMessage, sendMessage } = useWebSocket();
  const { following, hasNewUpdates, markNewUpdates, scrollToTop } = useFollowMode();
  // The WS message effect must read state that may have changed since the effect was registered.
  const followingRef = useRef(following);
  followingRef.current = following;
  const needsCatchUpRef = useRef(false);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const selectedTicketIdRef = useRef(selectedTicketId);
  selectedTicketIdRef.current = selectedTicketId;
  const streamRevisionRef = useRef(0);
  const loadRequestIdRef = useRef(0);

  const loadTickets = useCallback(async () => {
    const data = await fetchTickets();
    setTickets(data);
  }, []);

  const applyEvents = useCallback((eventsData: DisplayEvent[], exists = eventsData.length > 0) => {
    eventsRef.current = eventsData;
    streamRevisionRef.current += 1;
    setEvents(eventsData);
    setStats(computeStats(eventsData));
    setTraceExists(exists);
  }, []);

  const loadTicketData = useCallback(
    async (issueId: string, options?: { silent?: boolean }) => {
      const requestId = ++loadRequestIdRef.current;
      const startRevision = streamRevisionRef.current;
      const silent = options?.silent ?? false;

      if (!silent) {
        setLoading(true);
        setTraceExists(null);
      }

      try {
        const eventsData = await fetchEvents(issueId);

        if (selectedTicketIdRef.current !== issueId || requestId !== loadRequestIdRef.current) {
          return;
        }

        const currentLength = eventsRef.current.length;
        if (streamRevisionRef.current !== startRevision && eventsData.length <= currentLength) {
          return;
        }

        setError(null);
        applyEvents(eventsData);
      } catch {
        if (selectedTicketIdRef.current !== issueId || requestId !== loadRequestIdRef.current) {
          return;
        }
        if (!silent) {
          setError("Failed to load trace data");
          applyEvents([], false);
        }
      } finally {
        if (
          !silent &&
          selectedTicketIdRef.current === issueId &&
          requestId === loadRequestIdRef.current
        ) {
          setLoading(false);
        }
      }
    },
    [applyEvents],
  );

  const refreshTicketData = useCallback(
    async (issueId: string) => {
      await loadTicketData(issueId, { silent: true });
    },
    [loadTicketData],
  );

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  useEffect(() => {
    loadRequestIdRef.current += 1;
    needsCatchUpRef.current = false;
    if (selectedTicketId) {
      eventsRef.current = [];
      setEvents([]);
      setStats(null);
      setTraceExists(null);
      void loadTicketData(selectedTicketId);
    } else {
      eventsRef.current = [];
      setEvents([]);
      setStats(null);
      setTraceExists(null);
      setLoading(false);
    }
  }, [selectedTicketId, loadTicketData]);

  useEffect(() => {
    if (wsStatus === "connected" && selectedTicketId) {
      sendMessage({ type: "subscribe", issueId: selectedTicketId });
    }
  }, [wsStatus, selectedTicketId, sendMessage]);

  // Catch up when user scrolls back to top
  useEffect(() => {
    if (following && needsCatchUpRef.current && selectedTicketId) {
      needsCatchUpRef.current = false;
      void refreshTicketData(selectedTicketId);
    }
  }, [following, selectedTicketId, refreshTicketData]);

  useEffect(() => {
    if (!lastMessage) return;
    const msg = lastMessage;

    if (msg.type === "init") {
      setTickets(msg.tickets);
    } else if (msg.type === "update") {
      setTickets(msg.tickets);
    } else if (msg.type === "events" && msg.issueId === selectedTicketId) {
      // Full event payload (initial subscribe response)
      if (followingRef.current) {
        if (msg.events.length < eventsRef.current.length) {
          void refreshTicketData(selectedTicketId);
          return;
        }
        applyEvents(msg.events);
      } else {
        needsCatchUpRef.current = true;
        markNewUpdates();
      }
    } else if (msg.type === "events_append" && msg.issueId === selectedTicketId) {
      // Delta: replace the display-event suffix starting at fromIndex.
      if (followingRef.current) {
        const current = eventsRef.current;
        const result = reconcileEventAppend(current, msg.events, msg.fromIndex);
        if (result.needsRefresh) {
          void refreshTicketData(selectedTicketId);
          return;
        }
        applyEvents(result.events);
      } else {
        needsCatchUpRef.current = true;
        markNewUpdates();
      }
    }
  }, [lastMessage, selectedTicketId, markNewUpdates, refreshTicketData, applyEvents]);

  return {
    tickets,
    selectedTicketId,
    setSelectedTicketId,
    events,
    stats,
    loading,
    error,
    traceExists,
    wsStatus,
    following,
    hasNewUpdates,
    scrollToTop,
  };
}
