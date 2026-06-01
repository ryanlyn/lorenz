import { describe, it, expect } from "vitest";

import { computeStats } from "../src/stats.js";
import type { DisplayEvent } from "../src/models/display-events.js";

describe("computeStats", () => {
  it("returns empty stats for empty events", () => {
    const stats = computeStats([]);
    expect(stats.durationMs).toBe(0);
    expect(stats.totalEvents).toBe(0);
    expect(stats.totalTurns).toBe(0);
    expect(stats.tokenUsage.inputTokens).toBe(0);
    expect(stats.toolBreakdown).toEqual([]);
  });

  it("computes duration from first to last event", () => {
    const events: DisplayEvent[] = [
      { kind: "turn_started", turnIndex: 1, timestamp: "2026-01-01T00:00:00Z" },
      { kind: "message", text: "hello", timestamp: "2026-01-01T00:00:10Z" },
      { kind: "turn_completed", usage: null, durationMs: 10000, timestamp: "2026-01-01T00:00:10Z" },
    ];
    const stats = computeStats(events);
    expect(stats.durationMs).toBe(10000);
  });

  it("aggregates token usage across turn_completed events", () => {
    const events: DisplayEvent[] = [
      { kind: "turn_started", turnIndex: 1, timestamp: "2026-01-01T00:00:00Z" },
      {
        kind: "turn_completed",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        durationMs: 5000,
        timestamp: "2026-01-01T00:00:05Z",
      },
      { kind: "turn_started", turnIndex: 2, timestamp: "2026-01-01T00:00:06Z" },
      {
        kind: "turn_completed",
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
        durationMs: 4000,
        timestamp: "2026-01-01T00:00:10Z",
      },
    ];
    const stats = computeStats(events);
    expect(stats.totalTurns).toBe(2);
    expect(stats.tokenUsage.inputTokens).toBe(300);
    expect(stats.tokenUsage.outputTokens).toBe(150);
    expect(stats.tokenUsage.totalTokens).toBe(450);
  });

  it("computes tool breakdown by category", () => {
    const events: DisplayEvent[] = [
      {
        kind: "tool_call",
        category: "bash_command",
        toolName: "command_execution",
        input: {},
        output: null,
        isError: false,
        durationMs: 100,
        nestedEvents: [],
        timestamp: "2026-01-01T00:00:01Z",
      },
      {
        kind: "tool_call",
        category: "bash_command",
        toolName: "command_execution",
        input: {},
        output: null,
        isError: true,
        durationMs: 50,
        nestedEvents: [],
        timestamp: "2026-01-01T00:00:02Z",
      },
      {
        kind: "tool_call",
        category: "file_operation",
        toolName: "Read",
        input: {},
        output: null,
        isError: false,
        durationMs: 20,
        nestedEvents: [],
        timestamp: "2026-01-01T00:00:03Z",
      },
    ];
    const stats = computeStats(events);
    expect(stats.toolBreakdown.length).toBe(2);

    const bash = stats.toolBreakdown.find((t) => t.category === "bash_command");
    expect(bash).toBeDefined();
    expect(bash!.count).toBe(2);
    expect(bash!.errorCount).toBe(1);
    expect(bash!.totalDurationMs).toBe(150);

    const file = stats.toolBreakdown.find((t) => t.category === "file_operation");
    expect(file).toBeDefined();
    expect(file!.count).toBe(1);
    expect(file!.errorCount).toBe(0);
  });
});
