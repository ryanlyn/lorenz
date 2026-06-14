import { test } from "vitest";
import type { RuntimeEvent, RuntimeRunHistoryEntry } from "@symphony/runtime-events";
import type { UsageTotals } from "@symphony/domain";
import { assert } from "@symphony/test-utils";

import type { RuntimeProjectionInput } from "@symphony/projections";
import { ProjectionActor } from "@symphony/projections";

function makeUsageTotals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0,
    ...overrides,
  };
}

function makeInput(overrides: Partial<RuntimeProjectionInput> = {}): RuntimeProjectionInput {
  return {
    appStatus: "idle",
    workflowPath: "/tmp/workflow.md",
    poll: {
      status: "idle",
      candidates: 0,
      eligible: 0,
      lastPollAt: null,
      nextPollAt: null,
      lastError: null,
    },
    running: [],
    retrying: [],
    blocked: [],
    usageTotals: makeUsageTotals(),
    rateLimits: null,
    logFile: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    type: "run_started",
    message: "Run started",
    at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeRunHistoryEntry(
  overrides: Partial<RuntimeRunHistoryEntry> = {},
): RuntimeRunHistoryEntry {
  return {
    id: "run-1",
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    slotIndex: 0,
    agentKind: "claude",
    outcome: "success",
    turnCount: 3,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:05:00Z",
    ...overrides,
  };
}

// --- ProjectionActor initializes with empty state ---

test("ProjectionActor initializes with empty state", () => {
  const actor = new ProjectionActor();
  const input = makeInput();
  const snap = actor.snapshot(input);

  assert.deepEqual(snap.recentEvents, []);
  assert.deepEqual(snap.runHistory, []);
  assert.equal(snap.appStatus, "idle");
  assert.equal(snap.workflowPath, "/tmp/workflow.md");
  assert.deepEqual(snap.running, []);
  assert.deepEqual(snap.retrying, []);
  assert.deepEqual(snap.blocked, []);
});

// --- ProjectionActor processes runtime snapshot into projection ---

test("ProjectionActor processes runtime snapshot into projection", () => {
  const actor = new ProjectionActor();
  const input = makeInput({
    appStatus: "running",
    workflowPath: "/home/user/workflow.md",
    poll: {
      status: "checking",
      candidates: 5,
      eligible: 2,
      lastPollAt: "2026-01-01T00:00:00Z",
      nextPollAt: "2026-01-01T00:01:00Z",
      lastError: null,
    },
    running: [
      {
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        issueTitle: "Fix bug",
        state: "In Progress",
        slotIndex: 0,
        ensembleSize: 1,
        agentKind: "claude",
        turnCount: 2,
        startedAt: "2026-01-01T00:00:00Z",
        usageTotals: makeUsageTotals({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
      },
    ],
    retrying: [
      {
        issueId: "issue-2",
        issueIdentifier: "ENG-2",
        attempt: 2,
        dueAtIso: "2026-01-01T00:02:00Z",
        monotonicDeadlineMs: 120000,
        error: "timeout",
      },
    ],
    blocked: [
      {
        issueId: "issue-3",
        identifier: "ENG-3",
        state: "Todo",
        reason: "global_concurrency_cap",
      },
    ],
    usageTotals: makeUsageTotals({
      inputTokens: 500,
      outputTokens: 200,
      totalTokens: 700,
      secondsRunning: 120,
    }),
    rateLimits: { remaining: 10 },
    logFile: "/tmp/symphony.log",
  });

  const snap = actor.snapshot(input);

  assert.equal(snap.appStatus, "running");
  assert.equal(snap.workflowPath, "/home/user/workflow.md");
  assert.equal(snap.poll.status, "checking");
  assert.equal(snap.poll.candidates, 5);
  assert.equal(snap.poll.eligible, 2);
  assert.equal(snap.running.length, 1);
  assert.equal(snap.running[0]!.issueIdentifier, "ENG-1");
  assert.equal(snap.running[0]!.usageTotals.inputTokens, 100);
  assert.equal(snap.retrying.length, 1);
  assert.equal(snap.retrying[0]!.issueIdentifier, "ENG-2");
  assert.equal(snap.blocked.length, 1);
  assert.equal(snap.blocked[0]!.reason, "global_concurrency_cap");
  assert.equal(snap.usageTotals.totalTokens, 700);
  assert.deepEqual(snap.rateLimits, { remaining: 10 });
  assert.equal(snap.logFile, "/tmp/symphony.log");
});

// --- ProjectionActor updates projection on new events ---

test("ProjectionActor updates projection on new events", () => {
  const actor = new ProjectionActor();

  actor.recordEvent(
    makeEvent({ type: "run_started", message: "First run", at: "2026-01-01T00:00:00Z" }),
  );
  actor.recordEvent(
    makeEvent({ type: "run_completed", message: "First completed", at: "2026-01-01T00:01:00Z" }),
  );
  actor.recordRunHistory(makeRunHistoryEntry({ id: "run-1", outcome: "success" }));

  const snap = actor.snapshot(makeInput());

  assert.equal(snap.recentEvents.length, 2);
  // Most recent event is first
  assert.equal(snap.recentEvents[0]!.type, "run_completed");
  assert.equal(snap.recentEvents[1]!.type, "run_started");
  assert.equal(snap.runHistory.length, 1);
  assert.equal(snap.runHistory[0]!.id, "run-1");
  assert.equal(snap.runHistory[0]!.outcome, "success");
});

test("ProjectionActor caps recentEvents at 20 entries", () => {
  const actor = new ProjectionActor();

  for (let i = 0; i < 25; i++) {
    actor.recordEvent(
      makeEvent({ message: `Event ${i}`, at: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z` }),
    );
  }

  const snap = actor.snapshot(makeInput());
  assert.equal(snap.recentEvents.length, 20);
  // Most recent event should be first
  assert.equal(snap.recentEvents[0]!.message, "Event 24");
});

test("ProjectionActor caps runHistory at 50 entries", () => {
  const actor = new ProjectionActor();

  for (let i = 0; i < 55; i++) {
    actor.recordRunHistory(makeRunHistoryEntry({ id: `run-${i}` }));
  }

  const snap = actor.snapshot(makeInput());
  assert.equal(snap.runHistory.length, 50);
  // Most recent entry should be first
  assert.equal(snap.runHistory[0]!.id, "run-54");
});

// --- ProjectionActor preserves previous state when input unchanged ---

test("ProjectionActor preserves previous state when input unchanged", () => {
  const actor = new ProjectionActor();

  actor.recordEvent(makeEvent({ type: "run_started", message: "started" }));
  actor.recordRunHistory(makeRunHistoryEntry({ id: "run-1" }));

  const input = makeInput({ appStatus: "polling" });
  const snap1 = actor.snapshot(input);
  const snap2 = actor.snapshot(input);

  // Both snapshots reflect the same accumulated state
  assert.deepEqual(snap1.recentEvents, snap2.recentEvents);
  assert.deepEqual(snap1.runHistory, snap2.runHistory);
  assert.equal(snap1.appStatus, snap2.appStatus);
  assert.equal(snap1.workflowPath, snap2.workflowPath);

  // Snapshots are independent copies (mutation safe)
  snap1.running.push({
    issueId: "mutated",
    issueIdentifier: "MUT-1",
    issueTitle: "Mutated",
    state: "x",
    slotIndex: 0,
    ensembleSize: 1,
    agentKind: "test",
    turnCount: 0,
    startedAt: "2026-01-01T00:00:00Z",
    usageTotals: makeUsageTotals(),
  });
  assert.equal(snap2.running.length, 0);
});

// --- ProjectionActor handles null/missing fields defensively ---

test("ProjectionActor handles null/missing fields defensively", () => {
  const actor = new ProjectionActor();

  const input = makeInput({
    poll: {
      status: "idle",
      candidates: 0,
      eligible: 0,
      lastPollAt: null,
      nextPollAt: null,
      lastError: null,
    },
    logFile: null,
    rateLimits: null,
    running: [
      {
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        issueTitle: "Test",
        state: "In Progress",
        slotIndex: 0,
        ensembleSize: 1,
        agentKind: "claude",
        sessionId: null,
        executorPid: null,
        workerHost: null,
        turnCount: 0,
        startedAt: "2026-01-01T00:00:00Z",
        lastEvent: null,
        lastMessage: null,
        lastEventAt: null,
        workspacePath: null,
        usageTotals: makeUsageTotals(),
        retryAttempt: null,
      },
    ],
    retrying: [
      {
        issueId: "issue-2",
        issueIdentifier: "ENG-2",
        attempt: 1,
        dueAtIso: "2026-01-01T00:00:00Z",
        monotonicDeadlineMs: 0,
        error: undefined,
        slotIndex: undefined,
        workerHost: null,
        workspacePath: null,
      },
    ],
  });

  const snap = actor.snapshot(input);

  assert.equal(snap.logFile, null);
  assert.equal(snap.rateLimits, null);
  assert.equal(snap.poll.lastPollAt, null);
  assert.equal(snap.poll.nextPollAt, null);
  assert.equal(snap.poll.lastError, null);
  assert.equal(snap.running[0]!.sessionId, null);
  assert.equal(snap.running[0]!.executorPid, null);
  assert.equal(snap.running[0]!.workerHost, null);
  assert.equal(snap.retrying[0]!.workerHost, null);
  assert.equal(snap.retrying[0]!.workspacePath, null);
});

test("ProjectionActor handles runHistory entry with undefined usageTotals", () => {
  const actor = new ProjectionActor();

  actor.recordRunHistory(makeRunHistoryEntry({ id: "run-no-usage", usageTotals: undefined }));

  const snap = actor.snapshot(makeInput());

  assert.equal(snap.runHistory.length, 1);
  assert.equal(snap.runHistory[0]!.id, "run-no-usage");
  assert.equal(snap.runHistory[0]!.usageTotals, undefined);
});
