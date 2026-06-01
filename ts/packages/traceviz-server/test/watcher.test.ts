import { mkdirSync, appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { TraceWatcher } from "../src/watcher.js";
import type { DisplayEvent } from "../src/models/display-events.js";

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

  it("detects new trace files and calls back with events", async () => {
    const callbacks: Array<{ issueId: string; events: DisplayEvent[] }> = [];

    writeTraceLine(traceDir, "TEST-1", {
      type: "turn_started",
      issueId: "id-1",
      issueIdentifier: "TEST-1",
      timestamp: "2026-01-01T00:00:00Z",
    });
    writeTraceLine(traceDir, "TEST-1", {
      type: "notification",
      issueId: "id-1",
      issueIdentifier: "TEST-1",
      timestamp: "2026-01-01T00:00:01Z",
      message: { method: "item/completed", params: { item: { type: "agentMessage", text: "Hi" } } },
    });

    watcher.start((issueId, events) => {
      callbacks.push({ issueId, events: [...events] });
    });

    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    expect(callbacks.length).toBeGreaterThan(0);
    const first = callbacks[0]!;
    expect(first.events.some((e) => e.kind === "message")).toBe(true);
  });

  it("only calls back when new lines are appended", async () => {
    const callbacks: Array<{ issueId: string; events: DisplayEvent[] }> = [];

    writeTraceLine(traceDir, "TEST-2", {
      type: "turn_started",
      issueId: "id-2",
      issueIdentifier: "TEST-2",
      timestamp: "2026-01-01T00:00:00Z",
    });

    watcher.start((issueId, events) => {
      callbacks.push({ issueId, events: [...events] });
    });

    await new Promise((r) => setTimeout(r, 150));
    const countAfterFirst = callbacks.length;
    expect(countAfterFirst).toBeGreaterThan(0);

    // Wait another poll cycle without changes — no new callback
    await new Promise((r) => setTimeout(r, 150));
    expect(callbacks.length).toBe(countAfterFirst);

    // Now append a new line
    writeTraceLine(traceDir, "TEST-2", {
      type: "notification",
      issueId: "id-2",
      issueIdentifier: "TEST-2",
      timestamp: "2026-01-01T00:00:05Z",
      message: {
        method: "item/completed",
        params: { item: { type: "agentMessage", text: "Update" } },
      },
    });

    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    expect(callbacks.length).toBeGreaterThan(countAfterFirst);
    const latest = callbacks[callbacks.length - 1]!;
    expect(latest.events.length).toBeGreaterThan(callbacks[0]!.events.length);
  });

  it("provides full event list on each callback (not just delta)", async () => {
    const callbacks: Array<{ issueId: string; events: DisplayEvent[] }> = [];

    writeTraceLine(traceDir, "TEST-3", {
      type: "turn_started",
      issueId: "id-3",
      issueIdentifier: "TEST-3",
      timestamp: "2026-01-01T00:00:00Z",
    });

    watcher.start((issueId, events) => {
      callbacks.push({ issueId, events: [...events] });
    });

    await new Promise((r) => setTimeout(r, 150));

    writeTraceLine(traceDir, "TEST-3", {
      type: "notification",
      issueId: "id-3",
      issueIdentifier: "TEST-3",
      timestamp: "2026-01-01T00:00:05Z",
      message: {
        method: "item/completed",
        params: { item: { type: "agentMessage", text: "Msg" } },
      },
    });

    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    // Latest callback should have ALL events, not just the new one
    const latest = callbacks[callbacks.length - 1]!;
    expect(latest.events.some((e) => e.kind === "turn_started")).toBe(true);
    expect(latest.events.some((e) => e.kind === "message")).toBe(true);
  });

  it("getEventsForTicket returns current events", async () => {
    writeTraceLine(traceDir, "TEST-4", {
      type: "turn_started",
      issueId: "id-4",
      issueIdentifier: "TEST-4",
      timestamp: "2026-01-01T00:00:00Z",
    });
    writeTraceLine(traceDir, "TEST-4", {
      type: "notification",
      issueId: "id-4",
      issueIdentifier: "TEST-4",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        method: "item/completed",
        params: { item: { type: "agentMessage", text: "Test" } },
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
