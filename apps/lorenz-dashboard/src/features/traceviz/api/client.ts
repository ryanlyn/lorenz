import type { TicketInfo, DisplayEvent, IssueRecord } from "./types";

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

export async function fetchRecentIssues(limit = 5): Promise<IssueRecord[]> {
  const res = await fetch(`/api/v1/issues/recent?limit=${limit}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { issues: IssueRecord[] };
  return data.issues;
}

export async function searchIssues(query: string, limit = 20): Promise<IssueRecord[]> {
  const res = await fetch(`/api/v1/issues/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { issues: IssueRecord[] };
  return data.issues;
}
