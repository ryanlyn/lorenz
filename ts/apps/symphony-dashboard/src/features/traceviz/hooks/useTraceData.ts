import { useState, useEffect, useCallback } from "react";

import type { TicketInfo, DisplayEvent, Stats } from "../api/types";
import { fetchTickets, fetchEvents, fetchStats } from "../api/client";
import { computeStatsFromEvents } from "../api/stats";

import { useWebSocket } from "./useWebSocket";

export function useTraceData() {
  const [tickets, setTickets] = useState<TicketInfo[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [events, setEvents] = useState<DisplayEvent[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traceExists, setTraceExists] = useState<boolean | null>(null);

  const { status: wsStatus, lastMessage } = useWebSocket();

  const loadTickets = useCallback(async () => {
    const data = await fetchTickets();
    setTickets(data);
  }, []);

  const loadTicketData = useCallback(async (issueId: string) => {
    setLoading(true);
    setTraceExists(null);
    try {
      setError(null);
      const [eventsData, statsData] = await Promise.all([
        fetchEvents(issueId),
        fetchStats(issueId),
      ]);
      setEvents(eventsData);
      setStats(statsData);
      setTraceExists(eventsData.length > 0);
    } catch {
      setError("Failed to load trace data");
      setEvents([]);
      setStats(null);
      setTraceExists(false);
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
      setTraceExists(null);
    }
  }, [selectedTicketId, loadTicketData]);

  useEffect(() => {
    if (!lastMessage) return;
    const msg = lastMessage;

    if (msg.type === "init") {
      setTickets(msg.tickets);
    } else if (msg.type === "update") {
      setTickets(msg.tickets);
      if (msg.issueId === selectedTicketId) {
        setEvents(msg.events);
        setStats(computeStatsFromEvents(msg.events));
        setTraceExists(true);
      }
    } else if (msg.type === "events" && msg.issueId === selectedTicketId) {
      setEvents(msg.events);
      setStats(computeStatsFromEvents(msg.events));
      setTraceExists(true);
    }
  }, [lastMessage, selectedTicketId]);

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
  };
}
