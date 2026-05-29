import { test } from "vitest";
import type { RetryEntry, RunningEntry } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import { transitionSlot, initialSlotState } from "@symphony/orchestrator";
import type { SlotState } from "@symphony/orchestrator";

function makeRunningEntry(overrides: Partial<RunningEntry> = {}): RunningEntry {
  return {
    issue: {
      id: "issue-1",
      identifier: "MT-1",
      title: "Test",
      state: "Todo",
      labels: [],
      blockers: [],
    },
    identifier: "MT-1",
    slotIndex: 0,
    ensembleSize: 1,
    agentKind: "codex",
    workerHost: null,
    workspacePath: null,
    sessionId: null,
    resumeId: null,
    executorPid: null,
    turnCount: 0,
    startedAt: new Date("2025-01-01T00:00:00Z"),
    lastAgentEvent: null,
    lastAgentTimestamp: null,
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    lastReportedInputTokens: 0,
    lastReportedOutputTokens: 0,
    lastReportedTotalTokens: 0,
    retryAttempt: null,
    ...overrides,
  };
}

function makeRetryEntry(overrides: Partial<RetryEntry> = {}): RetryEntry {
  return {
    issueId: "issue-1",
    identifier: "MT-1",
    attempt: 1,
    dueAt: new Date("2025-01-01T01:00:00Z"),
    error: "agent exited",
    slotIndex: 0,
    ...overrides,
  };
}

// --- initialSlotState ---

test("initialSlotState returns idle", () => {
  assert.deepEqual(initialSlotState(), { phase: "idle" });
});

// --- idle phase transitions ---

test("idle + CLAIM -> running", () => {
  const state = initialSlotState();
  const entry = makeRunningEntry();
  const next = transitionSlot(state, { type: "CLAIM", entry });
  assert.equal(next.phase, "running");
  if (next.phase === "running") {
    assert.equal(next.entry, entry);
  }
});

test("idle + CLEANUP -> completed", () => {
  const state = initialSlotState();
  const next = transitionSlot(state, { type: "CLEANUP" });
  assert.deepEqual(next, { phase: "completed" });
});

test("idle + irrelevant events are no-ops", () => {
  const state = initialSlotState();
  const now = new Date("2025-01-01T00:00:00Z");
  assert.equal(
    transitionSlot(state, { type: "UPDATE", update: { type: "turn_completed" }, now }),
    state,
  );
  assert.equal(
    transitionSlot(state, { type: "FINISH_WITH_RETRY", retryEntry: makeRetryEntry() }),
    state,
  );
  assert.equal(transitionSlot(state, { type: "FINISH_NO_RETRY" }), state);
});

// --- running phase transitions ---

test("running + UPDATE mutates entry fields", () => {
  const entry = makeRunningEntry();
  const state: SlotState = { phase: "running", entry };
  const now = new Date("2025-01-01T00:05:00Z");
  const next = transitionSlot(state, {
    type: "UPDATE",
    update: {
      type: "turn_completed",
      sessionId: "s1",
      resumeId: "r1",
      executorPid: "123",
      workspacePath: "/tmp/ws",
    },
    now,
  });
  // Same state reference (mutation in place)
  assert.equal(next, state);
  assert.equal(entry.lastAgentEvent, "turn_completed");
  assert.equal(entry.sessionId, "s1");
  assert.equal(entry.resumeId, "r1");
  assert.equal(entry.executorPid, "123");
  assert.equal(entry.workspacePath, "/tmp/ws");
  assert.equal(entry.turnCount, 1);
  assert.equal(entry.lastAgentTimestamp?.getTime(), now.getTime());
});

test("running + UPDATE with turn_completed increments turnCount", () => {
  const entry = makeRunningEntry({ turnCount: 3 });
  const state: SlotState = { phase: "running", entry };
  const now = new Date("2025-01-01T00:05:00Z");
  transitionSlot(state, { type: "UPDATE", update: { type: "turn_completed" }, now });
  assert.equal(entry.turnCount, 4);
});

