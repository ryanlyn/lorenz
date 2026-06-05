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
    const bashCalls = events.filter((e) => e.kind === "tool_call" && e.toolName === "Bash");
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
    const bashCalls = events.filter((e) => e.kind === "tool_call" && e.toolName === "Bash");
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

describe("parseTraceLines chunk combining", () => {
  function makeChunk(
    sessionUpdate: "agent_thought_chunk" | "agent_message_chunk" | "user_message_chunk",
    text: string,
    timestamp = "2026-01-01T00:00:00Z",
  ): string {
    return JSON.stringify({
      type: "session_notification",
      issueId: "id",
      issueIdentifier: "T-1",
      timestamp,
      message: {
        sessionId: "s1",
        update: { sessionUpdate, content: { type: "text", text } },
      },
    });
  }

  it("combines consecutive thought chunks into a single event", () => {
    const lines = [
      makeChunk("agent_thought_chunk", "The user is asking "),
      makeChunk("agent_thought_chunk", "which model "),
      makeChunk("agent_thought_chunk", "I'm running on."),
    ];
    const events = parseTraceLines(lines);
    const thoughts = events.filter((e) => e.kind === "thought");
    expect(thoughts.length).toBe(1);
    expect(thoughts[0]!.kind === "thought" && thoughts[0]!.text).toBe(
      "The user is asking which model I'm running on.",
    );
  });

  it("combines consecutive message chunks into a single event", () => {
    const lines = [
      makeChunk("agent_message_chunk", "I am "),
      makeChunk("agent_message_chunk", "Claude, made by "),
      makeChunk("agent_message_chunk", "Anthropic."),
    ];
    const events = parseTraceLines(lines);
    const messages = events.filter((e) => e.kind === "message");
    expect(messages.length).toBe(1);
    expect(messages[0]!.kind === "message" && messages[0]!.text).toBe(
      "I am Claude, made by Anthropic.",
    );
  });

  it("combines user_message_chunk into message kind", () => {
    const lines = [
      makeChunk("user_message_chunk", "Hello "),
      makeChunk("user_message_chunk", "world"),
    ];
    const events = parseTraceLines(lines);
    const messages = events.filter((e) => e.kind === "message");
    expect(messages.length).toBe(1);
    expect(messages[0]!.kind === "message" && messages[0]!.text).toBe("Hello world");
  });

  it("flushes thought before starting a new message sequence", () => {
    const lines = [
      makeChunk("agent_thought_chunk", "thinking part 1"),
      makeChunk("agent_thought_chunk", " part 2"),
      makeChunk("agent_message_chunk", "response part 1"),
      makeChunk("agent_message_chunk", " part 2"),
    ];
    const events = parseTraceLines(lines);
    const thoughts = events.filter((e) => e.kind === "thought");
    const messages = events.filter((e) => e.kind === "message");
    expect(thoughts.length).toBe(1);
    expect(messages.length).toBe(1);
    expect(thoughts[0]!.kind === "thought" && thoughts[0]!.text).toBe("thinking part 1 part 2");
    expect(messages[0]!.kind === "message" && messages[0]!.text).toBe("response part 1 part 2");
  });

  it("flushes pending text before a tool_call", () => {
    const lines = [
      makeChunk("agent_message_chunk", "Let me check."),
      JSON.stringify({
        type: "session_notification",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call",
            title: "Bash",
            toolCallId: "tc1",
            rawInput: { command: "ls" },
          },
        },
      }),
      JSON.stringify({
        type: "session_notification",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:02Z",
        message: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc1",
            status: "completed",
            rawOutput: "file.txt",
          },
        },
      }),
      makeChunk("agent_message_chunk", "Done.", "2026-01-01T00:00:03Z"),
    ];
    const events = parseTraceLines(lines);
    expect(events[0]).toMatchObject({ kind: "message", text: "Let me check." });
    expect(events[1]).toMatchObject({ kind: "tool_call", toolName: "Bash" });
    expect(events[2]).toMatchObject({ kind: "message", text: "Done." });
  });

  it("skips malformed tool calls without toolCallId", () => {
    const makeToolCall = (title: string, timestamp: string): string =>
      JSON.stringify({
        type: "session_notification",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp,
        message: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call",
            title,
            rawInput: { command: title },
          },
        },
      });

    const events = parseTraceLines([
      makeToolCall("First", "2026-01-01T00:00:00Z"),
      makeToolCall("Second", "2026-01-01T00:00:01Z"),
    ]);

    expect(events.filter((event) => event.kind === "tool_call")).toHaveLength(0);
  });

  it("flushes pending text before turn_started", () => {
    const lines = [
      makeChunk("agent_message_chunk", "end of turn"),
      JSON.stringify({
        type: "turn_started",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:01Z",
        sessionId: "sess-1",
      }),
    ];
    const events = parseTraceLines(lines);
    expect(events[0]).toMatchObject({ kind: "message", text: "end of turn" });
    expect(events[1]).toMatchObject({ kind: "turn_started" });
  });

  it("uses the timestamp of the first chunk in a combined event", () => {
    const lines = [
      makeChunk("agent_thought_chunk", "first", "2026-01-01T00:00:01Z"),
      makeChunk("agent_thought_chunk", " second", "2026-01-01T00:00:02Z"),
      makeChunk("agent_thought_chunk", " third", "2026-01-01T00:00:03Z"),
    ];
    const events = parseTraceLines(lines);
    expect(events.length).toBe(1);
    expect(events[0]!.timestamp).toBe("2026-01-01T00:00:01Z");
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

  it("renders turn_cancelled without serializing the PromptResponse", () => {
    const lines = [
      JSON.stringify({
        type: "turn_cancelled",
        issueId: "id",
        issueIdentifier: "T-1",
        timestamp: "2026-01-01T00:00:00Z",
        message: {
          response: {
            stopReason: "cancelled",
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            output: [{ type: "text", text: "serialized-response-marker" }],
          },
        },
      }),
    ];
    const events = parseTraceLines(lines);
    const turnFailed = events.find((e) => e.kind === "turn_failed");

    expect(turnFailed).toMatchObject({
      kind: "turn_failed",
      text: "Turn cancelled: cancelled",
    });
    expect(turnFailed?.kind === "turn_failed" && turnFailed.text).not.toContain(
      "serialized-response-marker",
    );
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
