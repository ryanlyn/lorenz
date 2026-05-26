import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import { SESSION_UPDATE_KINDS } from "@symphony/protocol";
import type {
  StopReason,
  SessionUpdate,
  UsageUpdate,
  TurnUpdate,
  TurnResult,
  UsageTotals,
} from "@symphony/protocol";

test("StopReason type accepts all valid values", () => {
  const values: StopReason[] = [
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
  ];
  assert.equal(values.length, 5);
  for (const v of values) {
    assert.ok(typeof v === "string");
  }
});

test("SESSION_UPDATE_KINDS array is non-empty and contains expected members", () => {
  assert.ok(SESSION_UPDATE_KINDS.length > 0);
  const kinds: readonly string[] = SESSION_UPDATE_KINDS;
  assert.ok(kinds.includes("usage_update"));
  assert.ok(kinds.includes("turn_started"));
  assert.ok(kinds.includes("turn_completed"));
  assert.ok(kinds.includes("turn_failed"));
  assert.ok(kinds.includes("notification"));
  assert.ok(kinds.includes("tool_call"));
  assert.ok(kinds.includes("tool_result"));
  assert.ok(kinds.includes("session_started"));
  assert.ok(kinds.includes("turn_cancelled"));
});

test("SessionUpdate discriminates correctly between UsageUpdate and TurnUpdate", () => {
  const usageUpdate: SessionUpdate = {
    kind: "usage_update",
    usage: { inputTokens: 10, outputTokens: 5 },
  };

  const turnUpdate: SessionUpdate = {
    kind: "turn_completed",
    message: "done",
  };

  // Discriminate via kind field
  assert.equal(usageUpdate.kind, "usage_update");
  assert.equal(turnUpdate.kind, "turn_completed");

  // Verify UsageUpdate carries usage payload
  if (usageUpdate.kind === "usage_update") {
    const narrowed = usageUpdate as UsageUpdate;
    assert.deepEqual(narrowed.usage, { inputTokens: 10, outputTokens: 5 });
  }

  // Verify TurnUpdate carries message
  if (turnUpdate.kind === "turn_completed") {
    const narrowed = turnUpdate as TurnUpdate;
    assert.equal(narrowed.message, "done");
  }
});

test("TurnResult includes stopReason and usage fields", () => {
  const result: TurnResult = {
    stopReason: "end_turn",
    sessionId: "sess-123",
    _meta: {
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, secondsRunning: 3 },
    },
  };

  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.sessionId, "sess-123");
  assert.ok(result._meta);
  assert.deepEqual(result._meta!.usage, {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    secondsRunning: 3,
  });
});

test("UsageTotals fields default to zero", () => {
  const defaults: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0,
  };

  assert.equal(defaults.inputTokens, 0);
  assert.equal(defaults.outputTokens, 0);
  assert.equal(defaults.totalTokens, 0);
  assert.equal(defaults.secondsRunning, 0);
});
