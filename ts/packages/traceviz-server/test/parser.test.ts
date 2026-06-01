import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { parseTraceLines } from "../src/parser.js";

const FIXTURE_PATH = path.join(import.meta.dirname, "fixtures/minimal-trace.jsonl");
const CAN143_PATH = `${process.env.HOME}/.symphony/traces/CAN-143/trace.jsonl`;

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
      expect(call.toolName).toBe("command_execution");
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
    const mcpCalls = events.filter(
      (e) => e.kind === "tool_call" && e.toolName !== "command_execution",
    );
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
  it("extracts text from summary array", () => {
    const lines = [
      JSON.stringify({
        type: "notification",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          method: "item/completed",
          params: {
            item: {
              type: "reasoning",
              id: "rs_1",
              summary: [{ type: "summary_text", text: "Thinking about the task" }],
              content: [],
            },
          },
        },
      }),
    ];
    const events = parseTraceLines(lines);
    const thoughts = events.filter((e) => e.kind === "thought");
    expect(thoughts.length).toBe(1);
    expect(thoughts[0]!.kind === "thought" && thoughts[0]!.text).toBe("Thinking about the task");
  });

  it("extracts text from content array when summary is empty", () => {
    const lines = [
      JSON.stringify({
        type: "notification",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          method: "item/completed",
          params: {
            item: {
              type: "reasoning",
              id: "rs_1",
              summary: [],
              content: [{ type: "thinking", text: "Deep thought" }],
            },
          },
        },
      }),
    ];
    const events = parseTraceLines(lines);
    const thoughts = events.filter((e) => e.kind === "thought");
    expect(thoughts.length).toBe(1);
    expect(thoughts[0]!.kind === "thought" && thoughts[0]!.text).toBe("Deep thought");
  });

  it("skips empty reasoning items entirely", () => {
    const lines = [
      JSON.stringify({
        type: "notification",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          method: "item/completed",
          params: {
            item: { type: "reasoning", id: "rs_1", summary: [], content: [] },
          },
        },
      }),
    ];
    const events = parseTraceLines(lines);
    const thoughts = events.filter((e) => e.kind === "thought");
    expect(thoughts.length).toBe(0);
  });

  it("prefers item.text over summary/content", () => {
    const lines = [
      JSON.stringify({
        type: "notification",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          method: "item/completed",
          params: {
            item: {
              type: "reasoning",
              id: "rs_1",
              text: "Direct text",
              summary: [{ text: "Summary text" }],
              content: [{ text: "Content text" }],
            },
          },
        },
      }),
    ];
    const events = parseTraceLines(lines);
    const thoughts = events.filter((e) => e.kind === "thought");
    expect(thoughts.length).toBe(1);
    expect(thoughts[0]!.kind === "thought" && thoughts[0]!.text).toBe("Direct text");
  });
});

