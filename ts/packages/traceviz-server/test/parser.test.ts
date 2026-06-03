import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { parseTraceLines } from "../src/parser.js";

const FIXTURE_PATH = path.join(import.meta.dirname, "fixtures/minimal-trace.jsonl");

describe("parseTraceLines with minimal fixture", () => {
  const lines = readFileSync(FIXTURE_PATH, "utf-8").split("\n");

  it("parses all meaningful event kinds", () => {
    const events = parseTraceLines(lines);
    const kinds = new Set(events.map((e) => e.kind));

    expect(kinds.has("turn_started")).toBe(true);
    expect(kinds.has("message")).toBe(true);
    expect(kinds.has("thought")).toBe(true);
    expect(kinds.has("tool_call")).toBe(true);
    expect(kinds.has("turn_completed")).toBe(true);
  });

  it("extracts message events with non-empty text", () => {
    const events = parseTraceLines(lines);
    const messages = events.filter((e) => e.kind === "message");
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((e) => e.kind === "message" && typeof e.text === "string")).toBe(true);
    expect(messages.some((e) => e.kind === "message" && e.text.length > 0)).toBe(true);
  });

  it("extracts thought events", () => {
    const events = parseTraceLines(lines);
    const thoughts = events.filter((e) => e.kind === "thought");
    expect(thoughts.length).toBeGreaterThan(0);
    expect(thoughts.every((e) => e.kind === "thought" && typeof e.text === "string")).toBe(true);
  });

  it("extracts bash tool_calls with expected shape", () => {
    const events = parseTraceLines(lines);
    const bashCalls = events.filter((e) => e.kind === "tool_call" && e.category === "bash_command");
    expect(bashCalls.length).toBeGreaterThan(0);

    for (const call of bashCalls) {
      if (call.kind !== "tool_call") continue;
      expect(call.toolName).toBe("Bash");
      expect(typeof (call.input as Record<string, unknown>).command).toBe("string");
      expect(typeof call.isError).toBe("boolean");
      expect(call.durationMs === null || typeof call.durationMs === "number").toBe(true);
    }
  });

  it("marks non-zero exit codes as errors", () => {
    const events = parseTraceLines(lines);
    const bashCalls = events.filter((e) => e.kind === "tool_call" && e.category === "bash_command");
    const errors = bashCalls.filter((e) => e.kind === "tool_call" && e.isError);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("extracts MCP/dynamic tool calls", () => {
    const events = parseTraceLines(lines);
    const mcpCalls = events.filter((e) => e.kind === "tool_call" && e.toolName !== "Bash");
    expect(mcpCalls.length).toBeGreaterThan(0);

    for (const call of mcpCalls) {
      if (call.kind !== "tool_call") continue;
      expect(typeof call.toolName).toBe("string");
      expect(typeof call.isError).toBe("boolean");
      expect(call.durationMs === null || typeof call.durationMs === "number").toBe(true);
    }
  });

  it("computes turn duration as a positive number", () => {
    const events = parseTraceLines(lines);
    const turnCompleted = events.find((e) => e.kind === "turn_completed");
    expect(turnCompleted).toBeDefined();
    if (turnCompleted?.kind === "turn_completed") {
      expect(typeof turnCompleted.durationMs).toBe("number");
      expect(turnCompleted.durationMs).toBeGreaterThan(0);
    }
  });

  it("extracts usage from turn_completed when present", () => {
    const events = parseTraceLines(lines);
    const turnCompleted = events.find((e) => e.kind === "turn_completed");
    expect(turnCompleted).toBeDefined();
    if (turnCompleted?.kind === "turn_completed" && turnCompleted.usage) {
      expect(typeof turnCompleted.usage.inputTokens).toBe("number");
      expect(typeof turnCompleted.usage.outputTokens).toBe("number");
      expect(typeof turnCompleted.usage.totalTokens).toBe("number");
    }
  });

  it("does not emit notification-kind events", () => {
    const events = parseTraceLines(lines);
    const notifications = events.filter((e) => e.kind === "notification");
    expect(notifications.length).toBe(0);
  });

  it("assigns sequential turn indices", () => {
    const events = parseTraceLines(lines);
    const turnStarted = events.filter((e) => e.kind === "turn_started");
    expect(turnStarted.length).toBeGreaterThan(0);
    for (let i = 0; i < turnStarted.length; i++) {
      const e = turnStarted[i]!;
      if (e.kind === "turn_started") {
        expect(e.turnIndex).toBe(i + 1);
      }
    }
  });

  it("all events have valid timestamps", () => {
    const events = parseTraceLines(lines);
    for (const event of events) {
      expect(typeof event.timestamp).toBe("string");
      expect(event.timestamp.length).toBeGreaterThan(0);
    }
  });
});

describe("parseTraceLines reasoning/thought extraction", () => {
  it("extracts thought text from agent_thought_chunk", () => {
    const lines = [
      JSON.stringify({
        type: "session_notification",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Thinking about the task" },
          },
        },
      }),
    ];
    const events = parseTraceLines(lines);
    const thoughts = events.filter((e) => e.kind === "thought");
    expect(thoughts.length).toBe(1);
    expect(thoughts[0]!.kind === "thought" && thoughts[0]!.text).toBe("Thinking about the task");
  });

  it("skips thought events with empty text", () => {
    const lines = [
      JSON.stringify({
        type: "session_notification",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          sessionId: "s1",
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "" } },
        },
      }),
    ];
    const events = parseTraceLines(lines);
    const thoughts = events.filter((e) => e.kind === "thought");
    expect(thoughts.length).toBe(0);
  });
});

describe("parseTraceLines turn handling", () => {
  it("emits turn_started with sequential indices", () => {
    const lines = [
      JSON.stringify({
        type: "turn_started",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:00Z",
        sessionId: "sess-1",
      }),
      JSON.stringify({
        type: "turn_completed",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:10Z",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    ];
    const events = parseTraceLines(lines);
    const turns = events.filter((e) => e.kind === "turn_started");
    expect(turns.length).toBe(1);
    expect(turns[0]!.kind === "turn_started" && turns[0]!.turnIndex).toBe(1);
  });
});

describe("parseTraceLines noise filtering", () => {
  it("does not emit unknown events for usage/session/workspace/stderr/process_exit", () => {
    const lines = [
      JSON.stringify({
        type: "workspace_prepared",
        message: "workspace prepared at /tmp/ws",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: null,
      }),
      JSON.stringify({
        type: "session_started",
        message: "session started",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: null,
      }),
      JSON.stringify({
        type: "stderr",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:00Z",
        message: "warn",
      }),
      JSON.stringify({
        type: "process_exit",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:02Z",
      }),
    ];
    const events = parseTraceLines(lines);
    expect(events.length).toBe(0);
  });

  it("still emits unknown for truly unrecognized event types", () => {
    const lines = [
      JSON.stringify({
        type: "some_new_type",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:00Z",
      }),
    ];
    const events = parseTraceLines(lines);
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("unknown");
  });
});
