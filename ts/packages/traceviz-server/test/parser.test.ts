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
    const bashCalls = events.filter(
      (e) => e.kind === "tool_call" && e.category === "bash_command",
    );
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
    const bashCalls = events.filter(
      (e) => e.kind === "tool_call" && e.category === "bash_command",
    );
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
    expect(kinds.has("thought")).toBe(true);
    expect(kinds.has("turn_started")).toBe(true);

    // No notification noise leaks through
    expect(events.filter((e) => e.kind === "notification").length).toBe(0);
  });
});