describe("parseTraceLines turn deduplication", () => {
  it("deduplicates raw turn_started + notification turn/started", () => {
    const lines = [
      JSON.stringify({
        type: "turn_started",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: null,
        sessionId: "sess-1",
      }),
      JSON.stringify({
        type: "notification",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          method: "turn/started",
          params: { threadId: "t1", turn: { id: "turn-1", status: "inProgress" } },
        },
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
    // Should use the notification timestamp (not null)
    expect(turns[0]!.timestamp).toBe("2026-01-01T00:00:01Z");
  });

  it("emits separate turns when notification is not immediately after raw", () => {
    const lines = [
      JSON.stringify({
        type: "turn_started",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:00Z",
      }),
      JSON.stringify({
        type: "notification",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          method: "item/completed",
          params: { item: { type: "agentMessage", text: "Hello" } },
        },
      }),
      JSON.stringify({
        type: "notification",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:02Z",
        message: {
          method: "turn/started",
          params: { threadId: "t1", turn: { id: "turn-2", status: "inProgress" } },
        },
      }),
    ];
    const events = parseTraceLines(lines);
    const turns = events.filter((e) => e.kind === "turn_started");
    expect(turns.length).toBe(2);
  });
});

describe("parseTraceLines Codex tool_call format", () => {
  it("parses tool_call_completed with request/result structure", () => {
    const lines = [
      JSON.stringify({
        type: "tool_call_completed",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:05Z",
        message: {
          request: {
            method: "item/tool/call",
            id: 0,
            params: {
              threadId: "t1",
              turnId: "turn-1",
              callId: "call_abc",
              tool: "linear_graphql",
              arguments: { query: "{ viewer { id } }" },
            },
          },
          result: {
            success: true,
            output: '{"data":{"viewer":{"id":"123"}}}',
            contentItems: [{ type: "inputText", text: '{"data":{"viewer":{"id":"123"}}}' }],
          },
        },
      }),
    ];
    const events = parseTraceLines(lines);
    const tools = events.filter((e) => e.kind === "tool_call");
    expect(tools.length).toBe(1);
    const tool = tools[0]!;
    expect(tool.kind === "tool_call" && tool.toolName).toBe("linear_graphql");
    expect(tool.kind === "tool_call" && tool.isError).toBe(false);
    expect(tool.kind === "tool_call" && tool.output).toBe('{"data":{"viewer":{"id":"123"}}}');
    expect(tool.kind === "tool_call" && (tool.input as Record<string, unknown>).query).toBe(
      "{ viewer { id } }",
    );
  });

  it("parses tool_call_failed with request/result structure", () => {
    const lines = [
      JSON.stringify({
        type: "tool_call_failed",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:05Z",
        message: {
          request: {
            method: "item/tool/call",
            id: 1,
            params: {
              threadId: "t1",
              turnId: "turn-1",
              callId: "call_def",
              tool: "web_search",
              arguments: { q: "test" },
            },
          },
          result: { success: false, output: "Rate limited" },
        },
      }),
    ];
    const events = parseTraceLines(lines);
    const tools = events.filter((e) => e.kind === "tool_call");
    expect(tools.length).toBe(1);
    const tool = tools[0]!;
    expect(tool.kind === "tool_call" && tool.toolName).toBe("web_search");
    expect(tool.kind === "tool_call" && tool.isError).toBe(true);
  });
});

describe("parseTraceLines noise filtering", () => {
  it("does not emit unknown events for usage/session/workspace/stderr/process_exit", () => {
    const lines = [
      JSON.stringify({
        type: "workspace_prepared",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: null,
      }),
      JSON.stringify({
        type: "session_started",
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
        type: "usage",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:01Z",
        usage: { inputTokens: 100, outputTokens: 50 },
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

describe("parseTraceLines with full trace (integration)", () => {
  const shouldRun = existsSync(CAN143_PATH);

  it.skipIf(!shouldRun)("filters noise and produces only meaningful events", () => {
    const raw = readFileSync(CAN143_PATH, "utf-8");
    const allLines = raw.split("\n");
    const totalRawLines = allLines.filter((l) => l.trim()).length;

    const ALLOWLIST = new Set(["item/completed", "turn/started", "turn/completed"]);
    const filteredLines = allLines.filter((l) => {
      const trimmed = l.trim();
      if (!trimmed) return false;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (obj.type !== "notification") return true;
        const msg = obj.message as Record<string, unknown> | null;
        if (!msg || typeof msg.method !== "string") return false;
        return ALLOWLIST.has(msg.method);
      } catch {
        return false;
      }
    });

    // Should dramatically reduce line count
    expect(filteredLines.length).toBeLessThan(totalRawLines / 10);
    expect(filteredLines.length).toBeGreaterThan(0);

    const events = parseTraceLines(filteredLines);
    const kinds = new Set(events.map((e) => e.kind));

    expect(kinds.has("tool_call")).toBe(true);
    expect(kinds.has("message")).toBe(true);
    expect(kinds.has("turn_started")).toBe(true);

    // No notification noise leaks through
    expect(events.filter((e) => e.kind === "notification").length).toBe(0);
  });
});
