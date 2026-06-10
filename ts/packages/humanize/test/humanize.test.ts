import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import {
  humanizeAgentMessage,
  humanizeCodexMessage,
  humanizeClaudeMessage,
} from "@symphony/humanize";

// --- humanizeAgentMessage ---

test("humanizeAgentMessage — dispatches to Claude humanizer for claude messages", () => {
  const msg = {
    agent_kind: "claude",
    event: "turn_started",
    message: { type: "turn_started" },
  };
  assert.equal(humanizeAgentMessage(msg), "claude turn started");
});

test("humanizeAgentMessage — dispatches to Codex humanizer for codex messages", () => {
  const msg = {
    event: "turn_completed",
    message: { method: "turn/completed", params: { turn: { status: "completed" } } },
  };
  assert.equal(humanizeAgentMessage(msg), "turn completed");
});

test("humanizeAgentMessage — dispatches to Claude humanizer for messages with nested message.type", () => {
  const msg = {
    message: {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello world" }] },
    },
  };
  assert.equal(humanizeAgentMessage(msg), "hello world");
});

test("humanizeAgentMessage — returns raw string for unknown shape", () => {
  assert.equal(humanizeAgentMessage("raw string value"), "raw string value");
});

test("humanizeAgentMessage — returns fallback for null", () => {
  assert.equal(humanizeAgentMessage(null), "no agent message yet");
});

test("humanizeAgentMessage — returns fallback for undefined", () => {
  assert.equal(humanizeAgentMessage(undefined), "no agent message yet");
});

// --- humanizeCodexMessage ---

test("humanizeCodexMessage — formats session_started event with session id", () => {
  const msg = {
    event: "session_started",
    message: { session_id: "sess-abc123" },
  };
  assert.equal(humanizeCodexMessage(msg), "session started (sess-abc123)");
});

test("humanizeCodexMessage — formats approval_auto_approved events", () => {
  const msg = {
    event: "approval_auto_approved",
    message: { method: "item/commandExecution/requestApproval", params: { command: "ls -la" } },
    decision: "safe",
  };
  assert.equal(
    humanizeCodexMessage(msg),
    "command approval requested (ls -la) (auto-approved): safe",
  );
});

test("humanizeCodexMessage — formats item/started lifecycle", () => {
  const msg = {
    event: "item_lifecycle",
    message: { method: "item/started", params: { item: { type: "message" } } },
  };
  assert.equal(humanizeCodexMessage(msg), "item started (message)");
});

test("humanizeCodexMessage — formats item/completed lifecycle", () => {
  const msg = {
    event: "item_lifecycle",
    message: { method: "item/completed", params: { item: { type: "function_call" } } },
  };
  assert.equal(humanizeCodexMessage(msg), "item completed (function_call)");
});

test("humanizeCodexMessage — formats streaming token events", () => {
  const msg = {
    event: "streaming",
    message: {
      method: "item/agentMessage/delta",
      params: { delta: "partial token" },
    },
  };
  assert.equal(humanizeCodexMessage(msg), "agent message streaming: partial token");
});

test("humanizeCodexMessage — formats dynamic_tool_call with tool name extraction via item/tool/call", () => {
  const msg = {
    event: "dynamic_tool_call",
    message: { method: "item/tool/call", params: { tool: "bash" } },
  };
  assert.equal(humanizeCodexMessage(msg), "dynamic tool call requested (bash)");
});

test("humanizeCodexMessage — formats tool_call_update completed event (dynamic_tool_result success)", () => {
  const msg = {
    event: "tool_call_update",
    message: { status: "completed", params: { tool: "file_write" } },
  };
  assert.equal(humanizeCodexMessage(msg), "dynamic tool call completed (file_write)");
});

test("humanizeCodexMessage — formats tool_call_update failed event (dynamic_tool_result failure)", () => {
  const msg = {
    event: "tool_call_update",
    message: { status: "failed", params: { name: "web_search" } },
  };
  assert.equal(humanizeCodexMessage(msg), "dynamic tool call failed (web_search)");
});

