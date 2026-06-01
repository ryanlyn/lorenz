import type { TicketInfo, DisplayEvent, Stats, OpsState } from "./types";

export async function fetchTickets(): Promise<TicketInfo[]> {
  const res = await fetch("/api/v1/tickets");
  if (!res.ok) return [];
  const data = (await res.json()) as { tickets: TicketInfo[] };
  return data.tickets;
}

export async function fetchEvents(issueId: string): Promise<DisplayEvent[]> {
  const res = await fetch(`/api/v1/tickets/${encodeURIComponent(issueId)}/events`);
  if (!res.ok) return [];
  const data = (await res.json()) as { events: DisplayEvent[] };
  return data.events;
}

export async function fetchStats(issueId: string): Promise<Stats | null> {
  const res = await fetch(`/api/v1/tickets/${encodeURIComponent(issueId)}/stats`);
  if (!res.ok) return null;
  return res.json() as Promise<Stats>;
}

export async function fetchOpsState(): Promise<OpsState | null> {
  const res = await fetch("/api/v1/state");
  if (!res.ok) return null;
  return res.json() as Promise<OpsState>;
}
