import { useState, useEffect, useCallback, useRef } from "react";
// The stats subpath avoids pulling the server's Node-only watcher into the browser bundle.
import { computeStats } from "@lorenz/traceviz-server/stats";

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

function eventsEqual(a: DisplayEvent[], b: DisplayEvent[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every(
    (event, index) => event === b[index] || JSON.stringify(event) === JSON.stringify(b[index]),
  );
}

function useFollowMode() {
  const followingRef = useRef(true);
  const hasNewUpdatesRef = useRef(false);
  const [hasNewUpdates, setHasNewUpdates] = useState(false);
  const [followResumeVersion, setFollowResumeVersion] = useState(0);

  const setNewUpdates = useCallback((next: boolean) => {
    if (hasNewUpdatesRef.current === next) return;
    hasNewUpdatesRef.current = next;
    setHasNewUpdates(next);
  }, []);

  useEffect(() => {
    const onScroll = () => {
      const atTop = window.scrollY < FOLLOW_THRESHOLD_PX;
      if (followingRef.current === atTop) {
        if (atTop) setNewUpdates(false);
        return;
      }

      followingRef.current = atTop;
      if (atTop) {
        setNewUpdates(false);
        setFollowResumeVersion((version) => version + 1);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, [setNewUpdates]);

  const markNewUpdates = useCallback(() => setNewUpdates(true), [setNewUpdates]);
  const clearNewUpdates = useCallback(() => setNewUpdates(false), [setNewUpdates]);
  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return {
    followingRef,
    followResumeVersion,
    hasNewUpdates,
    markNewUpdates,
    clearNewUpdates,
    scrollToTop,
  };
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
  const {
    followingRef,
    followResumeVersion,
    hasNewUpdates,
    markNewUpdates,
    clearNewUpdates,
    scrollToTop,
  } = useFollowMode();
  // The effects below must read state that may have changed since they were registered.
  const needsCatchUpRef = useRef(false);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const selectedTicketIdRef = useRef(selectedTicketId);
  selectedTicketIdRef.current = selectedTicketId;
  const wsStatusRef = useRef(wsStatus);
  wsStatusRef.current = wsStatus;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
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

  // REST load: covers the initial load while the socket is down and the
  // catch-up fallback while disconnected. Connected flows go through
  // subscribe snapshots instead, so trace data always arrives on the same
  // ordered channel as the deltas.
  const loadTicketData = useCallback(
    async (issueId: string, options?: { silent?: boolean }) => {
      const requestId = ++loadRequestIdRef.current;
      const startRevision = streamRevisionRef.current;
      const silent = options?.silent ?? false;

      if (!silent) {
        setLoading(true);
        setTraceExists(null);
        setError(null);
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

  // Ask the server for a fresh full snapshot. Re-subscribing keeps the
  // response on the socket, where FIFO ordering guarantees it can never race
  // the delta stream the way a REST response can; REST is the fallback while
  // disconnected.
  const requestSnapshot = useCallback(
    (issueId: string) => {
      if (wsStatusRef.current === "connected") {
        sendMessage({ type: "subscribe", issueId });
      } else {
        void loadTicketData(issueId, { silent: true });
      }
    },
    [sendMessage, loadTicketData],
  );

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  useEffect(() => {
    loadRequestIdRef.current += 1;
    needsCatchUpRef.current = false;
    eventsRef.current = [];
    setEvents([]);
    setStats(null);
    setTraceExists(null);
    setError(null);
    const isLoading = selectedTicketId !== null;
    loadingRef.current = isLoading;
    setLoading(isLoading);
  }, [selectedTicketId]);

  // While the socket is down, load over REST so the view does not have to
  // wait for a reconnect. Also covers a socket that drops before the
  // subscribe snapshot arrives.
  useEffect(() => {
    if (!selectedTicketId || wsStatus === "connected") return;
    if (!loadingRef.current) return;
    void loadTicketData(selectedTicketId);
  }, [wsStatus, selectedTicketId, loadTicketData]);

  useEffect(() => {
    if (wsStatus !== "connected" || !selectedTicketId) return;
    sendMessage({ type: "subscribe", issueId: selectedTicketId });
    return () => {
      // Dropped silently when the socket is already closed; the server also
      // cleans up on disconnect.
      sendMessage({ type: "unsubscribe", issueId: selectedTicketId });
    };
  }, [wsStatus, selectedTicketId, sendMessage]);

  // Catch up when the user scrolls back to top.
  useEffect(() => {
    if (followResumeVersion > 0 && needsCatchUpRef.current && selectedTicketId) {
      needsCatchUpRef.current = false;
      requestSnapshot(selectedTicketId);
    }
  }, [followResumeVersion, selectedTicketId, requestSnapshot]);

  useEffect(() => {
    if (!lastMessage) return;
    const msg = lastMessage;

    if (msg.type === "init") {
      setTickets(msg.tickets);
    } else if (msg.type === "update") {
      setTickets(msg.tickets);
    } else if (msg.type === "events" && msg.issueId === selectedTicketId) {
      // Full snapshot: the response to a subscribe (initial load, reconnect,
      // or catch-up after browsing).
      if (loadingRef.current) {
        loadingRef.current = false;
        needsCatchUpRef.current = false;
        setLoading(false);
        setError(null);
        clearNewUpdates();
        applyEvents(msg.events);
      } else if (eventsEqual(msg.events, eventsRef.current)) {
        // Nothing new (e.g. a re-subscribe after a reconnect); skip so a
        // browsing user does not get a spurious "new updates" pill.
        needsCatchUpRef.current = false;
        clearNewUpdates();
      } else if (followingRef.current) {
        // A snapshot behind local events means the trace shrank or a REST
        // fallback raced ahead; ignore it — the next delta reconciles us to
        // the server's state either way.
        if (msg.events.length >= eventsRef.current.length) {
          setError(null);
          applyEvents(msg.events);
        }
      } else {
        needsCatchUpRef.current = true;
        markNewUpdates();
      }
    } else if (msg.type === "events_append" && msg.issueId === selectedTicketId) {
      // Delta: replace the display-event suffix starting at fromIndex.
      if (followingRef.current) {
        const result = reconcileEventAppend(eventsRef.current, msg.events, msg.fromIndex);
        if (result.needsRefresh) {
          requestSnapshot(selectedTicketId);
          return;
        }
        applyEvents(result.events);
      } else {
        needsCatchUpRef.current = true;
        markNewUpdates();
      }
    }
  }, [
    lastMessage,
    selectedTicketId,
    markNewUpdates,
    clearNewUpdates,
    requestSnapshot,
    applyEvents,
  ]);

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
    hasNewUpdates,
    scrollToTop,
  };
}
