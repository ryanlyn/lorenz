import { test } from "vitest";
import { slotKey } from "@lorenz/dispatch";
import { parseConfig } from "@lorenz/config";
import type {
  ClockPort,
  Issue,
  RunningEntry,
  RuntimeTrackerClient,
  WorkflowDefinition,
} from "@lorenz/domain";
import type { Orchestrator, OrchestratorSnapshot } from "@lorenz/orchestrator";
import type { RuntimeEvent, RuntimeEventType } from "@lorenz/runtime-events";
import { assert } from "@lorenz/test-utils";

import { RuntimeStartupCleaner } from "../src/cleanup.js";
import { RuntimeDispatcher } from "../src/dispatcher.js";
import { RuntimeEventLog } from "../src/events.js";
import { RuntimeReconciler } from "../src/reconciliation.js";
import { RuntimeWorkflowReloader } from "../src/reload.js";
import { RuntimeRetryTimers } from "../src/retryTimers.js";
import { RuntimeSnapshotProjector } from "../src/snapshot.js";
import type { RetrySnapshotEntry } from "../src/snapshotEntries.js";

function workflowFixture(): WorkflowDefinition {
  return {
    path: "/tmp/WORKFLOW.md",
    config: {},
    promptTemplate: "Do the work",
    settings: parseConfig({
      tracker: {
        kind: "linear",
        api_key: "linear-token",
        project_slug: "mono",
      },
      logging: { log_file: "/tmp/lorenz.log" },
      polling: { interval_ms: 5 },
    }),
  };
}

function issueFixture(): Issue {
  return {
    id: "issue-1",
    identifier: "MONO-1",
    title: "Runtime unit issue",
    state: "Todo",
    stateType: "unstarted",
    labels: [],
    blockers: [],
  };
}

function runningEntryFixture(issue = issueFixture()): RunningEntry {
  return {
    issue,
    identifier: issue.identifier,
    slotIndex: 0,
    ensembleSize: 1,
    agentKind: "codex",
    workerHost: "worker-a",
    workspacePath: "/tmp/lorenz/MONO-1",
    sessionId: null,
    executorPid: null,
    turnCount: 0,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastAgentTimestamp: null,
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    lastReportedInputTokens: 0,
    lastReportedOutputTokens: 0,
    lastReportedTotalTokens: 0,
    retryAttempt: null,
  };
}