test("humanizeCodexMessage — formats usage/token count summaries via turn/completed", () => {
  const msg = {
    event: "turn_completed_event",
    message: {
      method: "turn/completed",
      params: {
        turn: { status: "completed" },
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
    },
  };
  assert.equal(humanizeCodexMessage(msg), "turn completed (completed) (in 100 out 50 total 150)");
});

test("humanizeCodexMessage — truncates long payloads to max length via humanizeAgentMessage", () => {
  const longText = "a".repeat(200);
  const msg = { event: "text", message: longText };
  const result = humanizeAgentMessage(msg);
  assert.equal(result.length, 140);
  assert.match(result, /\.\.\.$/);
});

test("humanizeCodexMessage — strips newlines from inline text", () => {
  const msg = {
    event: "streaming",
    message: {
      method: "item/agentMessage/delta",
      params: { delta: "line one\nline two\nline three" },
    },
  };
  assert.equal(humanizeCodexMessage(msg), "agent message streaming: line one line two line three");
});

test("humanizeCodexMessage — handles null message gracefully", () => {
  assert.equal(humanizeCodexMessage(null), "no codex message yet");
});

test("humanizeCodexMessage — handles undefined message gracefully", () => {
  assert.equal(humanizeCodexMessage(undefined), "no codex message yet");
});

test("humanizeCodexMessage — handles malformed payload with missing fields", () => {
  const msg = { event: "unknown_event_xyz", message: {} };
  // Falls through humanizeCodexEvent (returns null) to humanizeCodexPayload
  assert.equal(humanizeCodexMessage(msg), "{}");
});

// --- humanizeClaudeMessage ---

test("humanizeClaudeMessage — formats tool_use request with tool name", () => {
  const msg = {
    message: {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read" }] },
    },
  };
  assert.equal(humanizeClaudeMessage(msg), "tool requested (Read)");
});

test("humanizeClaudeMessage — formats rate_limit event with retry info", () => {
  const msg = {
    message: {
      type: "rate_limit_event",
      rate_limit_info: { status: "retry_after_5s" },
    },
  };
  assert.equal(humanizeClaudeMessage(msg), "rate limit status: retry_after_5s");
});

test("humanizeClaudeMessage — returns rate limit update when status is missing", () => {
  const msg = {
    message: {
      type: "rate_limit_event",
      rate_limit_info: { count: 3 },
    },
  };
  assert.equal(humanizeClaudeMessage(msg), "rate limit update");
});

test("humanizeClaudeMessage — returns null for unrecognized event types", () => {
  const msg = {
    event: "completely_unknown_event",
    message: { type: "nonexistent_type" },
  };
  assert.equal(humanizeClaudeMessage(msg), null);
});

test("humanizeClaudeMessage — handles null event field", () => {
  const msg = {
    event: null,
    message: { type: "assistant", message: { content: [{ type: "thinking" }] } },
  };
  assert.equal(humanizeClaudeMessage(msg), "claude thinking");
});

test("humanizeClaudeMessage — handles undefined input", () => {
  assert.equal(humanizeClaudeMessage(undefined), null);
});

test("humanizeClaudeMessage — formats session_started event", () => {
  const msg = {
    event: "session_started",
    message: { session_id: "claude-sess-42" },
  };
  assert.equal(humanizeClaudeMessage(msg), "claude session started (claude-sess-42)");
});

test("humanizeClaudeMessage — formats turn_failed event with reason", () => {
  const msg = {
    event: "turn_failed",
    message: { message: "rate limited" },
  };
  assert.equal(humanizeClaudeMessage(msg), "claude turn failed: rate limited");
});

// --- Utility functions (tested via public API) ---

test("sanitize — strips ANSI control characters", () => {
  // ANSI escape sequences get stripped when processed through the humanizer
  const msg = {
    event: "text",
    message: `\x1b[31mred text\x1b[0m`,
  };
  assert.equal(humanizeCodexMessage(msg), "red text");
});

test("sanitize — strips ASCII control characters", () => {
  const msg = {
    event: "text",
    message: `hello\x00\x01\x02world`,
  };
  assert.equal(humanizeCodexMessage(msg), "helloworld");
});

test("truncate — respects max length boundary via humanizeAgentMessage", () => {
  // humanizeAgentMessage truncates at 140
  const exactLength = "x".repeat(140);
  const msg = { event: "text", message: exactLength };
  const result = humanizeAgentMessage(msg);
  assert.equal(result.length, 140);
  assert.equal(result, exactLength);
});

test("truncate — does not truncate strings at boundary", () => {
  const msg = { event: "text", message: "x".repeat(139) };
  const result = humanizeAgentMessage(msg);
  assert.equal(result.length, 139);
});

test("formatUsageCounts — renders usage map as string", () => {
  const msg = {
    event: "thread_usage",
    message: {
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          total: { input_tokens: 500, output_tokens: 200, total_tokens: 700 },
        },
      },
    },
  };
  assert.equal(humanizeCodexMessage(msg), "thread token usage updated (in 500 out 200 total 700)");
});

test("formatUsageCounts — handles alternative camelCase keys", () => {
  const msg = {
    event: "thread_usage",
    message: {
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          total: { inputTokens: 300, outputTokens: 100, totalTokens: 400 },
        },
      },
    },
  };
  assert.equal(humanizeCodexMessage(msg), "thread token usage updated (in 300 out 100 total 400)");
});

test("formatReason — handles string reason", () => {
  const codexMsg = {
    event: "turn_ended_with_error",
    message: { reason: "timeout" },
    reason: "something",
  };
  assert.match(humanizeCodexMessage(codexMsg), /turn ended with error/);
});

test("formatReason — handles object reason with message field", () => {
  // formatReason receives the full outer record, so `message` must be a string at top level
  const msg = {
    event: "startup_failed",
    message: "connection refused",
  };
  assert.equal(humanizeCodexMessage(msg), "startup failed: connection refused");
});

test("unwrapPayload — unwraps nested message shapes with payload key", () => {
  const msg = {
    event: "wrapped",
    message: { payload: { method: "turn/started", params: { turn: { id: "t1" } } } },
  };
  assert.equal(humanizeCodexMessage(msg), "turn started (t1)");
});

test("unwrapPayload — does not unwrap when method key is present", () => {
  const msg = {
    event: "direct",
    message: { method: "turn/cancelled" },
  };
  assert.equal(humanizeCodexMessage(msg), "turn cancelled");
});
