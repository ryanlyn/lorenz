import type { DisplayEvent, TicketInfo } from "@lorenz/traceviz-server";
import { describe, expect, it } from "vitest";

import {
  createFixedTraceDataSource,
  createLiveTraceDataSource,
  createTraceTicketRoutes,
  type TraceDataSource,
} from "../src/trace-routes.js";

const issueId = "test-id";
const identifier = "TEST-1";
const event: DisplayEvent = {
  kind: "turn_started",
  timestamp: "2026-01-01T00:00:00Z",
  turnIndex: 0,
};
const ticket: TicketInfo = {
  issueId,
  identifier,
  startedAt: event.timestamp,
  status: "completed",
  turnCount: 1,
};

function liveSource(): TraceDataSource {
  const watcher: Parameters<typeof createLiveTraceDataSource>[0] = {
    getEventsForTicket: (requestedIssueId) => (requestedIssueId === issueId ? [event] : []),
    getTicketInfo: (requestedIssueId) => (requestedIssueId === issueId ? ticket : undefined),
    getTickets: () => [ticket],
  };
  const issue = {
    issueId,
    issueIdentifier: identifier,
    title: "Shared trace routes",
    url: "https://linear.app/mono-dev/issue/TEST-1",
  };
  const issueStore: Parameters<typeof createLiveTraceDataSource>[1] = {
    get: (requestedIssueId) => (requestedIssueId === issueId ? issue : undefined),
    getMany: (issueIds) => new Map(issueIds.includes(issueId) ? [[issueId, issue]] : []),
  };
  return createLiveTraceDataSource(watcher, issueStore);
}

function fixedSource(): TraceDataSource {
  return createFixedTraceDataSource({ events: [event], identifier, issueId }, 1);
}

function traceTicketRouteContract(name: string, createSource: () => TraceDataSource): void {
  describe(name, () => {
    it("lists the source ticket", async () => {
      const response = await createTraceTicketRoutes(createSource()).request("/api/v1/tickets");

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        tickets: [{ issueId, identifier, turnCount: 1 }],
      });
    });

    it("returns the source trace for raw and encoded ticket ids", async () => {
      const app = createTraceTicketRoutes(createSource());

      for (const pathId of [issueId, "test%2Did"]) {
        const response = await app.request(`/api/v1/tickets/${pathId}/events`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ issueId, identifier, events: [event] });
      }
    });

    it("returns 404 for a ticket outside the source", async () => {
      const response = await createTraceTicketRoutes(createSource()).request(
        "/api/v1/tickets/missing/events",
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Ticket not found" });
    });

    it("returns a structured 400 for malformed ticket ids", async () => {
      const response = await createTraceTicketRoutes(createSource()).request(
        "/api/v1/tickets/%E0%A4%A/events",
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "invalid_path_parameter",
          message: "Malformed percent encoding in path parameter",
        },
      });
    });
  });
}

traceTicketRouteContract("live trace source route contract", liveSource);
traceTicketRouteContract("fixed trace source route contract", fixedSource);

describe("trace data source metadata", () => {
  it("enriches live ticket metadata from the issue store", () => {
    expect(liveSource().getTickets()).toEqual([
      {
        ...ticket,
        title: "Shared trace routes",
        url: "https://linear.app/mono-dev/issue/TEST-1",
      },
    ]);
  });

  it("keeps the fixed source to its single loaded snapshot", () => {
    const source = fixedSource();

    expect(source.getTickets()).toEqual([ticket]);
    expect(source.getTicketTrace("missing")).toBeNull();
  });
});
