import { test } from "vitest";
import { AGENT_UPDATE_TYPES } from "@symphony/domain";
import type { DispatchBlockEntry } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import { RUNTIME_EVENT_TYPES, RUNTIME_RUN_OUTCOMES } from "@symphony/runtime-events";
import type {
  RuntimeBlockedEntry,
  RuntimeEvent,
  RuntimeRetryEntry,
  RuntimeRunHistoryEntry,
  RuntimeRunningEntry,
  RuntimeSnapshot,
} from "@symphony/runtime-events";

test("RuntimeSnapshot shape contains all required fields with correct types", () => {
  const snapshot: RuntimeSnapshot = {
    appStatus: "idle",
    workflowPath: "/tmp/workflow.yaml",
    poll: {
      status: "idle",
      candidates: 5,
      eligible: 3,
      lastPollAt: "2026-05-26T00:00:00.000Z",
      nextPollAt: "2026-05-26T00:01:00.000Z",
      lastError: null,
    },
    running: [],
    retrying: [],
    blocked: [],
    runHistory: [],
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    rateLimits: null,
    logFile: "/tmp/symphony.log",
    recentEvents: [],
  };

  assert.equal(snapshot.appStatus, "idle");
  assert.equal(snapshot.workflowPath, "/tmp/workflow.yaml");
  assert.equal(snapshot.poll.status, "idle");
  assert.equal(snapshot.poll.candidates, 5);
  assert.equal(snapshot.poll.eligible, 3);
  assert.equal(snapshot.poll.lastPollAt, "2026-05-26T00:00:00.000Z");
  assert.equal(snapshot.poll.nextPollAt, "2026-05-26T00:01:00.000Z");
  assert.equal(snapshot.poll.lastError, null);
  assert.deepEqual(snapshot.running, []);
  assert.deepEqual(snapshot.retrying, []);
  assert.deepEqual(snapshot.blocked, []);
  assert.deepEqual(snapshot.runHistory, []);
  assert.deepEqual(snapshot.usageTotals, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    secondsRunning: 0,
  });
  assert.equal(snapshot.rateLimits, null);
  assert.equal(snapshot.logFile, "/tmp/symphony.log");
  assert.deepEqual(snapshot.recentEvents, []);
});

test("RuntimeEvent structure validates known event types from RUNTIME_EVENT_TYPES", () => {
  // RUNTIME_EVENT_TYPES should include all AGENT_UPDATE_TYPES plus runtime-specific ones
  for (const agentType of AGENT_UPDATE_TYPES) {
    assert.ok(RUNTIME_EVENT_TYPES.includes(agentType));
  }

  // Runtime-specific event types
  const runtimeSpecificTypes = [
    "dry_run",
    "poll_error",
    "dispatch_skipped",
    "run_started",
    "dispatch_refresh_failed",
    "run_completed",
    "run_failed",
    "workflow_reloaded",
    "workflow_reload_failed",
    "reconcile_refresh_failed",
    "workspace_cleanup",
    "run_reconciled",
    "run_stalled",
    "startup_workspace_cleanup",
    "startup_workspace_cleanup_failed",
    "resume_state_invalidated",
    "resume_state_invalidation_failed",
    "retry_timer_due",
    "retry_timer_error",
    "refresh_error",
  ] as const;

  for (const t of runtimeSpecificTypes) {
    assert.ok(RUNTIME_EVENT_TYPES.includes(t));
  }

  // A conforming RuntimeEvent
  const event: RuntimeEvent = {
    type: "run_completed",
    message: "Run finished successfully",
    at: "2026-05-26T00:00:00.000Z",
  };
  assert.equal(event.type, "run_completed");
  assert.equal(event.message, "Run finished successfully");
  assert.equal(event.at, "2026-05-26T00:00:00.000Z");
});

test("RUNTIME_RUN_OUTCOMES includes success, failed, stalled, canceled", () => {
  assert.ok(RUNTIME_RUN_OUTCOMES.includes("success"));
  assert.ok(RUNTIME_RUN_OUTCOMES.includes("failed"));
  assert.ok(RUNTIME_RUN_OUTCOMES.includes("stalled"));
  assert.ok(RUNTIME_RUN_OUTCOMES.includes("canceled"));
  assert.equal(RUNTIME_RUN_OUTCOMES.length, 4);
});

