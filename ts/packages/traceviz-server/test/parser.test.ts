import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { parseTraceLines } from "../src/parser.js";

const TRACE_PATH = `${process.env.HOME}/.symphony/traces/CAN-143/trace.jsonl`;

describe("parseTraceLines with CAN-143 trace", () => {
  const raw = readFileSync(TRACE_PATH, "utf-8");
  const allLines = raw.split("\n");
  const totalRawLines = allLines.filter((l) => l.trim()).length;

  // Simulate the emitter filter: only keep non-notification lines
  // plus notifications with allowlisted methods
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

  it("dramatically reduces trace size", () => {
    // Raw trace has >10k lines, filtered should be ~130
    expect(totalRawLines).toBeGreaterThan(10000);
    expect(filteredLines.length).toBeLessThan(200);
    expect(filteredLines.length).toBeGreaterThan(50);
  });

  it("parses filtered lines into meaningful display events", () => {
    const events = parseTraceLines(filteredLines);
    expect(events.length).toBeGreaterThan(0);

    const kinds = new Set(events.map((e) => e.kind));
    // Should produce tool_calls from commandExecution and dynamicToolCall items
    expect(kinds.has("tool_call")).toBe(true);
    // Should produce messages from agentMessage items
    expect(kinds.has("message")).toBe(true);
    // Should produce thoughts from reasoning items
    expect(kinds.has("thought")).toBe(true);
    // Should produce turn boundaries
    expect(kinds.has("turn_started")).toBe(true);
  });

  it("extracts command executions with output", () => {
    const events = parseTraceLines(filteredLines);
    const toolCalls = events.filter((e) => e.kind === "tool_call");
    const bashCalls = toolCalls.filter(
      (e) => e.kind === "tool_call" && e.category === "bash_command",
    );

    expect(bashCalls.length).toBeGreaterThan(0);
    // At least some should have output
    const withOutput = bashCalls.filter(
      (e) => e.kind === "tool_call" && e.output !== null && e.output !== "",
    );
    expect(withOutput.length).toBeGreaterThan(0);
  });

  it("extracts dynamic tool calls (MCP)", () => {
    const events = parseTraceLines(filteredLines);
    const toolCalls = events.filter(
      (e) => e.kind === "tool_call" && e.toolName !== "command_execution",
    );
    // CAN-143 trace has dynamicToolCall items (linear_graphql)
    expect(toolCalls.length).toBeGreaterThan(0);
  });

  it("has no streaming delta noise in output", () => {
    const events = parseTraceLines(filteredLines);
    // No notification-kind events should remain (they're all parsed into specific kinds)
    const notifications = events.filter((e) => e.kind === "notification");
    expect(notifications.length).toBe(0);
  });

  it("preserves agent message text content", () => {
    const events = parseTraceLines(filteredLines);
    const messages = events.filter((e) => e.kind === "message");
    // At least one message should have real text
    const withText = messages.filter((e) => e.kind === "message" && e.text.length > 10);
    expect(withText.length).toBeGreaterThan(0);
  });
});