test("running + UPDATE with non-turn event does not increment turnCount", () => {
  const entry = makeRunningEntry({ turnCount: 2 });
  const state: SlotState = { phase: "running", entry };
  const now = new Date("2025-01-01T00:05:00Z");
  transitionSlot(state, { type: "UPDATE", update: { type: "usage" }, now });
  assert.equal(entry.turnCount, 2);
});

test("running + FINISH_WITH_RETRY -> retrying", () => {
  const entry = makeRunningEntry();
  const state: SlotState = { phase: "running", entry };
  const retryEntry = makeRetryEntry();
  const next = transitionSlot(state, { type: "FINISH_WITH_RETRY", retryEntry });
  assert.equal(next.phase, "retrying");
  if (next.phase === "retrying") {
    assert.equal(next.retry, retryEntry);
  }
});

test("running + FINISH_NO_RETRY -> idle", () => {
  const entry = makeRunningEntry();
  const state: SlotState = { phase: "running", entry };
  const next = transitionSlot(state, { type: "FINISH_NO_RETRY" });
  assert.deepEqual(next, { phase: "idle" });
});

test("running + CLEANUP -> completed", () => {
  const entry = makeRunningEntry();
  const state: SlotState = { phase: "running", entry };
  const next = transitionSlot(state, { type: "CLEANUP" });
  assert.deepEqual(next, { phase: "completed" });
});

test("running + CLAIM is a no-op (already running)", () => {
  const entry = makeRunningEntry();
  const state: SlotState = { phase: "running", entry };
  const newEntry = makeRunningEntry({ slotIndex: 1 });
  const next = transitionSlot(state, { type: "CLAIM", entry: newEntry });
  assert.equal(next, state);
});

// --- retrying phase transitions ---

test("retrying + CLEANUP -> completed", () => {
  const state: SlotState = { phase: "retrying", retry: makeRetryEntry() };
  const next = transitionSlot(state, { type: "CLEANUP" });
  assert.deepEqual(next, { phase: "completed" });
});

test("retrying + CLAIM -> running (direct reclaim on retry)", () => {
  const state: SlotState = { phase: "retrying", retry: makeRetryEntry() };
  const entry = makeRunningEntry();
  const next = transitionSlot(state, { type: "CLAIM", entry });
  assert.equal(next.phase, "running");
  if (next.phase === "running") {
    assert.equal(next.entry, entry);
  }
});

test("retrying + irrelevant events are no-ops", () => {
  const state: SlotState = { phase: "retrying", retry: makeRetryEntry() };
  const now = new Date("2025-01-01T00:00:00Z");
  assert.equal(
    transitionSlot(state, { type: "UPDATE", update: { type: "turn_completed" }, now }),
    state,
  );
  assert.equal(
    transitionSlot(state, { type: "FINISH_WITH_RETRY", retryEntry: makeRetryEntry() }),
    state,
  );
  assert.equal(transitionSlot(state, { type: "FINISH_NO_RETRY" }), state);
});

// --- completed phase (terminal) ---

test("completed absorbs all events", () => {
  const state: SlotState = { phase: "completed" };
  const now = new Date("2025-01-01T00:00:00Z");
  assert.equal(transitionSlot(state, { type: "CLAIM", entry: makeRunningEntry() }), state);
  assert.equal(
    transitionSlot(state, { type: "UPDATE", update: { type: "turn_completed" }, now }),
    state,
  );
  assert.equal(
    transitionSlot(state, { type: "FINISH_WITH_RETRY", retryEntry: makeRetryEntry() }),
    state,
  );
  assert.equal(transitionSlot(state, { type: "FINISH_NO_RETRY" }), state);
  assert.equal(transitionSlot(state, { type: "CLEANUP" }), state);
});
