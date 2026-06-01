import { useState, useEffect, useCallback, useRef } from "react";

import type { TicketInfo, DisplayEvent, Stats } from "../api/types";
import { fetchTickets, fetchEvents, fetchStats } from "../api/client";

import { useWebSocket } from "./useWebSocket";

const TICKET_REFRESH_DEBOUNCE_MS = 300;

export function useTraceData() {
  const [tickets, setTickets] = useState<TicketInfo[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [events, setEvents] = useState<DisplayEvent[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);

  const { status: wsStatus, lastMessage } = useWebSocket();

  const ticketRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTickets = useCallback(async () => {
    const data = await fetchTickets();
    setTickets(data);
  }, []);

  /** Debounced ticket list refresh to avoid excessive HTTP requests during high activity. */
  const scheduleTicketRefresh = useCallback(() => {
    if (ticketRefreshTimer.current) return; // Already scheduled
    ticketRefreshTimer.current = setTimeout(() => {
      ticketRefreshTimer.current = null;
      void loadTickets();
    }, TICKET_REFRESH_DEBOUNCE_MS);
  }, [loadTickets]);

  const loadTicketData = useCallback(async (issueId: string) => {
    setLoading(true);
    try {
      const [eventsData, statsData] = await Promise.all([
        fetchEvents(issueId),
        fetchStats(issueId),
      ]);
      setEvents(eventsData);
      setStats(statsData);
    } catch {
      setEvents([]);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  useEffect(() => {
    if (selectedTicketId) {
      void loadTicketData(selectedTicketId);
    } else {
      setEvents([]);
      setStats(null);
    }
  }, [selectedTicketId, loadTicketData]);

  useEffect(() => {
    if (!lastMessage) return;
    const msg = lastMessage;

    if (msg.type === "init") {
      setTickets(msg.tickets);
    } else if (msg.type === "events_update") {
      // Debounce ticket list refresh to avoid excessive requests during high activity
      scheduleTicketRefresh();
      if (msg.issueId === selectedTicketId) {
        void loadTicketData(msg.issueId);
      }
    } else if (msg.type === "events" && msg.issueId === selectedTicketId) {
      setEvents(msg.events);
      fetchStats(msg.issueId)
        .then(setStats)
        .catch(() => {});
    }
  }, [lastMessage, selectedTicketId, loadTicketData, scheduleTicketRefresh]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (ticketRefreshTimer.current) {
        clearTimeout(ticketRefreshTimer.current);
      }
    };
  }, []);

  return {
    tickets,
    selectedTicketId,
    setSelectedTicketId,
    events,
    stats,
    loading,
    wsStatus,
  };
}
