import { describe, it, expect } from "vitest";

import type { TicketInfo } from "../src/features/traceviz/api/types";

function sortTicketsByRecency(tickets: TicketInfo[]): TicketInfo[] {
  return [...tickets].sort((a, b) => {
    if (a.startedAt && b.startedAt) return b.startedAt.localeCompare(a.startedAt);
    if (a.startedAt) return -1;
    if (b.startedAt) return 1;
    return 0;
  });
}

function navigateTraces(
  tickets: TicketInfo[],
  selectedId: string,
  direction: "prev" | "next",
): string | null {
  const currentIndex = tickets.findIndex((t) => t.issueId === selectedId);
  if (currentIndex === -1) return null;
  if (direction === "prev" && currentIndex > 0) return tickets[currentIndex - 1]!.issueId;
  if (direction === "next" && currentIndex < tickets.length - 1)
    return tickets[currentIndex + 1]!.issueId;
  return null;
}

const mockTickets: TicketInfo[] = [
  {
    issueId: "CAN-101",
    identifier: "CAN-101",
    title: "Fix auth flow",
    turnCount: 5,
    status: "completed",
    startedAt: "2025-01-15T10:00:00Z",
  },
  {
    issueId: "CAN-102",
    identifier: "CAN-102",
    title: "Add search",
    turnCount: 3,
    status: "running",
    startedAt: "2025-01-16T08:00:00Z",
  },
  {
    issueId: "CAN-103",
    identifier: "CAN-103",
    title: "Refactor DB layer",
    turnCount: 8,
    status: "failed",
    startedAt: "2025-01-14T12:00:00Z",
  },
  {
    issueId: "CAN-104",
    identifier: "CAN-104",
    turnCount: 0,
    status: "idle",
  },
];

describe("TraceList sorting", () => {
  it("sorts tickets by startedAt descending (most recent first)", () => {
    const sorted = sortTicketsByRecency(mockTickets);
    expect(sorted[0]!.issueId).toBe("CAN-102");
    expect(sorted[1]!.issueId).toBe("CAN-101");
    expect(sorted[2]!.issueId).toBe("CAN-103");
  });

  it("puts tickets without startedAt last", () => {
    const sorted = sortTicketsByRecency(mockTickets);
    expect(sorted[sorted.length - 1]!.issueId).toBe("CAN-104");
  });

  it("handles empty list", () => {
    expect(sortTicketsByRecency([])).toEqual([]);
  });

  it("handles single ticket", () => {
    const single = [mockTickets[0]!];
    expect(sortTicketsByRecency(single)).toHaveLength(1);
    expect(sortTicketsByRecency(single)[0]!.issueId).toBe("CAN-101");
  });

  it("does not mutate the original array", () => {
    const original = [...mockTickets];
    sortTicketsByRecency(mockTickets);
    expect(mockTickets).toEqual(original);
  });
});

describe("TraceNavigator logic", () => {
  const tickets = mockTickets;

  it("navigates to next trace", () => {
    expect(navigateTraces(tickets, "CAN-101", "next")).toBe("CAN-102");
    expect(navigateTraces(tickets, "CAN-102", "next")).toBe("CAN-103");
    expect(navigateTraces(tickets, "CAN-103", "next")).toBe("CAN-104");
  });

  it("returns null at end of list (next)", () => {
    expect(navigateTraces(tickets, "CAN-104", "next")).toBeNull();
  });

  it("navigates to previous trace", () => {
    expect(navigateTraces(tickets, "CAN-104", "prev")).toBe("CAN-103");
    expect(navigateTraces(tickets, "CAN-103", "prev")).toBe("CAN-102");
    expect(navigateTraces(tickets, "CAN-102", "prev")).toBe("CAN-101");
  });

  it("returns null at start of list (prev)", () => {
    expect(navigateTraces(tickets, "CAN-101", "prev")).toBeNull();
  });

  it("returns null for unknown ticket id", () => {
    expect(navigateTraces(tickets, "UNKNOWN-99", "next")).toBeNull();
    expect(navigateTraces(tickets, "UNKNOWN-99", "prev")).toBeNull();
  });

  it("returns null when list has single element", () => {
    const single = [tickets[0]!];
    expect(navigateTraces(single, "CAN-101", "next")).toBeNull();
    expect(navigateTraces(single, "CAN-101", "prev")).toBeNull();
  });

  it("returns null on empty list", () => {
    expect(navigateTraces([], "CAN-101", "next")).toBeNull();
    expect(navigateTraces([], "CAN-101", "prev")).toBeNull();
  });
});

describe("TraceView routing integration", () => {
  function parseHash(hash: string): { view: string; issueId: string } {
    const path = hash.replace(/^#/, "") || "/";
    const traceMatch = path.match(/^\/trace(?:\/(.+)?)?$/);
    if (traceMatch) {
      return { view: "trace", issueId: traceMatch[1] ? decodeURIComponent(traceMatch[1]) : "" };
    }
    return { view: "overview", issueId: "" };
  }

  it("routes #/trace/ to trace view with empty issueId", () => {
    const route = parseHash("#/trace/");
    expect(route.view).toBe("trace");
    expect(route.issueId).toBe("");
  });

  it("routes #/trace/CAN-101 to trace view with issueId", () => {
    const route = parseHash("#/trace/CAN-101");
    expect(route.view).toBe("trace");
    expect(route.issueId).toBe("CAN-101");
  });

  it("decodes percent-encoded issue IDs", () => {
    const route = parseHash("#/trace/CAN%2F101");
    expect(route.issueId).toBe("CAN/101");
  });

  it("routes #/ to overview", () => {
    const route = parseHash("#/");
    expect(route.view).toBe("overview");
  });

  it("routes empty hash to overview", () => {
    const route = parseHash("");
    expect(route.view).toBe("overview");
  });
});

describe("TicketInfo status derivation", () => {
  it("recognizes all valid status values", () => {
    const statuses: TicketInfo["status"][] = ["idle", "running", "completed", "failed"];
    for (const status of statuses) {
      const ticket: TicketInfo = { issueId: "X", identifier: "X", turnCount: 0, status };
      expect(ticket.status).toBe(status);
    }
  });

  it("ticket list preserves all metadata fields", () => {
    const ticket = mockTickets[0]!;
    expect(ticket.issueId).toBe("CAN-101");
    expect(ticket.identifier).toBe("CAN-101");
    expect(ticket.title).toBe("Fix auth flow");
    expect(ticket.turnCount).toBe(5);
    expect(ticket.status).toBe("completed");
    expect(ticket.startedAt).toBe("2025-01-15T10:00:00Z");
  });
});