function manualClock(initial = new Date("2026-01-01T00:00:00.000Z")) {
  let nowMs = initial.getTime();
  let scheduled: (() => void) | null = null;
  const clock: ClockPort & { advance(ms: number): void; fireTimer(): void } = {
    now: () => new Date(nowMs),
    monotonicMs: () => nowMs,
    setTimeout(callback) {
      scheduled = callback;
      return { unref: () => {} };
    },
    clearTimeout() {
      scheduled = null;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    fireTimer() {
      const callback = scheduled;
      scheduled = null;
      callback?.();
    },
  };
  return clock;
}

test("runtime workflow reloader applies changed workflow transactionally", async () => {
  const workflow = workflowFixture();
  const nextWorkflow: WorkflowDefinition = {
    ...workflowFixture(),
    path: "/tmp/WORKFLOW.next.md",
    settings: parseConfig({ polling: { interval_ms: 25 } }),
  };
  let activeWorkflow = workflow;
  let activeClient = {};
  const events: Array<{ type: string; message: string }> = [];
  const orchestrator = { settings: workflow.settings } as Orchestrator;
  const reloader = new RuntimeWorkflowReloader({
    workflow: () => activeWorkflow,
    reloadWorkflow: async () => nextWorkflow,
    clientWasInjected: () => false,
    clientFactory: (settings) => ({ settings }),
    setWorkflow: (updated) => {
      activeWorkflow = updated;
    },
    setClient: (client) => {
      activeClient = client;
    },
    orchestrator,
    addEvent: (type, message) => events.push({ type, message }),
  });

  await reloader.reloadIfConfigured();

  assert.equal(activeWorkflow, nextWorkflow);
  assert.equal(orchestrator.settings, nextWorkflow.settings);
  assert.deepEqual(activeClient, { settings: nextWorkflow.settings });
  assert.deepEqual(events, [{ type: "workflow_reloaded", message: "/tmp/WORKFLOW.next.md" }]);
});

test("runtime dispatcher refreshes, claims, records dispatch, and tracks run lifecycle", async () => {
  const issue = issueFixture();
  const refreshed = { ...issue, title: "Refreshed" };
  const events: Array<{ type: RuntimeEventType; message: string }> = [];
  const inFlight = new Set<Promise<void>>();
  const activeRuns = new Map<string, { release(): void }>();
  const claimed: string[] = [];
  const dispatched: Issue[] = [];
  let emitted = 0;
  let heartbeats = 0;
  let lifecycleUpdates = 0;
  let finishRun: (() => void) | undefined;
  const orchestrator = {
    claimAsync: async (claimIssue: Issue) => {
      claimed.push(claimIssue.title);
      return {
        kind: "running",
        entry: { slotIndex: 0, agentKind: "codex", workerHost: "worker-a" },
      };
    },
    abandonClaimAsync: async () => {
      throw new Error("unexpected abandon");
    },
  } as unknown as Orchestrator;
  const dispatcher = new RuntimeDispatcher({
    client: () =>
      ({
        fetchIssuesByIds: async (ids: readonly string[]) =>
          ids.includes(issue.id) ? [refreshed] : [],
      }) as unknown as RuntimeTrackerClient,
    orchestrator,
    activeRuns,
    inFlight,
    nextRunId: () => "run-1",
    createHandle: () => ({ release: () => {} }),
    syncRetryTimer: () => {},
    startClaimOwnerHeartbeat: async () => {
      heartbeats += 1;
    },
    stopClaimOwnerHeartbeatIfIdle: () => {},
    updateAppStatusFromInFlight: () => {
      lifecycleUpdates += 1;
    },
    emit: () => {
      emitted += 1;
    },
    addEvent: (type, message) => events.push({ type, message }),
    onIssueDispatched: (dispatchedIssue) => dispatched.push(dispatchedIssue),
    runClaim: () =>
      new Promise<void>((resolve) => {
        finishRun = resolve;
      }),
    runReservedClaim: async () => {
      throw new Error("unexpected reserved claim");
    },
  });

  const runs = await dispatcher.maybeDispatch(issue);

  assert.equal(runs.length, 1);
  assert.deepEqual(claimed, ["Refreshed"]);
  assert.equal(activeRuns.has(slotKey(issue.id, 0)), true);
  assert.equal(inFlight.size, 1);
  assert.deepEqual(events, [{ type: "run_started", message: "MONO-1 slot=0" }]);
  assert.deepEqual(dispatched, [refreshed]);
  assert.equal(heartbeats, 1);
  assert.equal(emitted, 1);

  finishRun?.();
  await runs[0];
  await Promise.resolve();

  assert.equal(inFlight.size, 0);
  assert.equal(lifecycleUpdates, 1);
  assert.equal(emitted, 2);
});

test("runtime reconciler cleans terminal tracked issues and clears local runtime state", async () => {
  const workflow = workflowFixture();
  const activeIssue = issueFixture();
  const terminalIssue: Issue = { ...activeIssue, state: "Done", stateType: "completed" };
  const cleaned: string[] = [];
  const aborted: string[] = [];
  const clearedTimers: string[] = [];
  const removedWorkspaces: Array<string | null | undefined> = [];
  const events: Array<{ type: RuntimeEventType; message: string }> = [];
  const orchestrator = {
    snapshotAsync: async () =>
      ({
        running: [runningEntryFixture(activeIssue)],
        reserving: [],
        retrying: [],
        blocked: [],
        usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
        rateLimits: {},
        claimStore: {
          kind: "memory",
          ownerId: "owner-1",
          capabilities: {
            crashRecovery: false,
            sharedAcrossProcesses: false,
            retryDurability: false,
          },
          hydratedAt: null,
          transactionsApplied: 0,
          lastOperation: null,
          lastCheckpointAt: null,
        },
      }) satisfies OrchestratorSnapshot,
    ownsClaimAsync: async () => true,
    cleanupIssueAsync: async (issueId: string) => {
      cleaned.push(issueId);
    },
    refreshRunningIssueAsync: async () => {
      throw new Error("terminal issue should not be refreshed");
    },
  } as unknown as Orchestrator;
  const reconciler = new RuntimeReconciler({
    workflow: () => workflow,
    client: () =>
      ({
        fetchIssuesByIds: async () => [terminalIssue],
      }) as unknown as RuntimeTrackerClient,
    orchestrator,
    clock: manualClock(),
    activeRuns: new Map(),
    addEvent: (type, message) => events.push({ type, message }),
    abortIssueRuns: (issueId) => aborted.push(issueId),
    clearRetryTimer: (issueId) => clearedTimers.push(issueId),
    syncRetryTimerSafely: () => null,
    removeIssueWorkspaces: async ({ issueIdentifier }) => {
      removedWorkspaces.push(issueIdentifier);
    },
    recordHistory: () => {},
    recordClaimStoreFailure: () => {
      throw new Error("unexpected claim-store failure");
    },
  });

  await reconciler.reconcileTrackedIssues();

  assert.deepEqual(cleaned, [activeIssue.id]);
  assert.deepEqual(aborted, [activeIssue.id]);
  assert.deepEqual(clearedTimers, [activeIssue.id]);
  assert.deepEqual(removedWorkspaces, ["MONO-1"]);
  assert.deepEqual(events, [{ type: "workspace_cleanup", message: "MONO-1 terminal" }]);
});

test("runtime startup cleaner removes terminal listed workspaces once", async () => {
  const workflow = workflowFixture();
  const terminalIssue: Issue = { ...issueFixture(), state: "Done", stateType: "completed" };
  const activeIssue = { ...issueFixture(), id: "issue-2", identifier: "MONO-2" };
  const removed: string[] = [];
  const events: Array<{ type: string; message: string }> = [];
  let listCalls = 0;
  const cleaner = new RuntimeStartupCleaner({
    workflow: () => workflow,
    client: () =>
      ({
        fetchIssuesByIds: async () => [terminalIssue, activeIssue],
      }) as unknown as RuntimeTrackerClient,
    listIssueWorkspaces: async () => {
      listCalls += 1;
      return ["MONO-1", "MONO-2"];
    },
    removeIssueWorkspaces: async ({ issueIdentifier }) => {
      if (issueIdentifier) removed.push(issueIdentifier);
    },
    addEvent: (type, message) => events.push({ type, message }),
  });

  await cleaner.cleanupTerminalWorkspacesOnce();
  await cleaner.cleanupTerminalWorkspacesOnce();

  assert.equal(listCalls, 1);
  assert.deepEqual(removed, ["MONO-1"]);
  assert.deepEqual(events, [{ type: "startup_workspace_cleanup", message: "terminal=1" }]);
});

test("runtime event log records projection events and append-log payloads", async () => {
  const clock = manualClock();
  const workflow = workflowFixture();
  const recorded: RuntimeEvent[] = [];
  const appended: Array<{ logFile: string; event: Record<string, unknown> }> = [];
  let emits = 0;
  const log = new RuntimeEventLog({
    clock,
    getWorkflow: () => workflow,
    appendLogEvent: async (logFile, event) => {
      appended.push({ logFile, event });
    },
    recordEvent: (event) => recorded.push(event),
    emit: () => {
      emits += 1;
    },
  });

  log.add("dry_run", "eligible=0 candidates=1");
  await Promise.resolve();

  assert.deepEqual(recorded, [
    {
      type: "dry_run",
      message: "eligible=0 candidates=1",
      at: "2026-01-01T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(appended, [
    {
      logFile: "/tmp/lorenz.log",
      event: {
        at: "2026-01-01T00:00:00.000Z",
        event: "dry_run",
        message: "eligible=0 candidates=1",
      },
    },
  ]);
  assert.equal(emits, 1);
});

test("runtime retry timers use narrow retry projections and queue due polls", async () => {
  const clock = manualClock();
  const issue = issueFixture();
  const retry: RetrySnapshotEntry = {
    issueId: issue.id,
    identifier: issue.identifier,
    issueUrl: null,
    attempt: 2,
    dueAtIso: "2026-01-01T00:00:01.000Z",
    monotonicDeadlineMs: clock.monotonicMs() + 1_000,
    error: "previous failure",
    slotIndex: 0,
    workerHost: null,
    workspacePath: "/tmp/lorenz/MONO-1",
  };
  let issueBatchReads = 0;
  let singleIssueReads = 0;
  const events: Array<{ type: RuntimeEventType; message: string }> = [];
  let polls = 0;
  const timers = new RuntimeRetryTimers({
    clock,
    getRetryForIssue: (issueId) => {
      singleIssueReads += 1;
      return issueId === issue.id ? retry : undefined;
    },
    getRetriesForIssues: (issueIds) => {
      issueBatchReads += 1;
      return new Map(issueIds.includes(issue.id) ? [[issue.id, retry]] : []);
    },
    addEvent: (type, message) => events.push({ type, message }),
    markRuntimeError: () => {
      throw new Error("unexpected retry timer error");
    },
    pollInProgress: () => false,
    queuePoll: () => {
      throw new Error("no active poll should be queued");
    },
    pollOnce: async () => {
      polls += 1;
    },
  });

  timers.syncForIssues([issue]);
  clock.advance(1_010);
  clock.fireTimer();
  await Promise.resolve();

  assert.equal(issueBatchReads, 1);
  assert.equal(singleIssueReads, 1);
  assert.deepEqual(events, [{ type: "retry_timer_due", message: "MONO-1 attempt=2" }]);
  assert.equal(polls, 1);
});

test("runtime snapshot projector preserves facade snapshot shape", () => {
  const projector = new RuntimeSnapshotProjector();
  const workflow = workflowFixture();
  const issue = issueFixture();
  const running: RunningEntry = {
    issue,
    identifier: issue.identifier,
    slotIndex: 0,
    ensembleSize: 1,
    agentKind: "codex",
    workerHost: "worker-a",
    workspacePath: "/tmp/lorenz/MONO-1",
    sessionId: "session-1",
    executorPid: "123",
    turnCount: 3,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastAgentEvent: "turn_completed",
    lastAgentTimestamp: new Date("2026-01-01T00:00:03.000Z"),
    usageTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 0 },
    lastReportedInputTokens: 10,
    lastReportedOutputTokens: 5,
    lastReportedTotalTokens: 15,
    retryAttempt: null,
  };
  const orchestration: OrchestratorSnapshot = {
    running: [running],
    reserving: [
      {
        issueId: issue.id,
        identifier: issue.identifier,
        slotIndex: 1,
        affinityHost: null,
        retryAttempt: null,
        reservedAtIso: "2026-01-01T00:00:01.000Z",
      },
    ],
    retrying: [
      {
        issueId: issue.id,
        identifier: issue.identifier,
        issueUrl: null,
        attempt: 1,
        dueAtIso: "2026-01-01T00:00:10.000Z",
        monotonicDeadlineMs: 10_000,
        slotIndex: 0,
        workerHost: "worker-a",
      },
    ],
    blocked: [],
    usageTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 1 },
    rateLimits: { remaining: 1 },
    claimStore: {
      kind: "memory",
      ownerId: "owner-1",
      capabilities: {
        crashRecovery: false,
        sharedAcrossProcesses: false,
        retryDurability: false,
      },
      hydratedAt: "2026-01-01T00:00:00.000Z",
      transactionsApplied: 0,
      lastOperation: null,
      lastCheckpointAt: null,
    },
  };
  projector.recordEvent({
    type: "run_started",
    message: "MONO-1 slot=0",
    at: "2026-01-01T00:00:00.000Z",
  });
  projector.recordRunHistory({
    id: "history-1",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    state: issue.state,
    slotIndex: 0,
    agentKind: "codex",
    outcome: "success",
    turnCount: 3,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:05.000Z",
  });

  const snapshot = projector.snapshot({
    appStatus: "running",
    workflow,
    now: new Date("2026-01-01T00:00:05.000Z"),
    poll: {
      status: "idle",
      candidates: 1,
      eligible: 1,
      lastPollAt: "2026-01-01T00:00:00.000Z",
      nextPollAt: "2026-01-01T00:00:05.000Z",
      lastError: null,
    },
    orchestration,
    runIdForSlot: () => "run-1",
  });

  assert.equal(snapshot.workflowPath, workflow.path);
  assert.equal(snapshot.running[0]?.runId, "run-1");
  assert.equal(snapshot.running[0]?.issueIdentifier, "MONO-1");
  assert.equal(snapshot.reserving?.[0]?.slotIndex, 1);
  assert.equal(snapshot.retrying[0]?.issueIdentifier, "MONO-1");
  assert.equal(snapshot.usageTotals.secondsRunning, 6);
  assert.equal(snapshot.recentEvents[0]?.type, "run_started");
  assert.equal(snapshot.runHistory[0]?.id, "history-1");
});
