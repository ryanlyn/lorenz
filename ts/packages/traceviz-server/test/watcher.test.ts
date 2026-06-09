import { mkdirSync, appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { TraceWatcher } from "../src/watcher.js";
import type { TicketInfo } from "../src/models/api.js";

function makeTraceDir(): string {
  const dir = path.join(
    tmpdir(),
    `traceviz-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTraceLine(traceDir: string, issueId: string, line: Record<string, unknown>): void {
  const issueDir = path.join(traceDir, issueId);
  mkdirSync(issueDir, { recursive: true });
  appendFileSync(path.join(issueDir, "trace.jsonl"), JSON.stringify(line) + "\n");
}

describe("TraceWatcher", () => {
  let traceDir: string;
  let watcher: TraceWatcher;

  beforeEach(() => {
    traceDir = makeTraceDir();
    watcher = new TraceWatcher(traceDir, 50);
  });

  afterEach(() => {
    watcher.stop();
    rmSync(traceDir, { recursive: true, force: true });
  });

  it("detects new trace files and calls back with ticket info", async () => {
    const callbacks: Array<{ issueId: string; ticket: TicketInfo }> = [];

    writeTraceLine(traceDir, "TEST-1", {
      type: "turn_started",
      issueId: "id-1",
      issueIdentifier: "TEST-1",
      timestamp: "2026-01-01T00:00:00Z",
    });
    writeTraceLine(traceDir, "TEST-1", {
      type: "session_notification",
      issueId: "id-1",
      issueIdentifier: "TEST-1",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } },
      },
    });

    watcher.start((issueId, ticket) => {
      callbacks.push({ issueId, ticket });
    });

    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    expect(callbacks.length).toBeGreaterThan(0);
    const first = callbacks[0]!;
    expect(first).toMatchObject({
      issueId: "id-1",
      ticket: {
        issueId: "id-1",
        identifier: "TEST-1",
        status: "running",
        turnCount: 1,
      },
    });
    expect(watcher.getEventsForTicket("id-1").some((e) => e.kind === "message")).toBe(true);
  });

  it("only calls back when new lines are appended", async () => {
    const callbacks: Array<{ issueId: string; ticket: TicketInfo }> = [];

    writeTraceLine(traceDir, "TEST-2", {
      type: "turn_started",
      issueId: "id-2",
      issueIdentifier: "TEST-2",
      timestamp: "2026-01-01T00:00:00Z",
    });

    watcher.start((issueId, ticket) => {
      callbacks.push({ issueId, ticket });
    });

    await new Promise((r) => setTimeout(r, 150));
    const countAfterFirst = callbacks.length;
    expect(countAfterFirst).toBeGreaterThan(0);

    // Wait another poll cycle without changes — no new callback
    await new Promise((r) => setTimeout(r, 150));
    expect(callbacks.length).toBe(countAfterFirst);

    // Now append a new line
    writeTraceLine(traceDir, "TEST-2", {
      type: "session_notification",
      issueId: "id-2",
      issueIdentifier: "TEST-2",
      timestamp: "2026-01-01T00:00:05Z",
      message: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Update" } },
      },
    });

    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    expect(callbacks.length).toBeGreaterThan(countAfterFirst);
    const latest = callbacks[callbacks.length - 1]!;
    expect(latest).toMatchObject({
      issueId: "id-2",
      ticket: {
        issueId: "id-2",
        identifier: "TEST-2",
        status: "running",
        turnCount: 1,
      },
    });
    expect(watcher.getEventsForTicket("id-2").some((e) => e.kind === "message")).toBe(true);
  });

  it("updates ticket info when new lines are appended", async () => {
    const callbacks: Array<{ issueId: string; ticket: TicketInfo }> = [];

    writeTraceLine(traceDir, "TEST-3", {
      type: "turn_started",
      issueId: "id-3",
      issueIdentifier: "TEST-3",
      timestamp: "2026-01-01T00:00:00Z",
    });

    watcher.start((issueId, ticket) => {
      callbacks.push({ issueId, ticket });
    });

    await new Promise((r) => setTimeout(r, 150));

    writeTraceLine(traceDir, "TEST-3", {
      type: "session_notification",
      issueId: "id-3",
      issueIdentifier: "TEST-3",
      timestamp: "2026-01-01T00:00:05Z",
      message: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Msg" } },
      },
    });

    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    const latest = callbacks[callbacks.length - 1]!;
    expect(latest).toMatchObject({
      issueId: "id-3",
      ticket: {
        issueId: "id-3",
        identifier: "TEST-3",
        status: "running",
        turnCount: 1,
      },
    });
    const events = watcher.getEventsForTicket("id-3");
    expect(events.some((e) => e.kind === "turn_started")).toBe(true);
    expect(events.some((e) => e.kind === "message")).toBe(true);
  });

  it("notifies with compact ticket info while preserving lazy event reads", async () => {
    const callbacks: Array<{ issueId: string; ticket: unknown }> = [];

    writeTraceLine(traceDir, "TEST-5", {
      type: "turn_started",
      issueId: "id-5",
      issueIdentifier: "TEST-5",
      timestamp: "2026-01-01T00:00:00Z",
    });
    writeTraceLine(traceDir, "TEST-5", {
      type: "session_notification",
      issueId: "id-5",
      issueIdentifier: "TEST-5",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Test" } },
      },
    });

    watcher.start((issueId, ticket) => {
      callbacks.push({ issueId, ticket });
    });

    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    expect(callbacks.length).toBeGreaterThan(0);
    const first = callbacks[0]!;
    expect(first.issueId).toBe("id-5");
    expect(Array.isArray(first.ticket)).toBe(false);
    expect(first.ticket).toMatchObject({
      issueId: "id-5",
      identifier: "TEST-5",
      status: "running",
      turnCount: 1,
      startedAt: "2026-01-01T00:00:00Z",
    });

    const events = watcher.getEventsForTicket("id-5");
    expect(events.some((e) => e.kind === "message")).toBe(true);
  });

  it("getEventsForTicket returns current events", async () => {
    writeTraceLine(traceDir, "TEST-4", {
      type: "turn_started",
      issueId: "id-4",
      issueIdentifier: "TEST-4",
      timestamp: "2026-01-01T00:00:00Z",
    });
    writeTraceLine(traceDir, "TEST-4", {
      type: "session_notification",
      issueId: "id-4",
      issueIdentifier: "TEST-4",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Test" } },
      },
    });

    watcher.start(() => {});
    await new Promise((r) => setTimeout(r, 150));

    const events = watcher.getEventsForTicket("id-4");
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === "message")).toBe(true);

    watcher.stop();
  });
});
