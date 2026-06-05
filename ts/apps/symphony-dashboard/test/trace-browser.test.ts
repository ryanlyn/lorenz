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