test("RuntimeRunHistoryEntry round-trips through JSON serialization", () => {
  const entry: RuntimeRunHistoryEntry = {
    id: "run-001",
    issueId: "issue-1",
    issueIdentifier: "MT-1",
    issueTitle: "Fix the widget",
    state: "Done",
    slotIndex: 0,
    ensembleSize: 2,
    agentKind: "codex",
    outcome: "success",
    turnCount: 5,
    sessionId: "sess-abc",
    resumeId: "resume-xyz",
    executorPid: "12345",
    workspace: "/tmp/workspace",
    workerHost: "worker-1.local",
    usageTotals: { inputTokens: 100, outputTokens: 200, totalTokens: 300, secondsRunning: 45 },
    startedAt: "2026-05-26T00:00:00.000Z",
    endedAt: "2026-05-26T00:05:00.000Z",
    durationMs: 300000,
    error: undefined,
    lastEvent: "turn_completed",
    lastMessage: { text: "Done" },
    lastEventAt: "2026-05-26T00:04:59.000Z",
    retryAttempt: 1,
  };

  const serialized = JSON.stringify(entry);
  const deserialized: RuntimeRunHistoryEntry = JSON.parse(serialized);

  assert.equal(deserialized.id, entry.id);
  assert.equal(deserialized.issueId, entry.issueId);
  assert.equal(deserialized.issueIdentifier, entry.issueIdentifier);
  assert.equal(deserialized.issueTitle, entry.issueTitle);
  assert.equal(deserialized.state, entry.state);
  assert.equal(deserialized.slotIndex, entry.slotIndex);
  assert.equal(deserialized.ensembleSize, entry.ensembleSize);
  assert.equal(deserialized.agentKind, entry.agentKind);
  assert.equal(deserialized.outcome, entry.outcome);
  assert.equal(deserialized.turnCount, entry.turnCount);
  assert.equal(deserialized.sessionId, entry.sessionId);
  assert.equal(deserialized.resumeId, entry.resumeId);
  assert.equal(deserialized.executorPid, entry.executorPid);
  assert.equal(deserialized.workspace, entry.workspace);
  assert.equal(deserialized.workerHost, entry.workerHost);
  assert.deepEqual(deserialized.usageTotals, entry.usageTotals);
  assert.equal(deserialized.startedAt, entry.startedAt);
  assert.equal(deserialized.endedAt, entry.endedAt);
  assert.equal(deserialized.durationMs, entry.durationMs);
  assert.equal(deserialized.lastEvent, entry.lastEvent);
  assert.deepEqual(deserialized.lastMessage, entry.lastMessage);
  assert.equal(deserialized.lastEventAt, entry.lastEventAt);
  assert.equal(deserialized.retryAttempt, entry.retryAttempt);
});

test("RuntimeRunningEntry includes issue, slot, and timing fields", () => {
  const running: RuntimeRunningEntry = {
    runId: "run-002",
    issueId: "issue-2",
    issueIdentifier: "MT-2",
    title: "Deploy the service",
    state: "InProgress",
    slotIndex: 1,
    ensembleSize: 3,
    agentKind: "claude",
    sessionId: "sess-def",
    resumeId: "resume-456",
    executorPid: "67890",
    workerHost: "worker-2.local",
    turnCount: 3,
    startedAt: "2026-05-26T01:00:00.000Z",
    lastEvent: "turn_completed",
    lastMessage: "Processing...",
    lastEventAt: "2026-05-26T01:02:00.000Z",
    workspacePath: "/tmp/workspace/MT-2",
    usageTotals: { inputTokens: 50, outputTokens: 80, totalTokens: 130, secondsRunning: 20 },
    retryAttempt: null,
  };

  // Issue fields
  assert.equal(running.issueId, "issue-2");
  assert.equal(running.issueIdentifier, "MT-2");
  assert.equal(running.title, "Deploy the service");
  assert.equal(running.state, "InProgress");

  // Slot fields
  assert.equal(running.slotIndex, 1);
  assert.equal(running.ensembleSize, 3);

  // Timing fields
  assert.equal(running.startedAt, "2026-05-26T01:00:00.000Z");
  assert.equal(running.lastEventAt, "2026-05-26T01:02:00.000Z");
  assert.equal(running.turnCount, 3);

  // Agent/execution fields
  assert.equal(running.agentKind, "claude");
  assert.equal(running.sessionId, "sess-def");
  assert.equal(running.executorPid, "67890");
  assert.deepEqual(running.usageTotals, {
    inputTokens: 50,
    outputTokens: 80,
    totalTokens: 130,
    secondsRunning: 20,
  });
});

test("RuntimeRetryEntry includes attempt count and next retry time", () => {
  const retry: RuntimeRetryEntry = {
    issueId: "issue-3",
    identifier: "MT-3",
    attempt: 3,
    dueAt: "2026-05-26T02:00:00.000Z",
    error: "agent crashed: OOM",
    slotIndex: 0,
    workerHost: "worker-3.local",
    workspacePath: "/tmp/workspace/MT-3",
  };

  assert.equal(retry.attempt, 3);
  assert.equal(retry.dueAt, "2026-05-26T02:00:00.000Z");
  assert.equal(retry.issueId, "issue-3");
  assert.equal(retry.identifier, "MT-3");
  assert.equal(retry.error, "agent crashed: OOM");
  assert.equal(retry.slotIndex, 0);
  assert.equal(retry.workerHost, "worker-3.local");
  assert.equal(retry.workspacePath, "/tmp/workspace/MT-3");
});

test("RuntimeBlockedEntry matches DispatchBlockEntry shape", () => {
  const blocked: RuntimeBlockedEntry = {
    issueId: "issue-4",
    identifier: "MT-4",
    state: "Todo",
    reason: "global_concurrency_cap",
    workerHost: null,
  };

  // RuntimeBlockedEntry is a type alias for DispatchBlockEntry, so they share the same shape
  const asDispatchBlock: DispatchBlockEntry = blocked;
  assert.equal(asDispatchBlock.issueId, "issue-4");
  assert.equal(asDispatchBlock.identifier, "MT-4");
  assert.equal(asDispatchBlock.state, "Todo");
  assert.equal(asDispatchBlock.reason, "global_concurrency_cap");
  assert.equal(asDispatchBlock.workerHost, null);

  // All valid block reasons
  const reasons: DispatchBlockEntry["reason"][] = [
    "global_concurrency_cap",
    "local_concurrency_cap",
    "worker_host_capacity",
  ];
  for (const reason of reasons) {
    const entry: RuntimeBlockedEntry = {
      issueId: "issue-x",
      identifier: "MT-X",
      state: "Todo",
      reason,
    };
    assert.equal(entry.reason, reason);
  }
});
