import fs from "node:fs/promises";
import path from "node:path";

import { beforeAll, test, vi } from "vitest";
import { acpExecutorProvider } from "@lorenz/acp";
import { defaultAgentExecutorRegistry } from "@lorenz/agent-sdk";
import {
  createDispatchCoordinator,
  createWorkspaceForIssue,
  listIssueWorkspaceIdentifiers,
  loadWorkflow,
  normalizeIssue,
  Orchestrator,
  parseConfig,
  removeIssueWorkspaces,
  runtimeAdapters,
  slotKey,
} from "@lorenz/cli";
import { registerLinearTracker } from "@lorenz/linear-tracker";
import {
  createState,
  InMemoryClaimStore,
  type ClaimStoreOperation,
  type OrchestratorState,
} from "@lorenz/orchestrator";
import {
  RUNTIME_EVENT_TYPES as RUNTIME_EVENT_TYPES_FROM_RUNTIME_EVENTS,
  RUNTIME_RUN_OUTCOMES as RUNTIME_RUN_OUTCOMES_FROM_RUNTIME_EVENTS,
} from "@lorenz/runtime-events";
import type {
  Issue,
  McpEndpointManager,
  RunResult,
  Settings,
  LorenzRuntimeOptions,
  WorkflowDefinition,
} from "@lorenz/cli";
import type { ClockPort, WorkerPoolSettings } from "@lorenz/domain";
import type { AgentMcpEndpointLease } from "@lorenz/mcp";
import type { AcquireResult, WorkerLease, WorkerOutcome, WorkerPool } from "@lorenz/worker-pool";
import { assert, settle, tempDir, writeExecutable } from "@lorenz/test-utils";

import {
  RUNTIME_EVENT_TYPES as RUNTIME_EVENT_TYPES_FROM_RUNTIME,
  RUNTIME_RUN_OUTCOMES as RUNTIME_RUN_OUTCOMES_FROM_RUNTIME,
  LorenzRuntime,
} from "@lorenz/runtime";
import type { RuntimeSnapshot } from "@lorenz/runtime";

// The runtime validates dispatch config against the process-default registries, which the
// CLI composition root populates before constructing a runtime. Mirror that wiring here (in
// a hook rather than at module scope) for the backends this suite dispatches on - the
// linear tracker and the ACP executor - so polling resolves the same providers as
// production.
beforeAll(() => {
  registerLinearTracker();
  if (defaultAgentExecutorRegistry.get(acpExecutorProvider.executor) === undefined) {
    defaultAgentExecutorRegistry.register(acpExecutorProvider);
  }
});

function runtimeOptions(options: LorenzRuntimeOptions): LorenzRuntimeOptions {
  // Startup cleanup scans the workspace root and consumes a fetchIssuesByIds call;
  // default it off so call-counting tests stay deterministic. Cleanup tests pass the
  // real lister explicitly.
  return { ...runtimeAdapters, listIssueWorkspaces: async () => [], ...options };
}

class CountingClaimStore extends InMemoryClaimStore {
  heartbeats = 0;

  heartbeatOwner(): void {
    this.heartbeats += 1;
  }
}

class FailingHeartbeatClaimStore extends InMemoryClaimStore {
  heartbeatOwner(): void {
    throw new Error("heartbeat failed");
  }
}

class FailingPeriodicHeartbeatClaimStore extends InMemoryClaimStore {
  heartbeats = 0;

  heartbeatOwner(): void {
    this.heartbeats += 1;
    if (this.heartbeats > 1) throw new Error("periodic heartbeat failed");
  }
}

class SnapshotFailingPeriodicHeartbeatClaimStore extends InMemoryClaimStore {
  heartbeats = 0;
  readFailures = 0;

  heartbeatOwner(): void {
    this.heartbeats += 1;
    if (this.heartbeats <= 1) return;
    this.readFailures = 1;
    throw new Error("periodic heartbeat failed");
  }

  override read<T>(run: (state: OrchestratorState) => T): T {
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error("snapshot failed");
    }
    return super.read(run);
  }
}

class FailingBindClaimStore extends InMemoryClaimStore {
  readFailures = 0;

  override transaction<T>(operation: ClaimStoreOperation, run: (state: OrchestratorState) => T): T {
    if (operation === "bind_reservation") {
      this.readFailures = 1;
      throw new Error("bind failed");
    }
    return super.transaction(operation, run);
  }

  override read<T>(run: (state: OrchestratorState) => T): T {
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error("snapshot failed after bind");
    }
    return super.read(run);
  }
}

class FailingCancelClaimStore extends CountingClaimStore {
  override transaction<T>(operation: ClaimStoreOperation, run: (state: OrchestratorState) => T): T {
    if (operation === "cancel_reservation") throw new Error("cancel failed");
    return super.transaction(operation, run);
  }
}

class RetrySyncFailingCancelClaimStore extends InMemoryClaimStore {
  readFailures = 0;

  override transaction<T>(operation: ClaimStoreOperation, run: (state: OrchestratorState) => T): T {
    const result = super.transaction(operation, run);
    if (operation === "cancel_reservation") this.readFailures = 1;
    return result;
  }

  override read<T>(run: (state: OrchestratorState) => T): T {
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error("manual snapshot failure");
    }
    return super.read(run);
  }
}

class LosingFinishClaimStore extends InMemoryClaimStore {
  override transaction<T>(operation: ClaimStoreOperation, run: (state: OrchestratorState) => T): T {
    if (operation === "finish") {
      this.state.running.clear();
      this.state.claimed.clear();
    }
    return super.transaction(operation, run);
  }
}

class FailingFinishClaimStore extends InMemoryClaimStore {
  override transaction<T>(operation: ClaimStoreOperation, run: (state: OrchestratorState) => T): T {
    if (operation === "finish") throw new Error("finish failed");
    return super.transaction(operation, run);
  }
}

class FailingApplyUpdateClaimStore extends InMemoryClaimStore {
  override transaction<T>(operation: ClaimStoreOperation, run: (state: OrchestratorState) => T): T {
    if (operation === "apply_update") throw new Error("apply update failed");
    return super.transaction(operation, run);
  }
}

class FailingCleanupClaimStore extends InMemoryClaimStore {
  override transaction<T>(operation: ClaimStoreOperation, run: (state: OrchestratorState) => T): T {
    if (operation === "cleanup_issue") throw new Error("cleanup failed");
    return super.transaction(operation, run);
  }
}

class SnapshotFailingAfterFinishClaimStore extends InMemoryClaimStore {
  readFailures = 0;

  override transaction<T>(operation: ClaimStoreOperation, run: (state: OrchestratorState) => T): T {
    const result = super.transaction(operation, run);
    if (operation === "finish") this.readFailures = 1;
    return result;
  }

  override read<T>(run: (state: OrchestratorState) => T): T {
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error("snapshot failed after finish");
    }
    return super.read(run);
  }
}

class SnapshotFailingAfterClaimStore extends InMemoryClaimStore {
  readFailures = 0;

  override transaction<T>(operation: ClaimStoreOperation, run: (state: OrchestratorState) => T): T {
    const result = super.transaction(operation, run);
    if (operation === "claim") this.readFailures = 1;
    return result;
  }

  override read<T>(run: (state: OrchestratorState) => T): T {
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error("snapshot failed after claim");
    }
    return super.read(run);
  }
}

class ManuallyFailingReadClaimStore extends InMemoryClaimStore {
  readFailures = 0;

  override read<T>(run: (state: OrchestratorState) => T): T {
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error("manual snapshot failure");
    }
    return super.read(run);
  }
}

class FailingAbandonClaimStore extends CountingClaimStore {
  override transaction<T>(operation: ClaimStoreOperation, run: (state: OrchestratorState) => T): T {
    if (operation === "abandon_claim") throw new Error("abandon failed");
    return super.transaction(operation, run);
  }
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

test("runtime exports canonical runtime-events vocabulary values", () => {
  assert.equal(RUNTIME_EVENT_TYPES_FROM_RUNTIME, RUNTIME_EVENT_TYPES_FROM_RUNTIME_EVENTS);
  assert.equal(RUNTIME_RUN_OUTCOMES_FROM_RUNTIME, RUNTIME_RUN_OUTCOMES_FROM_RUNTIME_EVENTS);
});

test("runtime accepts an injected claim store for the default orchestrator", () => {
  const store = new InMemoryClaimStore(createState(), {
    ownerId: "runtime-claim-store",
    hydratedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      claimStore: store,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  assert.deepEqual(runtime.snapshot().claimStore, {
    kind: "memory",
    ownerId: "runtime-claim-store",
    capabilities: {
      crashRecovery: false,
      sharedAcrossProcesses: false,
      retryDurability: false,
    },
    hydratedAt: "2026-01-01T00:00:00.000Z",
    transactionsApplied: 0,
    lastOperation: null,
    lastCheckpointAt: null,
  });
});

test("runtime abandons a claim when owner heartbeat startup fails before runner starts", async () => {
  const issue = issueFixture("issue-heartbeat-start-failure", "MT-HEARTBEAT-START-FAILURE");
  const store = new FailingHeartbeatClaimStore(createState(), {
    ownerId: "runtime-claim-store",
  });
  const workflow = workflowFixture();
  const clock = manualClock();
  const orchestrator = new Orchestrator(workflow.settings, clock, store);
  let runnerCalls = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      clock,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        return { workspace: "/tmp/lorenz/MT-HEARTBEAT-START-FAILURE", finalIssue: issue };
      },
    }),
  );

  await assert.rejects(() => runtime.pollOnce({ waitForRuns: true }), "heartbeat failed");

  assert.equal(runnerCalls, 0);
  assert.equal(orchestrator.snapshot().running.length, 0);
  assert.equal(orchestrator.snapshot().claimStore.lastOperation, "abandon_claim");
  assert.equal(runtime.snapshot().running.length, 0);
});

test("runtime abandons a claim when post-claim retry timer sync fails before runner starts", async () => {
  const issue = issueFixture("issue-post-claim-sync-failure", "MT-POST-CLAIM-SYNC-FAILURE");
  const store = new SnapshotFailingAfterClaimStore(createState(), {
    ownerId: "runtime-post-claim-sync-failure",
  });
  const workflow = workflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, store);
  let runnerCalls = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        return { workspace: "/tmp/lorenz/MT-POST-CLAIM-SYNC-FAILURE", finalIssue: issue };
      },
    }),
  );

  await assert.rejects(
    () => runtime.pollOnce({ waitForRuns: true }),
    /snapshot failed after claim/,
  );

  assert.equal(runnerCalls, 0);
  assert.equal(orchestrator.snapshot().running.length, 0);
  assert.equal(orchestrator.snapshot().claimStore.lastOperation, "abandon_claim");
  assert.equal(runtime.snapshot().running.length, 0);
});

test("runtime abandons a claim when pre-run dispatch notification fails", async () => {
  const issue = issueFixture("issue-dispatch-notification-failure", "MT-DISPATCH-NOTIFY-FAIL");
  const workflow = workflowFixture();
  const orchestrator = new Orchestrator(workflow.settings);
  let runnerCalls = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      onIssueDispatched: () => {
        throw new Error("dispatch notification failed");
      },
      runner: async () => {
        runnerCalls += 1;
        return { workspace: "/tmp/lorenz/MT-DISPATCH-NOTIFY-FAIL", finalIssue: issue };
      },
    }),
  );

  await assert.rejects(
    () => runtime.pollOnce({ waitForRuns: true }),
    /dispatch notification failed/,
  );

  assert.equal(runnerCalls, 0);
  assert.equal(orchestrator.snapshot().running.length, 0);
  assert.equal(orchestrator.snapshot().claimStore.lastOperation, "abandon_claim");
  assert.equal(runtime.snapshot().running.length, 0);
});

test("runtime records retry timer errors when the timer callback snapshot fails", async () => {
  const issue = issueFixture("issue-retry-timer-snapshot-failure", "MT-RETRY-TIMER-SNAPSHOT");
  const workflow = workflowFixture();
  workflow.settings.polling.intervalMs = 60_000;
  const clock = manualClock();
  const store = new ManuallyFailingReadClaimStore(createState(), {
    ownerId: "retry-timer-snapshot-failure",
  });
  const orchestrator = new Orchestrator(workflow.settings, clock, store);
  const dueAt = new Date(clock.now().getTime() + 10_000);
  orchestrator.state.retryAttempts.set(slotKey(issue.id, 0), {
    issueId: issue.id,
    identifier: issue.identifier,
    issueUrl: issue.url ?? null,
    attempt: 1,
    monotonicDeadlineMs: clock.monotonicMs() + 10_000,
    dueAtIso: dueAt.toISOString(),
    slotIndex: 0,
    workerHost: null,
    workspacePath: null,
    error: "previous failure",
  });
  let runnerCalls = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      clock,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        throw new Error("runner should not run before retry due");
      },
    }),
  );

  await runtime.pollOnce();
  store.readFailures = 1;
  clock.advance(10_000);
  clock.fireTimer();

  const snapshot = runtime.snapshot();
  assert.equal(runnerCalls, 0);
  assert.equal(snapshot.appStatus, "error");
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "retry_timer_error"),
    true,
  );
  assert.match(snapshot.poll.lastError ?? "", /manual snapshot failure/);
});

test("runtime records poll errors when poll-start snapshot emission fails", async () => {
  const workflow = workflowFixture();
  const store = new ManuallyFailingReadClaimStore(createState(), {
    ownerId: "poll-start-snapshot-failure",
  });
  const orchestrator = new Orchestrator(workflow.settings, undefined, store);
  let candidateFetches = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => {
          candidateFetches += 1;
          return [];
        },
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  store.readFailures = 1;
  await assert.rejects(() => runtime.pollOnce({ dryRun: true }), /manual snapshot failure/);

  const snapshot = runtime.snapshot();
  assert.equal(candidateFetches, 0);
  assert.equal(snapshot.appStatus, "error");
  assert.equal(snapshot.poll.status, "error");
  assert.match(snapshot.poll.lastError ?? "", /manual snapshot failure/);
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "poll_error"),
    true,
  );
});

test("runtime dry-run polls, computes eligibility, and does not start agents", async () => {
  const issue = issueFixture("issue-1", "MT-1");
  let runnerCalls = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        throw new Error("dry-run should not call runner");
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true, waitForRuns: true });

  const snapshot = runtime.snapshot();
  assert.equal(runnerCalls, 0);
  assert.equal(snapshot.poll.candidates, 1);
  assert.equal(snapshot.poll.eligible, 1);
  assert.equal(snapshot.recentEvents.at(-1)?.type, "dry_run");
});

test("runtime once claims an eligible issue, applies updates, and records completion", async () => {
  const issue = issueFixture("issue-1", "MT-1");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => {
          fetches += 1;
          return fetches === 1 ? [issue] : [doneIssue];
        },
      },
      runner: async ({ onUpdate }) => {
        onUpdate?.({
          type: "turn_completed",
          sessionId: "session-1",
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
        });
        return {
          workspace: "/tmp/lorenz/MT-1",
          turnCount: 1,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );
  let fetches = 0;

  await runtime.start({ once: true, dryRun: false });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.appStatus, "idle");
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.runHistory[0]?.issueIdentifier, "MT-1");
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(snapshot.usageTotals.totalTokens, 10);
});

test("runtime snapshot adds active elapsed seconds without mutating completion totals", async () => {
  const root = await tempDir("lorenz-runtime-active-runtime");
  const issue = issueFixture("issue-active-runtime", "MT-ACTIVE-RUNTIME");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workflowFixture(root);
  workflow.settings.logging.logFile = path.join(root, "lorenz.log");
  const clock = manualClock();
  const orchestrator = new Orchestrator(workflow.settings, clock);
  const limits = { model: "codex", primary: { used: 1, limit: 10, resetSeconds: 20 } };
  let finishRun!: () => void;
  const runCanFinish = new Promise<void>((resolve) => {
    finishRun = resolve;
  });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      clock,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ onUpdate }) => {
        onUpdate?.({
          type: "rate_limit",
          message: "rate limited by codex",
          rateLimits: limits,
        });
        await runCanFinish;
        return {
          workspace: "/tmp/lorenz/MT-ACTIVE-RUNTIME",
          turnCount: 1,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  try {
    await runtime.pollOnce();
    await waitFor(() => runtime.snapshot().running.length === 1, 1_000);
    await waitFor(() => runtime.snapshot().rateLimits === limits, 1_000);

    clock.advance(30_000);
    const firstActiveSnapshot = runtime.snapshot();
    const repeatedActiveSnapshot = runtime.snapshot();
    assert.equal(firstActiveSnapshot.usageTotals.secondsRunning, 30);
    assert.equal(repeatedActiveSnapshot.usageTotals.secondsRunning, 30);
    assert.equal(orchestrator.snapshot().usageTotals.secondsRunning, 0);
    assert.deepEqual(repeatedActiveSnapshot.rateLimits, limits);

    finishRun();
    await waitFor(() => runtime.snapshot().running.length === 0, 1_000);

    const finishedSnapshot = runtime.snapshot();
    assert.equal(finishedSnapshot.usageTotals.secondsRunning, 30);
    assert.equal(finishedSnapshot.runHistory[0]?.durationMs, 30_000);

    clock.advance(30_000);
    const laterSnapshot = runtime.snapshot();
    assert.equal(laterSnapshot.usageTotals.secondsRunning, 30);
    assert.equal(laterSnapshot.runHistory[0]?.durationMs, 30_000);
  } finally {
    runtime.stop();
  }
});

test("runtime snapshot keeps active elapsed seconds across workflow reloads", async () => {
  const root = await tempDir("lorenz-runtime-active-runtime-reload");
  const issue = issueFixture("issue-active-runtime-reload", "MT-ACTIVE-RUNTIME-RELOAD");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const reloadedPath = path.join(root, "WORKFLOW-after.md");
  const firstWorkflow = { ...workflowFixture(root), path: path.join(root, "WORKFLOW-before.md") };
  const secondWorkflow = { ...workflowFixture(root), path: reloadedPath };
  firstWorkflow.settings.logging.logFile = path.join(root, "lorenz.log");
  secondWorkflow.settings.logging.logFile = path.join(root, "lorenz.log");
  const clock = manualClock();
  const orchestrator = new Orchestrator(firstWorkflow.settings, clock);
  let reloads = 0;
  let finishRun!: () => void;
  const runCanFinish = new Promise<void>((resolve) => {
    finishRun = resolve;
  });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      clock,
      orchestrator,
      reloadWorkflow: async () => {
        reloads += 1;
        return reloads === 1 ? firstWorkflow : secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        await runCanFinish;
        return {
          workspace: "/tmp/lorenz/MT-ACTIVE-RUNTIME-RELOAD",
          turnCount: 1,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  try {
    await runtime.pollOnce();
    await waitFor(() => runtime.snapshot().running.length === 1, 1_000);

    clock.advance(12_000);
    await runtime.pollOnce({ dryRun: true });

    const reloadedSnapshot = runtime.snapshot();
    assert.equal(reloadedSnapshot.workflowPath, reloadedPath);
    assert.equal(reloadedSnapshot.usageTotals.secondsRunning, 12);

    finishRun();
    await waitFor(() => runtime.snapshot().running.length === 0, 1_000);
  } finally {
    runtime.stop();
  }
});

test("runtime does not record completion when claim ownership is lost before finish", async () => {
  const issue = issueFixture("issue-lost-before-finish", "MT-LOST-BEFORE-FINISH");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workflowFixture();
  const store = new LosingFinishClaimStore(createState(), { ownerId: "lost-before-finish" });
  const orchestrator = new Orchestrator(workflow.settings, undefined, store);
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/lorenz/MT-LOST-BEFORE-FINISH",
        turnCount: 1,
        updates: [],
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.runHistory.length, 0);
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "run_completed"),
    false,
  );
  assert.equal(
    snapshot.recentEvents.some((event) => event.message.includes("claim_lost_before_finish")),
    true,
  );
});

test("runtime does not record runner failure when durable finish fails after runner success", async () => {
  const issue = issueFixture("issue-finish-failure", "MT-FINISH-FAILURE");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workflowFixture();
  const store = new FailingFinishClaimStore(createState(), { ownerId: "finish-failure" });
  const orchestrator = new Orchestrator(workflow.settings, undefined, store);
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/lorenz/MT-FINISH-FAILURE",
        turnCount: 1,
        updates: [],
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.appStatus, "error");
  assert.match(snapshot.poll.lastError ?? "", /claim_finish_failed/);
  assert.equal(snapshot.runHistory.length, 0);
  assert.equal(snapshot.retrying.length, 0);
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "run_failed"),
    false,
  );
  assert.equal(
    snapshot.recentEvents.some((event) => event.message.includes("finish failed")),
    true,
  );
});

test("runtime records update persistence failures without treating them as agent failures", async () => {
  const root = await tempDir("lorenz-runtime-update-failure");
  const issue = issueFixture("issue-update-failure", "MT-UPDATE-FAILURE");
  const workflow = workflowFixture(root);
  const workspace = await createWorkspaceForIssue(workflow.settings, issue);
  const store = new FailingApplyUpdateClaimStore(createState(), {
    ownerId: "apply-update-failure",
  });
  const orchestrator = new Orchestrator(workflow.settings, undefined, store);
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ onUpdate }) => {
        onUpdate?.({
          type: "workspace_prepared",
          message: `workspace prepared at ${workspace}`,
          workspacePath: workspace,
        });
        return { workspace, finalIssue: issue };
      },
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.appStatus, "error");
  assert.match(snapshot.poll.lastError ?? "", /claim_update_failed/);
  assert.equal(snapshot.runHistory.length, 0);
  assert.equal(snapshot.retrying.length, 0);
  assert.equal(snapshot.running.length, 0);
  assert.equal(orchestrator.snapshot().claimStore.lastOperation, "abandon_claim");
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "run_failed"),
    false,
  );
  assert.equal(
    snapshot.recentEvents.some(
      (event) => event.type === "poll_error" && event.message.includes("apply update failed"),
    ),
    true,
  );
});

test("runtime keeps completed run history when retry timer sync fails after finish", async () => {
  const issue = issueFixture("issue-post-finish-snapshot-failure", "MT-POST-FINISH-SNAPSHOT");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workflowFixture();
  const store = new SnapshotFailingAfterFinishClaimStore(createState(), {
    ownerId: "post-finish-snapshot-failure",
  });
  const orchestrator = new Orchestrator(workflow.settings, undefined, store);
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/lorenz/MT-POST-FINISH-SNAPSHOT",
        turnCount: 1,
        updates: [],
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.appStatus, "error");
  assert.match(snapshot.poll.lastError ?? "", /retry_timer_sync_failed/);
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "run_completed"),
    true,
  );
  assert.equal(
    snapshot.recentEvents.some((event) => event.message.includes("snapshot failed after finish")),
    true,
  );
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "run_failed"),
    false,
  );
});

test("runtime does not record runner failure when a post-run pre-finish snapshot would fail", async () => {
  const issue = issueFixture("issue-post-run-snapshot-failure", "MT-POST-RUN-SNAPSHOT");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workflowFixture();
  const store = new ManuallyFailingReadClaimStore(createState(), {
    ownerId: "post-run-snapshot-failure",
  });
  const orchestrator = new Orchestrator(workflow.settings, undefined, store);
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        store.readFailures = 1;
        return {
          workspace: "/tmp/lorenz/MT-POST-RUN-SNAPSHOT",
          turnCount: 1,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.appStatus, "error");
  assert.match(snapshot.poll.lastError ?? "", /retry_timer_sync_failed/);
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "run_completed"),
    true,
  );
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "run_failed"),
    false,
  );
});

test("runtime finishes a failed run when a failure-path pre-finish snapshot would fail", async () => {
  const issue = issueFixture("issue-failure-path-snapshot-failure", "MT-FAILURE-SNAPSHOT");
  const workflow = workflowFixture();
  const store = new ManuallyFailingReadClaimStore(createState(), {
    ownerId: "failure-path-snapshot-failure",
  });
  const orchestrator = new Orchestrator(workflow.settings, undefined, store);
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        store.readFailures = 1;
        throw new Error("agent exited: boom");
      },
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.appStatus, "error");
  assert.match(snapshot.poll.lastError ?? "", /retry_timer_sync_failed/);
  assert.equal(snapshot.runHistory[0]?.outcome, "failed");
  assert.equal(snapshot.retrying[0]?.attempt, 1);
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "run_failed"),
    true,
  );
});

test("runtime schedules continuation retry after normal worker exit even when issue is inactive", async () => {
  const issue = issueFixture("issue-inactive-continuation", "MT-INACTIVE-CONTINUATION");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/lorenz/MT-INACTIVE-CONTINUATION",
        turnCount: 1,
        updates: [],
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  const beforeRun = Date.now();
  await runtime.pollOnce({ waitForRuns: true });

  const retry = runtime.snapshot().retrying[0];
  assert.ok(retry);
  assert.equal(retry.issueIdentifier, "MT-INACTIVE-CONTINUATION");
  assert.equal(retry.attempt, 1);
  const delayMs = new Date(retry.dueAtIso).getTime() - beforeRun;
  assert.ok(delayMs >= 900 && delayMs <= 1_500);
});

test("runtime refetches before dispatch and skips stale or missing issues", async () => {
  const staleIssue = issueFixture("issue-stale", "MT-STALE");
  const missingIssue = issueFixture("issue-missing", "MT-MISSING");
  const staleDoneIssue: Issue = { ...staleIssue, state: "Done", stateType: "completed" };
  let runnerCalls = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [staleIssue, missingIssue],
        fetchIssuesByIds: async (ids) => {
          if (ids.includes(staleIssue.id)) return [staleDoneIssue];
          return [];
        },
      },
      runner: async () => {
        runnerCalls += 1;
        throw new Error("stale candidates should not dispatch");
      },
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });

  const snapshot = runtime.snapshot();
  assert.equal(runnerCalls, 0);
  assert.equal(snapshot.runHistory.length, 0);
  assert.equal(
    snapshot.recentEvents.some((event) => event.message.includes("MT-STALE stale_before_dispatch")),
    true,
  );
  assert.equal(
    snapshot.recentEvents.some((event) =>
      event.message.includes("MT-MISSING missing_before_dispatch"),
    ),
    true,
  );
});

test("runtime reloads workflow settings on each poll with last-known-good fallback", async () => {
  const issue = issueFixture("issue-reload", "MT-RELOAD");
  const firstWorkflow = workflowFixture();
  const secondWorkflow = {
    ...workflowFixture(),
    settings: parseConfig({
      tracker: {
        kind: "linear",
        api_key: "linear-token",
        project_slug: "mono",
        active_states: ["Todo"],
        terminal_states: ["Done"],
        dispatch: { accept_unrouted: false },
      },
      polling: { interval_ms: 5 },
    }),
  };
  let reloads = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      reloadWorkflow: async () => {
        reloads += 1;
        if (reloads === 1) return secondWorkflow;
        throw new Error("workflow parse failed");
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        throw new Error("reload should make unrouted issue ineligible");
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });
  assert.equal(runtime.snapshot().poll.eligible, 0);
  assert.equal(runtime.workflow.settings.tracker.dispatch.acceptUnrouted, false);

  await runtime.pollOnce({ dryRun: true });
  assert.equal(reloads, 2);
  assert.equal(runtime.workflow.settings.tracker.dispatch.acceptUnrouted, false);
  assert.ok(
    runtime.snapshot().recentEvents.some((event) => event.type === "workflow_reload_failed"),
  );
});

test("runtime skips reload side effects when workflow content is unchanged", async () => {
  const issue = issueFixture("issue-unchanged-reload", "MT-UNCHANGED-RELOAD");
  const dir = await tempDir("lorenz-runtime-unchanged-workflow");
  const workflowFile = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowFile, workflowMarkdown({ intervalMs: 5 }));
  const workflow = await loadWorkflow(workflowFile, {}, { cwd: dir });
  let reloads = 0;
  let clientBuilds = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      reloadWorkflow: async () => {
        reloads += 1;
        return loadWorkflow(workflowFile, {}, { cwd: dir });
      },
      clientFactory: () => {
        clientBuilds += 1;
        return {
          fetchCandidateIssues: async () => [issue],
          fetchIssuesByIds: async () => [issue],
        };
      },
      runner: async () => {
        throw new Error("dry-run should not call runner");
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });
  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 0);
  assert.equal(clientBuilds, 1);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "workflow_reloaded"),
    false,
  );
});

test("runtime reloads stamped workflow when file content changes", async () => {
  const issue = issueFixture("issue-changed-reload", "MT-CHANGED-RELOAD");
  const dir = await tempDir("lorenz-runtime-changed-workflow");
  const workflowFile = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowFile, workflowMarkdown({ intervalMs: 5 }));
  const workflow = await loadWorkflow(workflowFile, {}, { cwd: dir });
  let reloads = 0;
  let clientBuilds = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      reloadWorkflow: async () => {
        reloads += 1;
        return loadWorkflow(workflowFile, {}, { cwd: dir });
      },
      clientFactory: () => {
        clientBuilds += 1;
        return {
          fetchCandidateIssues: async () => [issue],
          fetchIssuesByIds: async () => [issue],
        };
      },
      runner: async () => {
        throw new Error("dry-run should not call runner");
      },
    }),
  );

  await fs.writeFile(
    workflowFile,
    workflowMarkdown({ acceptUnrouted: false, intervalMs: 9, prompt: "Changed prompt" }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  assert.equal(clientBuilds, 2);
  assert.equal(runtime.workflow.promptTemplate, "Changed prompt");
  assert.equal(runtime.workflow.settings.polling.intervalMs, 9);
  assert.equal(runtime.snapshot().poll.eligible, 0);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "workflow_reloaded"),
    true,
  );
});

test("runtime preflights dispatch config before candidate fetches", async () => {
  const workflow = workflowFixture();
  workflow.settings.tracker.kind = undefined;
  let candidateFetches = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      client: {
        fetchCandidateIssues: async () => {
          candidateFetches += 1;
          return [];
        },
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  await assert.rejects(() => runtime.pollOnce({ dryRun: true }), /tracker.kind is required/);

  assert.equal(candidateFetches, 0);
  assert.equal(runtime.snapshot().poll.status, "error");
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.message.includes("tracker.kind")),
    true,
  );
});

test("runtime aborts in-flight runs when reconciliation sees a terminal issue", async () => {
  const issue = issueFixture("issue-abort", "MT-ABORT");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  let fetches = 0;
  let aborted = false;
  let started = false;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => {
          fetches += 1;
          return fetches === 1 ? [issue] : [doneIssue];
        },
      },
      runner: async ({ abortSignal }) => {
        started = true;
        await new Promise<void>((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    }),
  );

  await runtime.pollOnce();
  assert.equal(started, true);
  // The second pollOnce triggers reconciliation which detects the terminal issue
  // and aborts the in-flight run. The abort is async so we wait for it with a
  // generous timeout to avoid flakiness under CI load.
  await runtime.pollOnce({ dryRun: true });
  await waitFor(() => aborted, 2_000);

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.retrying.length, 0);
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "workspace_cleanup"),
    true,
  );
});

test("runtime keeps active runs when reconciliation cleanup persistence fails", async () => {
  const issue = issueFixture("issue-cleanup-failure", "MT-CLEANUP-FAILURE");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workflowFixture();
  const store = new FailingCleanupClaimStore(createState(), {
    ownerId: "cleanup-failure",
  });
  const orchestrator = new Orchestrator(workflow.settings, undefined, store);
  let fetches = 0;
  let aborted = false;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => {
          fetches += 1;
          return fetches === 1 ? [issue] : [doneIssue];
        },
      },
      runner: async ({ abortSignal }) => {
        await new Promise<void>((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    }),
  );

  try {
    await runtime.pollOnce();
    await runtime.pollOnce({ dryRun: true });

    const snapshot = runtime.snapshot();
    assert.equal(aborted, false);
    assert.equal(snapshot.appStatus, "error");
    assert.match(snapshot.poll.lastError ?? "", /claim_cleanup_failed/);
    assert.equal(snapshot.running.length, 1);
    assert.equal(orchestrator.snapshot().running.length, 1);
    assert.equal(
      snapshot.recentEvents.some(
        (event) => event.type === "poll_error" && event.message.includes("cleanup failed"),
      ),
      true,
    );
  } finally {
    runtime.stop();
  }
});

test("runtime aborts in-flight runs when reconciliation sees missing or unrouted issues", async () => {
  for (const mode of ["missing", "unrouted"] as const) {
    const root = await tempDir(`lorenz-runtime-${mode}-inert`);
    const issue = issueFixture(`issue-${mode}`, `MT-${mode.toUpperCase()}`);
    const settings =
      mode === "unrouted"
        ? parseConfig({
            tracker: {
              kind: "linear",
              api_key: "linear-token",
              project_slug: "mono",
              dispatch: { only_routes: ["backend"] },
              active_states: ["Todo"],
              terminal_states: ["Done"],
            },
            polling: { interval_ms: 5 },
            workspace: { root },
          })
        : workflowFixture(root).settings;
    const routedIssue = mode === "unrouted" ? { ...issue, labels: ["lorenz:backend"] } : issue;
    const staleIssue = mode === "unrouted" ? { ...issue, labels: ["lorenz:frontend"] } : null;
    const workspace = await createWorkspaceForIssue(settings, routedIssue);
    let fetches = 0;
    let aborted = false;
    const runtime = new LorenzRuntime(
      runtimeOptions({
        workflow: {
          path: "/tmp/WORKFLOW.md",
          config: {},
          promptTemplate: "Issue {{ issue.identifier }}",
          settings,
        },
        client: {
          fetchCandidateIssues: async () => [routedIssue],
          fetchIssuesByIds: async () => {
            fetches += 1;
            if (fetches === 1) return [routedIssue];
            return staleIssue ? [staleIssue] : [];
          },
        },
        runner: async ({ abortSignal }) => {
          await new Promise<void>((_resolve, reject) => {
            abortSignal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
          throw new Error("unreachable");
        },
      }),
    );

    try {
      await runtime.pollOnce();
      await runtime.pollOnce({ dryRun: true });
      await waitFor(() => aborted, 1_000);
      assert.equal(runtime.snapshot().running.length, 0);
      assert.equal(await fileExists(workspace), true);
      assert.equal(
        runtime.snapshot().recentEvents.some((event) => event.type === "workspace_cleanup"),
        false,
      );
      assert.equal(
        runtime.snapshot().recentEvents.some((event) => event.message.includes(mode)),
        true,
      );
    } finally {
      runtime.stop();
    }
  }
});

test("runtime keeps tracked work running when tracker refresh fails during reconciliation", async () => {
  const issue = issueFixture("issue-refresh-failure", "MT-REFRESH-FAILURE");
  const workflow = workflowFixture();
  const orchestrator = new Orchestrator(workflow.settings);
  assert.ok(orchestrator.claim(issue));
  let candidateFetches = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => {
          candidateFetches += 1;
          return [];
        },
        fetchIssuesByIds: async () => {
          throw new Error("tracker unavailable");
        },
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  const snapshot = runtime.snapshot();
  assert.equal(candidateFetches, 1);
  assert.equal(snapshot.poll.status, "idle");
  assert.equal(snapshot.poll.lastError, null);
  assert.equal(snapshot.running.length, 1);
  assert.equal(snapshot.running[0]?.issueIdentifier, "MT-REFRESH-FAILURE");
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "reconcile_refresh_failed"),
    true,
  );
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "poll_error"),
    false,
  );
});

test("runtime reconciles stalled runs from the orchestrator poll loop", async () => {
  const issue = issueFixture("issue-stalled", "MT-STALLED");
  const root = await tempDir("lorenz-runtime-stall");
  const workflow = workflowFixture(root);
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  const workspace = await createWorkspaceForIssue(workflow.settings, issue);
  const orchestrator = new Orchestrator(workflow.settings);
  let aborted = false;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal, onUpdate }) => {
        onUpdate?.({
          type: "workspace_prepared",
          message: `workspace prepared at ${workspace}`,
          workspacePath: workspace,
        });
        await new Promise<void>((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted by stall reconciliation"));
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    }),
  );

  try {
    await runtime.pollOnce();
    const running = orchestrator.snapshot().running[0];
    assert.ok(running);
    running.lastAgentTimestamp = new Date(Date.now() - 1_000);

    await runtime.pollOnce({ dryRun: true });
    await waitFor(() => aborted, 1_000);

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.running.length, 0);
    assert.equal(snapshot.runHistory[0]?.outcome, "stalled");
    assert.equal(snapshot.retrying[0]?.attempt, 1);
    assert.ok(snapshot.recentEvents.some((event) => event.type === "run_stalled"));
  } finally {
    runtime.stop();
  }
});

test("runtime stall reconciliation uses agents-level stall timeout defaults", async () => {
  const issue = issueFixture("issue-agents-stall", "MT-AGENTS-STALL");
  const root = await tempDir("lorenz-runtime-agents-stall");
  const settings = parseConfig({
    tracker: {
      kind: "linear",
      api_key: "linear-token",
      project_slug: "mono",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 5 },
    workspace: { root },
    agents: { stall_timeout_ms: 50 },
  });
  assert.equal(settings.agents.codex.stallTimeoutMs, 50);
  const workflow: WorkflowDefinition = {
    path: "/tmp/WORKFLOW.md",
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };
  const workspace = await createWorkspaceForIssue(workflow.settings, issue);
  const orchestrator = new Orchestrator(workflow.settings);
  let aborted = false;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal, onUpdate }) => {
        onUpdate?.({
          type: "workspace_prepared",
          message: `workspace prepared at ${workspace}`,
          workspacePath: workspace,
        });
        await new Promise<void>((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted by agents-level stall timeout"));
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    }),
  );

  try {
    await runtime.pollOnce();
    const running = orchestrator.snapshot().running[0];
    assert.ok(running);
    running.lastAgentTimestamp = new Date(Date.now() - 1_000);

    await runtime.pollOnce({ dryRun: true });
    await waitFor(() => aborted, 1_000);

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.running.length, 0);
    assert.equal(snapshot.runHistory[0]?.outcome, "stalled");
  } finally {
    runtime.stop();
  }
});

test("runtime stalled reconciliation does not record a stalled run when durable finish fails", async () => {
  const issue = issueFixture("issue-stall-finish-failure", "MT-STALL-FINISH-FAILURE");
  const workflow = workflowFixture();
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  const store = new FailingFinishClaimStore(createState(), { ownerId: "stall-finish-failure" });
  const orchestrator = new Orchestrator(workflow.settings, undefined, store);
  assert.ok(orchestrator.claim(issue));
  const running = orchestrator.snapshot().running[0];
  assert.ok(running);
  running.lastAgentTimestamp = new Date(Date.now() - 1_000);
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.appStatus, "error");
  assert.match(snapshot.poll.lastError ?? "", /claim_finish_failed/);
  assert.equal(snapshot.runHistory.length, 0);
  assert.equal(snapshot.running.length, 1);
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "run_stalled"),
    false,
  );
});

// This test modifies process.env.PATH to inject a fake ssh binary. It restores PATH in
// the finally block and must run serially because process.env is process-wide.
test("runtime does not stall a stale ensemble slot snapshot after its runner completes", async () => {
  const issue = issueFixture("issue-ensemble-stall-race", "MT-ENSEMBLE-RACE");
  const root = await tempDir("lorenz-runtime-ensemble-stall-race");
  const workflow = workflowFixture(root);
  workflow.settings.agent.ensembleSize = 2;
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  workflow.settings.worker.sshTimeoutMs = 2_000;
  const orchestrator = new Orchestrator(workflow.settings);
  const controls = new Map<
    number,
    {
      resolve: (value: RunResult) => void;
      reject: (error: Error) => void;
    }
  >();
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal, onUpdate, slotIndex }) => {
        const slot = slotIndex ?? 0;
        const workspace = path.join(root, `workspace-${slot}`);
        onUpdate?.({
          type: "workspace_prepared",
          message: `workspace prepared at ${workspace}`,
          workspacePath: workspace,
        });
        return await new Promise<RunResult>((resolve, reject) => {
          controls.set(slot, { resolve, reject });
          abortSignal?.addEventListener("abort", () => reject(new Error(`aborted slot ${slot}`)), {
            once: true,
          });
        });
      },
    }),
  );
  const fakeBin = path.join(root, "bin");
  const originalPath = process.env.PATH;
  await writeExecutable(
    path.join(fakeBin, "ssh"),
    [
      "#!/bin/sh",
      'args="$*"',
      'case "$args" in',
      "*rev-parse*) sleep 0.15; printf '.git\\n'; exit 0 ;;",
      "*rm\\ -f*) sleep 0.05; exit 0 ;;",
      "*) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
  );

  try {
    await runtime.pollOnce();
    await runtime.pollOnce();
    await waitFor(() => controls.size === 2, 2_000);

    const entries = orchestrator.snapshot().running;
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      entry.lastAgentTimestamp = new Date(Date.now() - 1_000);
    }
    const firstSlot = entries.find((entry) => entry.slotIndex === 0);
    assert.ok(firstSlot);
    firstSlot.workerHost = "worker-01";
    firstSlot.workspacePath = "/remote/workspace-0";

    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    const stallPoll = runtime.pollOnce({ dryRun: true });
    controls.get(1)?.resolve({
      workspace: path.join(root, "workspace-1"),
      turnCount: 1,
      updates: [],
      agentKind: "codex",
      finalIssue: { ...issue, state: { name: "Todo", type: "unstarted" } },
    });
    await stallPoll;
    await waitFor(
      () => runtime.snapshot().runHistory.some((entry) => entry.slotIndex === 1),
      2_000,
    );

    const snapshot = runtime.snapshot();
    assert.deepEqual(
      snapshot.runHistory.filter((entry) => entry.slotIndex === 1).map((entry) => entry.outcome),
      ["success"],
    );
    assert.deepEqual(
      snapshot.runHistory
        .filter((entry) => entry.outcome === "stalled")
        .map((entry) => entry.slotIndex),
      [0],
    );
  } finally {
    process.env.PATH = originalPath;
    runtime.stop();
  }
});
test("runtime does not record late success after stall reconciliation wins", async () => {
  const issue = issueFixture("issue-late-success", "MT-LATE-SUCCESS");
  const workflow = workflowFixture();
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  const orchestrator = new Orchestrator(workflow.settings);
  let aborted = false;
  const runControl: { resolve?: (value: any) => void } = {};
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal }) => {
        abortSignal?.addEventListener("abort", () => {
          aborted = true;
        });
        return await new Promise((resolve) => {
          runControl.resolve = resolve;
        });
      },
    }),
  );

  try {
    await runtime.pollOnce();
    const running = orchestrator.snapshot().running[0];
    assert.ok(running);
    running.lastAgentTimestamp = new Date(Date.now() - 1_000);

    await runtime.pollOnce({ dryRun: true });
    assert.equal(aborted, true);
    assert.equal(runtime.snapshot().runHistory[0]?.outcome, "stalled");

    const completeRun = runControl.resolve;
    assert.ok(completeRun);
    const completeIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
    completeRun({
      workspace: "/tmp/lorenz/MT-LATE-SUCCESS",
      turnCount: 1,
      updates: [],
      agentKind: "codex",
      finalIssue: completeIssue,
    });
    await vi.waitFor(() => {
      const snapshot = runtime.snapshot();
      assert.equal(snapshot.runHistory.length, 1);
      assert.equal(snapshot.runHistory[0]?.outcome, "stalled");
    });
  } finally {
    runtime.stop();
  }
});

test("runtime keeps a retry handle active when a stalled generation finishes late", async () => {
  const issue = issueFixture("issue-stale-finally", "MT-STALE-FINALLY");
  const root = await tempDir("lorenz-runtime-stale-finally");
  const workflow = workflowFixture(root);
  workflow.settings.agent.maxRetryBackoffMs = 0;
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  const orchestrator = new Orchestrator(workflow.settings);
  let attempts = 0;
  const abortedAttempts = new Set<number>();
  const controls = new Map<number, { resolve: (value: RunResult) => void }>();
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal, onUpdate }) => {
        attempts += 1;
        const attempt = attempts;
        onUpdate?.({
          type: "workspace_prepared",
          message: `workspace prepared at ${path.join(root, `workspace-${attempt}`)}`,
          workspacePath: path.join(root, `workspace-${attempt}`),
        });
        abortSignal?.addEventListener("abort", () => {
          abortedAttempts.add(attempt);
        });
        return await new Promise<RunResult>((resolve) => {
          controls.set(attempt, { resolve });
        });
      },
    }),
  );

  try {
    await runtime.pollOnce();
    assert.equal(attempts, 1);
    const firstEntry = orchestrator.snapshot().running[0];
    assert.ok(firstEntry);
    firstEntry.lastAgentTimestamp = new Date(Date.now() - 1_000);

    await runtime.pollOnce({ dryRun: true });
    assert.equal(runtime.snapshot().runHistory[0]?.outcome, "stalled");
    assert.equal(abortedAttempts.has(1), true);

    await runtime.pollOnce();
    await waitFor(() => attempts === 2, 1_000);
    assert.equal(runtime.snapshot().running[0]?.runId, "run-2");

    controls.get(1)?.resolve({
      workspace: path.join(root, "workspace-1"),
      turnCount: 1,
      updates: [],
      agentKind: "codex",
      finalIssue: issue,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.running[0]?.runId, "run-2");
    assert.deepEqual(
      snapshot.runHistory.map((entry) => entry.outcome),
      ["stalled"],
    );
  } finally {
    runtime.stop();
  }
});

test("runtime coalesces overlapping pollOnce calls", async () => {
  const fetchControl: { release?: () => void } = {};
  let fetches = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => {
          fetches += 1;
          await new Promise<void>((resolve) => {
            fetchControl.release = resolve;
          });
          return [];
        },
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  const first = runtime.pollOnce({ dryRun: true });
  await waitFor(() => fetches === 1, 1_000);
  const second = runtime.pollOnce({ dryRun: true });
  await vi.waitFor(() => assert.equal(fetches, 1));

  const unblockFetch = fetchControl.release;
  assert.ok(unblockFetch);
  unblockFetch();
  await Promise.all([first, second]);
});

test("runtime preserves stronger overlapping pollOnce dispatch intent", async () => {
  const issue = issueFixture("issue-overlap-dispatch", "MT-OVERLAP-DISPATCH");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const fetchControl: { release?: () => void } = {};
  let fetches = 0;
  let runnerCalls = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => {
          fetches += 1;
          if (fetches === 1) {
            await new Promise<void>((resolve) => {
              fetchControl.release = resolve;
            });
          }
          return [issue];
        },
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        return {
          workspace: "/tmp/lorenz/MT-OVERLAP-DISPATCH",
          turnCount: 1,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  try {
    const first = runtime.pollOnce({ dryRun: true });
    await waitFor(() => fetches === 1, 1_000);
    const second = runtime.pollOnce({ waitForRuns: true });
    await vi.waitFor(() => assert.equal(fetches, 1));

    const unblockFetch = fetchControl.release;
    assert.ok(unblockFetch);
    unblockFetch();
    await Promise.all([first, second]);

    assert.equal(fetches, 2);
    assert.equal(runnerCalls, 1);
  } finally {
    runtime.stop();
  }
});

test("runtime keeps polling after a candidate fetch throws in the recurring loop", async () => {
  let fetches = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => {
          fetches += 1;
          if (fetches === 1) throw new Error("tracker fetch failed");
          return [];
        },
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  void runtime.start({ once: false });
  try {
    await waitFor(() => fetches >= 2, 1_000);
    const snapshot = runtime.snapshot();
    assert.ok(fetches >= 2);
    assert.ok(
      snapshot.recentEvents.some(
        (event) => event.type === "poll_error" && event.message.includes("tracker fetch failed"),
      ),
    );
  } finally {
    runtime.stop();
  }
});

function pushWorkflowFixture(): WorkflowDefinition {
  // A long poll interval isolates the push path: the recurring loop polls once then sleeps, so a
  // second fetch within the test window can only come from a watch() nudge.
  const settings = parseConfig({
    tracker: {
      kind: "linear",
      api_key: "linear-token",
      project_slug: "mono",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 600_000 },
    workspace: { root: "/tmp/lorenz-runtime-test" },
  });
  return { path: "/tmp/WORKFLOW.md", config: {}, promptTemplate: "x", settings };
}

test("a tracker push nudges an immediate poll between intervals", async () => {
  let fetches = 0;
  let captured: (() => void) | null = null;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: pushWorkflowFixture(),
      client: {
        fetchCandidateIssues: async () => {
          fetches += 1;
          return [];
        },
        fetchIssuesByIds: async () => [],
        watch: (onChange) => {
          captured = onChange;
          return { close: () => {} };
        },
      },
    }),
  );

  void runtime.start({ once: false });
  try {
    await waitFor(() => captured !== null && fetches >= 1, 1_000);
    const before = fetches;
    // Simulate a Slack Socket Mode event: the runtime must re-poll without waiting out the
    // (10-minute) interval.
    captured!();
    await waitFor(() => fetches > before, 1_000);
    const snapshot = runtime.snapshot();
    assert.ok(snapshot.recentEvents.some((event) => event.type === "tracker_watch_started"));
    assert.ok(snapshot.recentEvents.some((event) => event.type === "tracker_push"));
  } finally {
    runtime.stop();
  }
});

test("the runtime closes the tracker change stream on stop", async () => {
  let closed = false;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: pushWorkflowFixture(),
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [],
        watch: () => ({
          close: () => {
            closed = true;
          },
        }),
      },
    }),
  );

  void runtime.start({ once: false });
  try {
    await waitFor(
      () => runtime.snapshot().recentEvents.some((event) => event.type === "tracker_watch_started"),
      1_000,
    );
  } finally {
    runtime.stop();
  }
  await waitFor(() => closed, 1_000);
});

test("a tracker without watch() polls on the interval alone (no push events)", async () => {
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  void runtime.start({ once: false });
  try {
    await waitFor(() => runtime.snapshot().poll.lastPollAt !== null, 1_000);
    const snapshot = runtime.snapshot();
    assert.ok(!snapshot.recentEvents.some((event) => event.type === "tracker_watch_started"));
    assert.ok(!snapshot.recentEvents.some((event) => event.type === "tracker_push"));
  } finally {
    runtime.stop();
  }
});

test("runtime stop does not record an in-flight run as a failure", async () => {
  const issue = issueFixture("issue-stop", "MT-STOP");
  const orchestrator = new Orchestrator(workflowFixture().settings);
  let aborted = false;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      // Mirror the real runner: a stop()-triggered abort rejects the in-flight turn.
      runner: async ({ abortSignal }) =>
        await new Promise<RunResult>((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("agent_run_aborted"));
            },
            { once: true },
          );
        }),
    }),
  );

  await runtime.pollOnce();
  await waitFor(() => orchestrator.snapshot().running.length === 1, 1_000);

  // Ctrl+C path: stop() aborts the in-flight run, then settlement abandons the
  // local claim without recording a run failure.
  runtime.stop();
  await waitFor(() => aborted, 1_000);
  // Let the runner's rejection propagate through runClaim's catch.
  await new Promise<void>((resolve) => setImmediate(resolve));

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.running.length, 0);
  assert.equal(
    snapshot.runHistory.some((entry) => entry.outcome === "failed"),
    false,
  );
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "run_failed"),
    false,
  );
});

test("runtime stop keeps a claim owned until the runner settles", async () => {
  const issue = issueFixture("issue-stop-settlement", "MT-STOP-SETTLEMENT");
  const orchestrator = new Orchestrator(workflowFixture().settings);
  let aborted = false;
  let settleRunner: ((result: RunResult) => void) | undefined;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal }) =>
        await new Promise<RunResult>((resolve) => {
          settleRunner = resolve;
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
        }),
    }),
  );

  await runtime.pollOnce();
  await waitFor(() => orchestrator.snapshot().running.length === 1, 1_000);

  runtime.stop();
  await waitFor(() => aborted, 1_000);
  assert.equal(orchestrator.snapshot().running.length, 1);

  settleRunner?.({
    workspace: "/tmp/lorenz/MT-STOP-SETTLEMENT",
    turnCount: 1,
    updates: [],
    agentKind: "codex",
  });
  await waitFor(() => orchestrator.snapshot().running.length === 0, 1_000);
});

test("runtime stop keeps claim owner heartbeat alive until stopped claim settles", async () => {
  const issue = issueFixture("issue-stop-heartbeat", "MT-STOP-HEARTBEAT");
  const workflow = workflowFixture();
  const clock = manualClock();
  const store = new CountingClaimStore(createState(), { ownerId: "runtime-stop-heartbeat" });
  const orchestrator = new Orchestrator(workflow.settings, clock, store);
  let aborted = false;
  let settleRunner: ((result: RunResult) => void) | undefined;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      clock,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal }) =>
        await new Promise<RunResult>((resolve) => {
          settleRunner = resolve;
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
        }),
    }),
  );

  await runtime.pollOnce();
  await waitFor(() => orchestrator.snapshot().running.length === 1, 1_000);
  assert.equal(store.heartbeats, 1);

  runtime.stop();
  await waitFor(() => aborted, 1_000);
  assert.equal(orchestrator.snapshot().running.length, 1);

  clock.advance(10_000);
  clock.fireTimer();
  assert.equal(store.heartbeats, 2);

  settleRunner?.({
    workspace: "/tmp/lorenz/MT-STOP-HEARTBEAT",
    turnCount: 1,
    updates: [],
    agentKind: "codex",
  });
  await waitFor(() => orchestrator.snapshot().running.length === 0, 1_000);

  clock.advance(10_000);
  clock.fireTimer();
  assert.equal(store.heartbeats, 2);
});

test("runtime stop settlement records abandon failures without stranding heartbeat cleanup", async () => {
  const issue = issueFixture("issue-stop-abandon-failure", "MT-STOP-ABANDON-FAILURE");
  const workflow = workflowFixture();
  const clock = manualClock();
  const store = new FailingAbandonClaimStore(createState(), {
    ownerId: "runtime-stop-abandon-failure",
  });
  const orchestrator = new Orchestrator(workflow.settings, clock, store);
  let aborted = false;
  let settleRunner: ((result: RunResult) => void) | undefined;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      clock,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal }) =>
        await new Promise<RunResult>((resolve) => {
          settleRunner = resolve;
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
        }),
    }),
  );

  await runtime.pollOnce();
  await waitFor(() => orchestrator.snapshot().running.length === 1, 1_000);
  assert.equal(store.heartbeats, 1);

  runtime.stop();
  await waitFor(() => aborted, 1_000);

  settleRunner?.({
    workspace: "/tmp/lorenz/MT-STOP-ABANDON-FAILURE",
    turnCount: 1,
    updates: [],
    agentKind: "codex",
  });
  await waitFor(() => runtime.snapshot().appStatus === "error", 1_000);

  assert.match(runtime.snapshot().poll.lastError ?? "", /claim_abandon_failed/);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.message.includes("abandon failed")),
    true,
  );

  clock.advance(10_000);
  clock.fireTimer();
  assert.equal(store.heartbeats, 1);
});

test("runtime aborts active claims when periodic owner heartbeat fails", async () => {
  const issue = issueFixture("issue-periodic-heartbeat-failure", "MT-PERIODIC-HEARTBEAT-FAILURE");
  const workflow = workflowFixture();
  const clock = manualClock();
  const store = new FailingPeriodicHeartbeatClaimStore(createState(), {
    ownerId: "runtime-periodic-heartbeat",
  });
  const orchestrator = new Orchestrator(workflow.settings, clock, store);
  let aborted = false;
  let settleRunner: ((result: RunResult) => void) | undefined;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      clock,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal }) =>
        await new Promise<RunResult>((resolve) => {
          settleRunner = resolve;
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
        }),
    }),
  );

  try {
    await runtime.pollOnce();
    await waitFor(() => orchestrator.snapshot().running.length === 1, 1_000);
    assert.equal(store.heartbeats, 1);

    clock.advance(10_000);
    clock.fireTimer();
    await settle(0);
    assert.equal(store.heartbeats, 2);
    assert.equal(aborted, true);
    assert.equal(orchestrator.snapshot().running.length, 1);
    assert.equal(runtime.snapshot().appStatus, "error");
    assert.match(runtime.snapshot().poll.lastError ?? "", /claim_owner_heartbeat_failed/);
  } finally {
    settleRunner?.({
      workspace: "/tmp/lorenz/MT-PERIODIC-HEARTBEAT-FAILURE",
      turnCount: 1,
      updates: [],
      agentKind: "codex",
    });
    await waitFor(() => orchestrator.snapshot().running.length === 0, 1_000);
    assert.equal(runtime.snapshot().appStatus, "error");
    assert.match(runtime.snapshot().poll.lastError ?? "", /claim_owner_heartbeat_failed/);
    clock.advance(10_000);
    clock.fireTimer();
    assert.equal(store.heartbeats, 2);
  }
});

test("runtime heartbeat failure aborts active claims when failure-event snapshotting fails", async () => {
  const issue = issueFixture("issue-heartbeat-snapshot-failure", "MT-HEARTBEAT-SNAPSHOT-FAILURE");
  const workflow = workflowFixture();
  const clock = manualClock();
  const store = new SnapshotFailingPeriodicHeartbeatClaimStore(createState(), {
    ownerId: "runtime-heartbeat-snapshot-failure",
  });
  const orchestrator = new Orchestrator(workflow.settings, clock, store);
  let aborted = false;
  let settleRunner: ((result: RunResult) => void) | undefined;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      clock,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal }) =>
        await new Promise<RunResult>((resolve) => {
          settleRunner = resolve;
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
        }),
    }),
  );

  try {
    await runtime.pollOnce();
    await waitFor(() => orchestrator.snapshot().running.length === 1, 1_000);

    clock.advance(10_000);
    clock.fireTimer();
    await settle(0);

    assert.equal(aborted, true);
    assert.equal(runtime.snapshot().appStatus, "error");
    assert.match(runtime.snapshot().poll.lastError ?? "", /claim_owner_heartbeat_failed/);
  } finally {
    settleRunner?.({
      workspace: "/tmp/lorenz/MT-HEARTBEAT-SNAPSHOT-FAILURE",
      turnCount: 1,
      updates: [],
      agentKind: "codex",
    });
    await waitFor(() => orchestrator.snapshot().running.length === 0, 1_000);
  }
});

test("runtime appends operational events to the configured log file", async () => {
  const root = await tempDir("lorenz-runtime-event-log");
  const workflow = workflowFixture(root);
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });
  await waitFor(
    async () => (await fileText(workflow.settings.logging.logFile)).includes("dry_run"),
    1_000,
  );

  const logText = await fs.readFile(workflow.settings.logging.logFile, "utf8");
  assert.match(logText, /"event":"dry_run"/);
});

test("runtime reconciliation removes terminal retry workspaces before polling", async () => {
  const root = await tempDir("lorenz-runtime-cleanup");
  const workflow = workflowFixture(root);
  const activeIssue = issueFixture("issue-cleanup", "MT-CLEANUP");
  const doneIssue: Issue = { ...activeIssue, state: "Done", stateType: "completed" };
  const workspace = await createWorkspaceForIssue(workflow.settings, activeIssue);
  await fs.writeFile(path.join(workspace, "scratch.txt"), "remove me\n");

  const orchestrator = new Orchestrator(workflow.settings);
  assert.ok(orchestrator.claim(activeIssue));
  orchestrator.finish(activeIssue.id, 0, true);
  const cleanupIssues: Array<Issue | undefined> = [];

  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async (ids) => (ids.includes(activeIssue.id) ? [doneIssue] : []),
      },
      removeIssueWorkspaces: async (settings, identifier, workerHost, issue) => {
        cleanupIssues.push(issue);
        await removeIssueWorkspaces(settings, identifier, workerHost, issue);
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(orchestrator.snapshot().retrying.length, 0);
  await assert.rejects(() => fs.stat(workspace), /ENOENT/);
  assert.equal(cleanupIssues[0]?.id, doneIssue.id);
  assert.equal(runtime.snapshot().recentEvents[0]?.type, "dry_run");
  assert.ok(runtime.snapshot().recentEvents.some((event) => event.type === "workspace_cleanup"));
});

test("runtime reconciliation preserves retry metadata for active issues routed to another worker", async () => {
  const root = await tempDir("lorenz-runtime-routed-retry");
  const settings = parseConfig({
    tracker: {
      kind: "linear",
      api_key: "linear-token",
      project_slug: "mono",
      dispatch: { only_routes: ["backend"] },
      active_states: ["Todo"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 5 },
    workspace: { root },
  });
  const workflow: WorkflowDefinition = {
    path: "/tmp/WORKFLOW.md",
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };
  const retryIssue = {
    ...issueFixture("issue-routed-retry", "MT-ROUTED-RETRY"),
    labels: ["symphony:frontend"],
  };
  const now = Date.now();
  const orchestrator = new Orchestrator(settings);
  orchestrator.state.retryAttempts.set(slotKey(retryIssue.id, 0), {
    issueId: retryIssue.id,
    identifier: retryIssue.identifier,
    issueUrl: retryIssue.url ?? null,
    attempt: 2,
    monotonicDeadlineMs: now - 1,
    dueAtIso: new Date(now - 1).toISOString(),
    slotIndex: 0,
    workerHost: "worker-a",
    workspacePath: "/tmp/lorenz/MT-ROUTED-RETRY",
    error: "previous run failed",
  });

  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async (ids) => (ids.includes(retryIssue.id) ? [retryIssue] : []),
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  const retry = orchestrator.snapshot().retrying[0];
  assert.equal(retry?.issueId, retryIssue.id);
  assert.equal(retry?.attempt, 2);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "run_reconciled"),
    false,
  );
});

test("runtime reconcile refreshes the running stage when the tracker state changes", async () => {
  const workflow = workflowFixture();
  const orchestrator = new Orchestrator(workflow.settings);
  assert.ok(orchestrator.claim(issueFixture("issue-1", "MT-1")));

  const moved: Issue = { ...issueFixture("issue-1", "MT-1"), state: "In Progress" };
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [moved],
      },
    }),
  );

  assert.equal(runtime.snapshot().running[0]?.state, "Todo");

  await runtime.pollOnce({ dryRun: true });

  assert.equal(runtime.snapshot().running[0]?.state, "In Progress");
});

test("runtime startup cleanup looks up only on-disk workspaces and removes terminal ones", async () => {
  const root = await tempDir("lorenz-runtime-startup-cleanup");
  const workflow = workflowFixture(root);
  const doneIssue: Issue = {
    ...issueFixture("issue-startup-done", "MT-STARTUP-DONE"),
    state: "Done",
    stateType: "completed",
  };
  const activeIssue = issueFixture("issue-startup-active", "MT-STARTUP-ACTIVE");
  const doneWorkspace = await createWorkspaceForIssue(workflow.settings, doneIssue);
  await fs.writeFile(path.join(doneWorkspace, "scratch.txt"), "remove me\n");
  const activeWorkspace = await createWorkspaceForIssue(workflow.settings, activeIssue);
  const lookups: string[][] = [];

  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      listIssueWorkspaces: listIssueWorkspaceIdentifiers,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async (ids) => {
          lookups.push([...ids].sort());
          return [doneIssue, activeIssue];
        },
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });
  await assert.rejects(() => fs.stat(doneWorkspace), /ENOENT/);
  await fs.stat(activeWorkspace);
  assert.deepEqual(lookups, [["MT-STARTUP-ACTIVE", "MT-STARTUP-DONE"]]);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "startup_workspace_cleanup"),
    true,
  );

  await runtime.pollOnce({ dryRun: true });
  assert.equal(lookups.length, 1);
});

test("runtime startup cleanup skips the tracker entirely when no workspaces exist", async () => {
  const root = await tempDir("lorenz-runtime-startup-cleanup-empty");
  let lookups = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(root),
      listIssueWorkspaces: listIssueWorkspaceIdentifiers,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => {
          lookups += 1;
          return [];
        },
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });
  assert.equal(lookups, 0);
});

test("runtime treats startup cleanup lookup failures as non-fatal", async () => {
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      listIssueWorkspaces: async () => ["MT-STALE"],
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => {
          throw new Error("tracker unavailable");
        },
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });
  assert.equal(
    runtime
      .snapshot()
      .recentEvents.some((event) => event.type === "startup_workspace_cleanup_failed"),
    true,
  );
});

test("runtime records failed attempts as retryable work and keeps polling", async () => {
  const issue = issueFixture("issue-retryable", "MT-RETRYABLE");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workflowFixture();
  const orchestrator = new Orchestrator(workflow.settings);
  let attempts = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => (attempts >= 2 ? [doneIssue] : [issue]),
      },
      runner: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("agent exited: boom");
        return {
          workspace: "/tmp/lorenz/MT-RETRYABLE",
          turnCount: 1,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });
  let snapshot = runtime.snapshot();
  assert.equal(snapshot.appStatus, "idle");
  assert.equal(snapshot.runHistory[0]?.outcome, "failed");
  assert.equal(snapshot.retrying[0]?.attempt, 1);
  assert.equal(snapshot.retrying[0]?.error, "agent exited: boom");

  const retry = orchestrator.state.retryAttempts.get(slotKey(issue.id, 0));
  assert.ok(retry);
  retry.dueAtIso = new Date(Date.now() - 1).toISOString();
  retry.monotonicDeadlineMs = 0;
  await runtime.pollOnce({ waitForRuns: true });
  snapshot = runtime.snapshot();
  assert.equal(attempts, 2);
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(snapshot.retrying[0]?.attempt, 1);

  await runtime.pollOnce({ waitForRuns: true });
  snapshot = runtime.snapshot();
  assert.equal(snapshot.retrying.length, 0);
});

test("runtime schedules retry refresh timers independently of the poll cadence", async () => {
  const issue = issueFixture("issue-timer-retry", "MT-TIMER");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workflowFixture();
  workflow.settings.polling.intervalMs = 60_000;
  workflow.settings.agent.maxRetryBackoffMs = 500;
  let attempts = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => (attempts >= 2 ? [doneIssue] : [issue]),
      },
      runner: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("agent exited: retry me");
        return {
          workspace: "/tmp/lorenz/MT-TIMER",
          turnCount: 1,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });
  assert.equal(attempts, 1);
  assert.equal(runtime.snapshot().retrying[0]?.attempt, 1);

  await waitFor(() => attempts === 2, 3_000);
  let snapshot = runtime.snapshot();
  assert.equal(snapshot.retrying[0]?.attempt, 1);

  await waitFor(() => runtime.snapshot().retrying.length === 0, 3_000);
  snapshot = runtime.snapshot();
  assert.equal(snapshot.retrying.length, 0);
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "retry_timer_due"),
    true,
  );
  runtime.stop();
});

// ---------------------------------------------------------------------------
// Worker pool integration (T15)
// ---------------------------------------------------------------------------

interface AcquireCall {
  issueId: string;
  slotIndex: number;
  labels: ReadonlyArray<string>;
  affinityKey?: string | null;
  timeoutMs: number;
}

interface FakeLease extends WorkerLease {
  readonly settles: Array<{ kind: "release" | "fail"; arg?: string }>;
  readonly heartbeats: { count: number };
}

function makeFakeLease(
  options: {
    leaseId?: string;
    workerId?: string;
    workerHost?: string;
    stale?: boolean;
  } = {},
): FakeLease {
  const settles: Array<{ kind: "release" | "fail"; arg?: string }> = [];
  const heartbeats = { count: 0 };
  const stale = options.stale ?? false;
  return {
    leaseId: options.leaseId ?? "lease-1",
    workerId: options.workerId ?? "worker-1",
    workerHost: options.workerHost ?? "fake://worker-worker-1",
    acquiredAtMs: 0,
    expiresAtMs: null,
    settles,
    heartbeats,
    async release(outcome?: WorkerOutcome): Promise<void> {
      // A stale-generation lease guards its own settle: the leaseId no longer
      // matches the worker record so the op is a no-op that never records.
      if (stale) return;
      settles.push({ kind: "release", arg: outcome });
    },
    async fail(reason: string): Promise<void> {
      if (stale) return;
      settles.push({ kind: "fail", arg: reason });
    },
    heartbeat(): void {
      heartbeats.count += 1;
    },
  };
}

interface FakeWorkerPool extends WorkerPool {
  readonly acquireCalls: AcquireCall[];
  readonly reconcileCalls: WorkerPoolSettings[];
  readonly drainCalls: Array<{ deadlineMs: number }>;
  lastLease: FakeLease | null;
  /** Fires every registered onCapacityAvailable callback (test trigger). */
  triggerCapacityAvailable(): void;
}

function makeFakeWorkerPool(
  options: {
    result?: AcquireResult | (() => AcquireResult | Promise<AcquireResult>);
    lease?: FakeLease;
    canAcquire?: boolean | (() => boolean);
    isEnabled?: boolean | (() => boolean);
    reconcileError?: string;
  } = {},
): FakeWorkerPool {
  const acquireCalls: AcquireCall[] = [];
  const reconcileCalls: WorkerPoolSettings[] = [];
  const drainCalls: Array<{ deadlineMs: number }> = [];
  const capacityCallbacks: Array<() => void> = [];
  const pool: FakeWorkerPool = {
    acquireCalls,
    reconcileCalls,
    drainCalls,
    lastLease: null,
    async acquire(req): Promise<AcquireResult> {
      acquireCalls.push({
        issueId: req.issueId,
        slotIndex: req.slotIndex,
        labels: req.labels,
        affinityKey: req.affinityKey,
        timeoutMs: req.timeoutMs,
      });
      if (options.result) {
        return typeof options.result === "function" ? options.result() : options.result;
      }
      const lease = options.lease ?? makeFakeLease();
      pool.lastLease = lease;
      return { status: "leased", lease };
    },
    canAcquire(): boolean {
      return typeof options.canAcquire === "function"
        ? options.canAcquire()
        : (options.canAcquire ?? true);
    },
    isEnabled(): boolean {
      return typeof options.isEnabled === "function"
        ? options.isEnabled()
        : (options.isEnabled ?? true);
    },
    reconcile(next): void {
      reconcileCalls.push(next);
      if (options.reconcileError) throw new Error(options.reconcileError);
    },
    swapDriver(): void {},
    onMachineRecycling(): void {},
    onCapacityAvailable(cb): void {
      capacityCallbacks.push(cb);
    },
    triggerCapacityAvailable(): void {
      for (const cb of capacityCallbacks) cb();
    },
    async hydrate(): Promise<void> {},
    async drain(opts): Promise<void> {
      drainCalls.push({ deadlineMs: opts.deadlineMs });
    },
    snapshot() {
      return {
        enabled: true,
        driver: "fake",
        total: 0,
        warmIdle: 0,
        leased: 0,
        provisioning: 0,
        degraded: 0,
        inFlight: 0,
        spend: {
          concurrentWorkers: 0,
          workerSecondsUsed: 0,
          dailyWorkerSecondsUsed: 0,
          dayKey: "",
        },
        workers: [],
      };
    },
  };
  return pool;
}

function workerPoolWorkflowFixture(
  root = "/tmp/lorenz-runtime-workerpool",
  overrides: Record<string, unknown> = {},
): WorkflowDefinition {
  // Config has no `enabled` key; a disabled pool is the INTERNAL drained shape the reload-drain
  // produces. Tests that drive the reload-disable path pass `{ enabled: false }` here, which is
  // applied to the parsed settings object AFTER parse (config rejects the key). All other overrides
  // flow through config.
  const { enabled, ...configOverrides } = overrides as { enabled?: boolean } & Record<
    string,
    unknown
  >;
  const settings = parseConfig({
    tracker: {
      kind: "linear",
      api_key: "linear-token",
      project_slug: "mono",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 5 },
    workspace: { root },
    worker: {
      worker_pool: {
        driver: "fake",
        acquire_timeout_ms: 12_345,
        drain_deadline_ms: 9_999,
        ...configOverrides,
      },
    },
  });
  if (enabled !== undefined && settings.worker.workerPool) {
    settings.worker.workerPool = { ...settings.worker.workerPool, enabled };
  }
  return {
    path: "/tmp/WORKFLOW.md",
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };
}

test("worker pool: leased workerHost is written back and passed to the runner; history matches lease", async () => {
  const issue = issueFixture("issue-bp-lease", "MT-BP-LEASE");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const lease = makeFakeLease({ workerHost: "fake://worker-bp-lease" });
  const workerPool = makeFakeWorkerPool({ lease });
  let runnerWorkerHost: string | null | undefined = "unset";
  let workerHostDuringRun: string | null | undefined;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workerPoolWorkflowFixture(),
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ workerHost, issue: runIssue, slotIndex }) => {
        runnerWorkerHost = workerHost;
        workerHostDuringRun = runtime
          .snapshot()
          .running.find(
            (entry) => entry.issueId === runIssue.id && entry.slotIndex === slotIndex,
          )?.workerHost;
        return {
          workspace: "/tmp/lorenz/MT-BP-LEASE",
          turnCount: 1,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  assert.equal(runnerWorkerHost, "fake://worker-bp-lease");
  assert.equal(workerHostDuringRun, "fake://worker-bp-lease");
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(snapshot.runHistory[0]?.workerHost, "fake://worker-bp-lease");
  assert.deepEqual(
    lease.settles.map((s) => s.kind),
    ["release"],
  );
  assert.equal(lease.settles[0]?.arg, "healthy");
});

test("worker pool: the bound slot's mcpEndpoint is threaded into the runner", async () => {
  const issue = issueFixture("issue-bp-endpoint", "MT-BP-ENDPOINT");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const lease = makeFakeLease({ workerHost: "ssh://worker-endpoint" });
  const workerPool = makeFakeWorkerPool({ lease });
  // Dispatch to the claude kind; the ACP executor consumes the per-run endpoint
  // over the reverse tunnel. This pins the endpoint-threading mechanism.
  const workflow = workerPoolWorkflowFixture();
  workflow.settings.agent.kind = "claude";

  // A concrete-style manager (perRunClaimEnforcement=true) that opens a recognizable
  // per-run lease and records its open/release calls so we can assert the
  // coordinator owns the endpoint lifecycle and the runner consumes it.
  const endpointLease = makeFakeEndpointLease();
  const opens: Array<{ workerHost: string; runKey: string }> = [];
  let releaseCalls = 0;
  const manager: McpEndpointManager = {
    perRunClaimEnforcement: true,
    async open(req) {
      opens.push({ workerHost: req.workerHost, runKey: req.runKey });
      return endpointLease;
    },
    async release() {
      releaseCalls += 1;
    },
  };
  const coordinator = createDispatchCoordinator({
    pool: workerPool,
    mcpEndpointManager: manager,
    settings: workflow.settings.worker.workerPool!,
  });

  let runnerEndpoint: AgentMcpEndpointLease | null | undefined = undefined;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      coordinator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ mcpEndpoint }) => {
        runnerEndpoint = mcpEndpoint;
        return {
          workspace: "/tmp/lorenz/MT-BP-ENDPOINT",
          turnCount: 1,
          updates: [],
          agentKind: "claude",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  // The endpoint was opened AFTER lease-bind for this run's worker host/slot, the
  // runner received the SAME lease, and the coordinator released it on settle. The
  // runKey is the issue-scoped `${issueId}#${slotIndex}`.
  assert.equal(opens.length, 1);
  assert.equal(opens[0]?.workerHost, "ssh://worker-endpoint");
  assert.equal(opens[0]?.runKey, "issue-bp-endpoint#0");
  assert.equal(runnerEndpoint, endpointLease);
  assert.equal(releaseCalls, 1);
  assert.deepEqual(
    lease.settles.map((s) => s.kind),
    ["release"],
  );
});

test("worker pool: the FULL workflow Settings (with server.port) is threaded to the per-run endpoint open, not the WorkerPoolSettings", async () => {
  // Codex HIGH #1: the coordinator must thread the FULL workflow Settings to
  // mcpEndpointManager.open so the concrete acquireAgentMcpEndpointForRun can read
  // settings.server.port. Threading the coordinator's WorkerPoolSettings instead
  // leaves server.port undefined, so an enabled per-run-endpoint pool fails at
  // acquire and never dispatches. This test pins that open() receives the FULL
  // Settings (server.host/server.port present) the workflow carries.
  const issue = issueFixture("issue-bp-full-settings", "MT-BP-FULL-SETTINGS");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const lease = makeFakeLease({ workerHost: "ssh://worker-full-settings" });
  const workerPool = makeFakeWorkerPool({ lease });

  // A full workflow whose Settings carry a concrete server.port (the FULL Settings
  // field the WorkerPoolSettings does NOT have). Dispatch to the claude kind; the ACP
  // executor opens a per-run endpoint, so open() is reached.
  const workflow = workerPoolWorkflowFixture();
  workflow.settings.agent.kind = "claude";
  workflow.settings.server.host = "127.0.0.1";
  workflow.settings.server.port = 51_842;

  let openSettings: unknown;
  const endpointLease = makeFakeEndpointLease();
  const manager: McpEndpointManager = {
    perRunClaimEnforcement: true,
    async open(req) {
      openSettings = req.settings;
      return endpointLease;
    },
    async release() {},
  };
  const coordinator = createDispatchCoordinator({
    pool: workerPool,
    mcpEndpointManager: manager,
    settings: workflow.settings.worker.workerPool!,
  });

  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      coordinator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/lorenz/MT-BP-FULL-SETTINGS",
        turnCount: 1,
        updates: [],
        agentKind: "claude",
        finalIssue: doneIssue,
      }),
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  // The open received the FULL workflow Settings: server.port is the configured
  // value (NOT undefined, as it would be if the WorkerPoolSettings were passed). This
  // is the field acquireAgentMcpEndpointForRun reads to build the remote endpoint.
  const settings = openSettings as Settings;
  assert.ok(settings.server);
  assert.equal(settings.server.port, 51_842);
  assert.equal(settings.server.host, "127.0.0.1");
});

test("worker pool: a null-manager slot threads a null mcpEndpoint into the runner", async () => {
  const issue = issueFixture("issue-bp-null-endpoint", "MT-BP-NULL");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const lease = makeFakeLease({ workerHost: "fake://worker-null-endpoint" });
  const workerPool = makeFakeWorkerPool({ lease });
  let runnerEndpoint: AgentMcpEndpointLease | null | undefined = "unset" as never;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workerPoolWorkflowFixture(),
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ mcpEndpoint }) => {
        runnerEndpoint = mcpEndpoint;
        return {
          workspace: "/tmp/lorenz/MT-BP-NULL",
          turnCount: 1,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  // The bare-workerPool path wraps the pool in the null-endpoint passthrough
  // coordinator, so the slot carries mcpEndpoint=null and the runner receives null.
  assert.equal(runnerEndpoint, null);
});

function makeFakeEndpointLease(): AgentMcpEndpointLease {
  return {
    url: "http://127.0.0.1:46999/claude-mcp",
    token: "run-token",
    generation: 1,
    acpServer: () => ({ type: "http", name: "threaded_endpoint", url: "", headers: [] }),
    async release() {},
  };
}

// ---------------------------------------------------------------------------
// Every worker-pool run needs its per-run MCP endpoint (ACP is the only executor)
// ---------------------------------------------------------------------------
//
// The ACP executor - the only executor - consumes the per-run mcpEndpoint over
// the reverse tunnel, so the runtime asks the coordinator for one on EVERY run
// (needsMcpEndpoint=true regardless of agent kind). When the per-run open
// THROWS, the run must NOT dispatch: the coordinator settles the just-bound
// lease HEALTHY (only the endpoint failed, the worker is fine), the runtime
// cancels the reservation so the slot is re-evaluated next poll, and no history is
// recorded for a run that never started.

test("worker pool: a codex run is skipped when the per-run endpoint open THROWS (every run needs an endpoint) (HIGH)", async () => {
  const issue = issueFixture("issue-bp-codex-ep-throw", "MT-BP-CODEX-EP-THROW");
  const workflow = workerPoolWorkflowFixture();
  // The default agent kind is `codex` -> agents.codex.executor === 'acp', the
  // only executor; a codex run consumes the per-run endpoint like any other.
  assert.equal(workflow.settings.agents.codex?.executor, "acp");
  const lease = makeFakeLease({ workerHost: "ssh://worker-codex" });
  const workerPool = makeFakeWorkerPool({ lease });
  // A per-run manager whose open() ALWAYS throws: the throw surfaces as
  // worker_pool_acquire_error and the run never dispatches.
  let openCalls = 0;
  const manager: McpEndpointManager = {
    perRunClaimEnforcement: true,
    async open() {
      openCalls += 1;
      throw new Error("mcp_endpoint_open_failed: remote port-forward restricted");
    },
    async release() {},
  };
  const coordinator = createDispatchCoordinator({
    pool: workerPool,
    mcpEndpointManager: manager,
    settings: workflow.settings.worker.workerPool!,
  });
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  let runnerCalls = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      coordinator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        throw new Error("runner should not run when the endpoint open throws");
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  // The open WAS attempted (the codex run needs its endpoint), the runner never
  // ran, and the dispatch was skipped with a clear acquire error.
  assert.equal(openCalls, 1);
  assert.equal(runnerCalls, 0);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.runHistory.length, 0);
  assert.equal(snapshot.retrying.length, 0);
  assert.equal(snapshot.running.length, 0);
  // The reservation was cancelled (re-claimable next poll), not stranded.
  assert.equal(orchestrator.state.claimed.size, 0);
  assert.equal(orchestrator.state.running.size, 0);
  assert.equal(orchestrator.state.reserved.size, 0);
  // The worker itself is fine - only the endpoint failed - so the just-bound lease
  // settled HEALTHY, never poisoned.
  assert.deepEqual(lease.settles, [{ kind: "release", arg: "healthy" }]);
  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "dispatch_skipped" && event.message.includes("worker_pool_acquire_error"),
    ),
  );
});

test("worker pool: an ACP/claude run STILL opens its per-run endpoint (the per-run path is unchanged) (HIGH)", async () => {
  const issue = issueFixture("issue-bp-claude-endpoint", "MT-BP-CLAUDE-EP");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workerPoolWorkflowFixture();
  // Dispatch this issue to the `claude` kind -> agents.claude.executor === 'acp',
  // which DOES consume the per-run endpoint over the reverse tunnel.
  workflow.settings.agent.kind = "claude";
  assert.equal(workflow.settings.agents.claude?.executor, "acp");
  const lease = makeFakeLease({ workerHost: "ssh://worker-claude" });
  const workerPool = makeFakeWorkerPool({ lease });
  const endpointLease = makeFakeEndpointLease();
  let openCalls = 0;
  const manager: McpEndpointManager = {
    perRunClaimEnforcement: true,
    async open() {
      openCalls += 1;
      return endpointLease;
    },
    async release() {},
  };
  const coordinator = createDispatchCoordinator({
    pool: workerPool,
    mcpEndpointManager: manager,
    settings: workflow.settings.worker.workerPool!,
  });
  let runnerEndpoint: AgentMcpEndpointLease | null | undefined = "unset" as never;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      coordinator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ mcpEndpoint }) => {
        runnerEndpoint = mcpEndpoint;
        return {
          workspace: "/tmp/lorenz/MT-BP-CLAUDE-EP",
          turnCount: 1,
          updates: [],
          agentKind: "claude",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  // The ACP run opened its per-run endpoint exactly once and the runner consumed it.
  assert.equal(openCalls, 1);
  assert.equal(runnerEndpoint, endpointLease);
  assert.equal(runtime.snapshot().runHistory[0]?.outcome, "success");
});

test("worker pool: a claim is a host-less reservation between claim and acquire, concrete host after bind", async () => {
  const issue = issueFixture("issue-bp-reserved", "MT-BP-RESERVED");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workerPoolWorkflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  const lease = makeFakeLease({ workerHost: "fake://worker-reserved" });
  let runningDuringAcquire = -1;
  let reservingDuringAcquire: ReturnType<Orchestrator["snapshot"]>["reserving"] = [];
  let snapshotReservingDuringAcquire: NonNullable<RuntimeSnapshot["reserving"]> = [];
  let runStartedDuringAcquire = true;
  let runReservingDuringAcquire = false;
  const workerPool = makeFakeWorkerPool({
    result: () => {
      // During the acquire window the slot is an honest, host-less reservation:
      // NOT in running (no fake host anywhere), surfaced in the snapshot's
      // reserving lane, marked by run_reserving, and no run_started emitted yet.
      runningDuringAcquire = runtime.snapshot().running.length;
      reservingDuringAcquire = orchestrator.snapshot().reserving;
      snapshotReservingDuringAcquire = runtime.snapshot().reserving ?? [];
      runStartedDuringAcquire = runtime
        .snapshot()
        .recentEvents.some((event) => event.type === "run_started");
      runReservingDuringAcquire = runtime
        .snapshot()
        .recentEvents.some((event) => event.type === "run_reserving");
      return { status: "leased", lease };
    },
  });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/lorenz/MT-BP-RESERVED",
        turnCount: 1,
        updates: [],
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  assert.equal(runningDuringAcquire, 0);
  assert.equal(reservingDuringAcquire.length, 1);
  assert.equal(reservingDuringAcquire[0]?.issueId, issue.id);
  // The runtime snapshot mirrors the orchestrator's reserving lane (host-less).
  assert.equal(snapshotReservingDuringAcquire.length, 1);
  assert.equal(snapshotReservingDuringAcquire[0]?.issueId, issue.id);
  assert.equal(snapshotReservingDuringAcquire[0]?.slotIndex, 0);
  assert.equal(runStartedDuringAcquire, false);
  // run_reserving marked dispatch intent before the acquire resolved.
  assert.equal(runReservingDuringAcquire, true);
  // run_started fired post-bind, exactly once, and the run carried the bound host.
  assert.equal(
    runtime.snapshot().recentEvents.filter((event) => event.type === "run_started").length,
    1,
  );
  assert.equal(runtime.snapshot().runHistory[0]?.workerHost, "fake://worker-reserved");
  // The bound run left the reserving lane.
  assert.equal(runtime.snapshot().reserving?.length ?? 0, 0);
});

test("worker pool: acquire uses the prior real workerHost as affinityKey on retry", async () => {
  const issue = issueFixture("issue-bp-affinity", "MT-BP-AFFINITY");
  const workflow = workerPoolWorkflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  // Seed a retry record carrying the prior real worker host (as finish() would).
  orchestrator.state.retryAttempts.set(slotKey(issue.id, 0), {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(Date.now() - 1).toISOString(),
    slotIndex: 0,
    workerHost: "fake://worker-prior",
    workspacePath: null,
  });
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workerPool = makeFakeWorkerPool({
    lease: makeFakeLease({ workerHost: "fake://worker-prior" }),
  });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/lorenz/MT-BP-AFFINITY",
        turnCount: 1,
        updates: [],
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  assert.equal(workerPool.acquireCalls.length, 1);
  assert.equal(workerPool.acquireCalls[0]?.affinityKey, "fake://worker-prior");
  assert.equal(workerPool.acquireCalls[0]?.issueId, issue.id);
  assert.equal(workerPool.acquireCalls[0]?.slotIndex, 0);
  assert.equal(workerPool.acquireCalls[0]?.timeoutMs, 12_345);
});

test("worker pool: no_capacity cancels the reservation, skips the runner, records no history or backoff", async () => {
  const issue = issueFixture("issue-bp-nocap", "MT-BP-NOCAP");
  const workflow = workerPoolWorkflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  let runnerCalls = 0;
  const workerPool = makeFakeWorkerPool({
    result: { status: "no_capacity", reason: "acquire_timeout" },
  });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        throw new Error("runner should not run on no_capacity");
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  const snapshot = runtime.snapshot();
  assert.equal(runnerCalls, 0);
  assert.equal(snapshot.runHistory.length, 0);
  assert.equal(snapshot.retrying.length, 0);
  assert.equal(snapshot.running.length, 0);
  assert.equal(orchestrator.state.claimed.size, 0);
  assert.equal(orchestrator.state.running.size, 0);
  assert.equal(orchestrator.state.reserved.size, 0);
  assert.ok(snapshot.recentEvents.some((event) => event.message.includes("worker_host_capacity")));
  // The phantom started-then-skipped pair is gone: a capacity-refused dispatch
  // never emits run_started.
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "run_started"),
    false,
  );
});

test("worker pool: no_capacity reports retry timer sync failures after reservation cleanup", async () => {
  const issue = issueFixture("issue-bp-nocap-retry-sync-failure", "MT-BP-NOCAP-SYNC");
  const workflow = workerPoolWorkflowFixture();
  const store = new RetrySyncFailingCancelClaimStore(createState(), {
    ownerId: "runtime-cancel-retry-sync-failure",
  });
  const orchestrator = new Orchestrator(workflow.settings, undefined, store, {
    governs: () => true,
    canAcquire: () => true,
  });
  let runnerCalls = 0;
  const workerPool = makeFakeWorkerPool({
    result: { status: "no_capacity", reason: "acquire_timeout" },
  });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        throw new Error("runner should not run on no_capacity");
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  const snapshot = runtime.snapshot();
  assert.equal(runnerCalls, 0);
  assert.equal(snapshot.appStatus, "error");
  assert.match(snapshot.poll.lastError ?? "", /retry_timer_sync_failed/);
  assert.equal(snapshot.runHistory.length, 0);
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.reserving.length, 0);
  assert.equal(orchestrator.state.claimed.size, 0);
  assert.equal(orchestrator.state.running.size, 0);
  assert.equal(orchestrator.state.reserved.size, 0);
  assert.equal(
    snapshot.recentEvents.some((event) => event.message.includes("manual snapshot failure")),
    true,
  );
  assert.equal(
    snapshot.recentEvents.some((event) => event.message.includes("worker_host_capacity")),
    true,
  );
});

test("worker pool: no_capacity releases active handle when durable reservation cancel fails", async () => {
  const issue = issueFixture("issue-bp-cancel-failure", "MT-BP-CANCEL-FAILURE");
  const workflow = workerPoolWorkflowFixture();
  const clock = manualClock();
  const store = new FailingCancelClaimStore(createState(), {
    ownerId: "runtime-cancel-failure",
  });
  const orchestrator = new Orchestrator(workflow.settings, clock, store, {
    governs: () => true,
    canAcquire: () => true,
  });
  let runnerCalls = 0;
  const workerPool = makeFakeWorkerPool({
    result: { status: "no_capacity", reason: "acquire_timeout" },
  });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      clock,
      orchestrator,
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        throw new Error("runner should not run on no_capacity");
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  const snapshot = runtime.snapshot();
  assert.equal(runnerCalls, 0);
  assert.equal(store.heartbeats, 1);
  assert.equal(snapshot.appStatus, "error");
  assert.match(snapshot.poll.lastError ?? "", /claim_cancel_failed/);
  assert.equal(snapshot.runHistory.length, 0);
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.reserving.length, 1);
  assert.equal(
    snapshot.recentEvents.some((event) => event.message.includes("cancel failed")),
    true,
  );

  clock.advance(10_000);
  clock.fireTimer();
  assert.equal(store.heartbeats, 1);
});

test("worker pool: no_capacity restores the consumed retry entry so affinity and attempt survive", async () => {
  const issue = issueFixture("issue-bp-nocap-retry", "MT-BP-NOCAP-RETRY");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workerPoolWorkflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  // A due retry carrying the prior run's CONCRETE host and attempt counter.
  orchestrator.state.retryAttempts.set(slotKey(issue.id, 0), {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 3,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(Date.now() - 1).toISOString(),
    slotIndex: 0,
    workerHost: "fake://worker-sticky",
    workspacePath: null,
    error: "agent exited",
  });
  let acquireAttempts = 0;
  const workerPool = makeFakeWorkerPool({
    result: () => {
      acquireAttempts += 1;
      // The FIRST acquire is capacity-refused; the restored retry entry makes the
      // issue immediately re-eligible and the SECOND acquire binds.
      if (acquireAttempts === 1) return { status: "no_capacity", reason: "acquire_timeout" };
      return { status: "leased", lease: makeFakeLease({ workerHost: "fake://worker-sticky" }) };
    },
  });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/lorenz/MT-BP-NOCAP-RETRY",
        turnCount: 1,
        updates: [],
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  try {
    await runtime.pollOnce({ waitForRuns: true });
    // The capacity miss restored the consumed retry entry (still due), so the
    // retry timer re-polls promptly and the re-claim re-consumes it.
    await waitFor(() => runtime.snapshot().runHistory.length === 1, 2_000);

    // BOTH acquires carried the sticky affinity key from the (restored) retry
    // entry - the affinity survived the capacity miss.
    assert.equal(workerPool.acquireCalls.length, 2);
    assert.equal(workerPool.acquireCalls[0]?.affinityKey, "fake://worker-sticky");
    assert.equal(workerPool.acquireCalls[1]?.affinityKey, "fake://worker-sticky");
    const snapshot = runtime.snapshot();
    // The attempt counter survived too: the eventual run is attempt 3.
    assert.equal(snapshot.runHistory[0]?.retryAttempt, 3);
    assert.equal(snapshot.runHistory[0]?.workerHost, "fake://worker-sticky");
    // Exactly ONE run_started (post-bind of the successful acquire); the refused
    // dispatch emitted only worker_host_capacity.
    assert.equal(snapshot.recentEvents.filter((event) => event.type === "run_started").length, 1);
    assert.ok(
      snapshot.recentEvents.some((event) => event.message.includes("worker_host_capacity")),
    );
  } finally {
    runtime.stop();
  }
});

test("worker pool: acquire errors rearm a restored due retry timer", async () => {
  const issue = issueFixture("issue-bp-acq-error-retry", "MT-BP-ACQ-ERR-RETRY");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workerPoolWorkflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  orchestrator.state.retryAttempts.set(slotKey(issue.id, 0), {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 2,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(Date.now() - 1).toISOString(),
    slotIndex: 0,
    workerHost: "fake://worker-sticky",
    workspacePath: null,
    error: "agent exited",
  });
  let acquireAttempts = 0;
  const workerPool = makeFakeWorkerPool({
    result: () => {
      acquireAttempts += 1;
      if (acquireAttempts === 1) throw new Error("ledger_write_failed: disk full");
      return { status: "leased", lease: makeFakeLease({ workerHost: "fake://worker-sticky" }) };
    },
  });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/lorenz/MT-BP-ACQ-ERR-RETRY",
        turnCount: 1,
        updates: [],
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  try {
    await runtime.pollOnce({ waitForRuns: true });
    await waitFor(() => runtime.snapshot().runHistory.length === 1, 2_000);

    const snapshot = runtime.snapshot();
    assert.equal(acquireAttempts, 2);
    assert.equal(workerPool.acquireCalls[0]?.affinityKey, "fake://worker-sticky");
    assert.equal(workerPool.acquireCalls[1]?.affinityKey, "fake://worker-sticky");
    assert.equal(snapshot.runHistory[0]?.retryAttempt, 2);
    assert.equal(snapshot.runHistory[0]?.workerHost, "fake://worker-sticky");
    assert.ok(
      snapshot.recentEvents.some(
        (event) =>
          event.type === "dispatch_skipped" &&
          event.message.includes("worker_pool_acquire_error") &&
          event.message.includes("ledger_write_failed: disk full"),
      ),
    );
    assert.ok(snapshot.recentEvents.some((event) => event.type === "retry_timer_due"));
  } finally {
    runtime.stop();
  }
});

test("worker pool: freed capacity nudges the poll so a capacity-blocked issue re-dispatches before the interval", async () => {
  // The pool announces freed capacity (onCapacityAvailable, forwarded by the
  // coordinator); the runtime must re-poll on its own so a worker_host_capacity
  // skip re-dispatches within a scheduler turn instead of waiting out
  // polling.intervalMs (set far beyond the test budget here to prove it).
  const issue = issueFixture("issue-bp-nudge", "MT-BP-NUDGE");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workerPoolWorkflowFixture("/tmp/lorenz-runtime-workerpool-nudge");
  workflow.settings.polling.intervalMs = 60_000;
  let capacity = false;
  const lease = makeFakeLease({ workerHost: "fake://worker-nudge" });
  const workerPool = makeFakeWorkerPool({
    canAcquire: () => capacity,
    lease,
  });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/lorenz/MT-BP-NUDGE",
        turnCount: 1,
        updates: [],
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  try {
    // No capacity: the issue blocks as worker_host_capacity; nothing dispatches.
    await runtime.pollOnce();
    assert.equal(workerPool.acquireCalls.length, 0);
    assert.equal(runtime.snapshot().blocked[0]?.reason, "worker_host_capacity");

    // A worker lands warm: the pool announces capacity. The runtime re-polls and
    // dispatches WITHOUT any manual poll (start() was never called and the
    // interval is 60s, so only the nudge can drive this).
    capacity = true;
    workerPool.triggerCapacityAvailable();
    await waitFor(() => runtime.snapshot().runHistory.length === 1, 2_000);

    assert.equal(runtime.snapshot().runHistory[0]?.outcome, "success");
    assert.equal(runtime.snapshot().runHistory[0]?.workerHost, "fake://worker-nudge");
    assert.equal(workerPool.acquireCalls.length, 1);
  } finally {
    runtime.stop();
  }
});

test("worker pool: a thrown acquire rejection cancels the reservation, skips the runner, and re-claims next poll", async () => {
  // acquire() can REJECT (throw) outside the no_capacity result path (ledger /
  // filesystem / driver error). That rejection must be handled like a failed
  // dispatch: release the active handle, cancel the reservation (so the slot is
  // re-evaluated next poll), emit a clear error event, and return WITHOUT
  // running and WITHOUT leaving the reservation/handle dangling as a stuck slot.
  const issue = issueFixture("issue-bp-acq-throw", "MT-BP-ACQ-THROW");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workerPoolWorkflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  let acquireAttempts = 0;
  let runnerCalls = 0;
  const workerPool = makeFakeWorkerPool({
    result: () => {
      acquireAttempts += 1;
      // First acquire throws (driver/ledger fault); the second succeeds so the
      // re-claim on the next poll can actually run, proving the slot recovered.
      if (acquireAttempts === 1) throw new Error("ledger_write_failed: disk full");
      return { status: "leased", lease: makeFakeLease({ workerHost: "fake://worker-recovered" }) };
    },
  });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () =>
          acquireAttempts >= 1 && runnerCalls === 0 ? [issue] : [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        return {
          workspace: "/tmp/lorenz/MT-BP-ACQ-THROW",
          turnCount: 1,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });

  // The throw must NOT run the runner, record history, schedule a retry, or leave
  // the issue stuck 'running' / claimed. The slot must be re-evaluable next poll.
  let snapshot = runtime.snapshot();
  assert.equal(acquireAttempts, 1);
  assert.equal(runnerCalls, 0);
  assert.equal(snapshot.runHistory.length, 0);
  assert.equal(snapshot.retrying.length, 0);
  assert.equal(snapshot.running.length, 0);
  assert.equal(orchestrator.state.claimed.size, 0);
  assert.equal(orchestrator.state.running.size, 0);
  assert.equal(orchestrator.state.reserved.size, 0);
  // A clear error event surfaces the failure (not swallowed silently): the
  // message names the acquire error and carries the thrown error text.
  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "dispatch_skipped" &&
        event.message.includes("worker_pool_acquire_error") &&
        event.message.includes("ledger_write_failed: disk full"),
    ),
  );

  // A subsequent poll re-claims the slot and runs (no stuck-running): the second
  // acquire succeeds and the run completes against the recovered worker.
  await runtime.pollOnce({ waitForRuns: true });
  snapshot = runtime.snapshot();
  assert.equal(acquireAttempts, 2);
  assert.equal(runnerCalls, 1);
  assert.equal(snapshot.runHistory.length, 1);
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(snapshot.runHistory[0]?.workerHost, "fake://worker-recovered");
});

test("worker pool: success path releases the lease as healthy", async () => {
  const issue = issueFixture("issue-bp-success", "MT-BP-SUCCESS");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const lease = makeFakeLease();
  const workerPool = makeFakeWorkerPool({ lease });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workerPoolWorkflowFixture(),
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/lorenz/MT-BP-SUCCESS",
        turnCount: 1,
        updates: [],
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  assert.deepEqual(lease.settles, [{ kind: "release", arg: "healthy" }]);
});

async function runWorkerPoolClassifierCase(
  errorMessage: string,
  expected: { kind: "release" | "fail"; arg?: string },
): Promise<void> {
  const issue = issueFixture(`issue-bp-cls-${expected.kind}`, "MT-BP-CLS");
  const lease = makeFakeLease();
  const workerPool = makeFakeWorkerPool({ lease });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workerPoolWorkflowFixture(),
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        throw new Error(errorMessage);
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  assert.equal(lease.settles.length, 1);
  assert.equal(lease.settles[0]?.kind, expected.kind);
  if (expected.kind === "release") assert.equal(lease.settles[0]?.arg, "healthy");
}

test("worker pool: ssh_timeout failure poisons the worker (lease.fail)", async () => {
  await runWorkerPoolClassifierCase("ssh_timeout: host 60000", { kind: "fail" });
});

test("worker pool: workspace_prepare_failed poisons the worker (lease.fail)", async () => {
  await runWorkerPoolClassifierCase("workspace_prepare_failed: host 1 oops", { kind: "fail" });
});

test("worker pool: remote_home_lookup_failed poisons the worker (lease.fail)", async () => {
  await runWorkerPoolClassifierCase("remote_home_lookup_failed: host empty_home", { kind: "fail" });
});

test("worker pool: a remote workspace hook failure poisons the worker (lease.fail)", async () => {
  // The remote workspace preparation runs a hook over SSH against the worker's
  // workerHost; a non-zero hook exit throws `workspace hook failed with status N`.
  // That is a worker-side fault (the worker's environment is bad), so it must poison the
  // worker and recycle it - not be returned to WARM_IDLE for re-lease.
  await runWorkerPoolClassifierCase("workspace hook failed with status 2: setup.sh boom", {
    kind: "fail",
  });
});

test("worker pool: a LOCAL hook failure keeps the worker healthy (not the remote shape)", async () => {
  // The LOCAL hook failure string is `hook failed with status N` (no `workspace`
  // prefix) - a local/config fault that leaves the worker reusable. It must stay
  // healthy so the remote-only poison prefix does not over-match.
  await runWorkerPoolClassifierCase("hook failed with status 1: local boom", {
    kind: "release",
    arg: "healthy",
  });
});

test("worker pool: ssh_not_found (local ENOENT) keeps the worker healthy (NOT recycled)", async () => {
  await runWorkerPoolClassifierCase("ssh_not_found", { kind: "release", arg: "healthy" });
});

test("worker pool: invalid_ssh_timeout keeps the worker healthy", async () => {
  await runWorkerPoolClassifierCase("invalid_ssh_timeout: 0", { kind: "release", arg: "healthy" });
});

test("worker pool: agent_run_aborted keeps the worker healthy", async () => {
  await runWorkerPoolClassifierCase("agent_run_aborted", { kind: "release", arg: "healthy" });
});

test("worker pool: an ordinary agent failure keeps the worker healthy", async () => {
  await runWorkerPoolClassifierCase("agent exited: boom", { kind: "release", arg: "healthy" });
});

test("worker pool: a stall-finished run poisons the worker and keeps accounting correct", async () => {
  const issue = issueFixture("issue-bp-stall", "MT-BP-STALL");
  const root = await tempDir("lorenz-runtime-workerpool-stall");
  const workflow = workerPoolWorkflowFixture(root);
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  const lease = makeFakeLease({ workerHost: "fake://worker-stall" });
  const workerPool = makeFakeWorkerPool({ lease });
  let aborted = false;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal, onUpdate }) => {
        onUpdate?.({ type: "workspace_prepared", workspacePath: path.join(root, "workspace") });
        await new Promise<void>((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("agent_run_aborted"));
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    }),
  );

  try {
    await runtime.pollOnce();
    // The run dispatches asynchronously; wait until its runner has emitted its
    // first update (workspace_prepared) so the stale timestamp we set below sticks
    // rather than being overwritten by a first update that lands on the next poll.
    await waitFor(() => orchestrator.snapshot().running[0]?.lastAgentTimestamp != null, 1_000);
    const running = orchestrator.snapshot().running[0];
    assert.ok(running);
    running.lastAgentTimestamp = new Date(Date.now() - 1_000);

    await runtime.pollOnce({ dryRun: true });
    await waitFor(() => aborted, 1_000);
    await waitFor(() => lease.settles.length === 1, 1_000);

    assert.equal(runtime.snapshot().runHistory[0]?.outcome, "stalled");
    assert.deepEqual(
      lease.settles.map((s) => s.kind),
      ["fail"],
    );
  } finally {
    runtime.stop();
  }
});

test("worker pool: a stall-aborted run that RESOLVES SUCCESSFULLY still poisons the worker (MEDIUM)", async () => {
  // Codex iter-6 MEDIUM: stall reconciliation sets handle.reason='stalled' and
  // aborts the run, but the runtime only converted that to a poison outcome in the
  // CATCH path. If the runner ignores the abort and races to a SUCCESSFUL resolve,
  // the success path early-returns with workerOutcome still 'healthy' -> the finally
  // releases the slot HEALTHY -> a stalled worker is reused. The finally must override
  // workerOutcome='poison' whenever handle.reason==='stalled', independent of whether
  // the runner resolved or rejected.
  const issue = issueFixture("issue-bp-stall-success", "MT-BP-STALL-SUCCESS");
  const root = await tempDir("lorenz-runtime-workerpool-stall-success");
  const workflow = workerPoolWorkflowFixture(root);
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  const lease = makeFakeLease({ workerHost: "fake://worker-stall-success" });
  const workerPool = makeFakeWorkerPool({ lease });
  let aborted = false;
  const runControl: { resolve?: (value: RunResult) => void } = {};
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal, onUpdate }) => {
        onUpdate?.({ type: "workspace_prepared", workspacePath: path.join(root, "workspace") });
        // The runner RACES to a successful resolve after the abort instead of
        // rejecting: the stall already finished it externally, so this success must
        // NOT downgrade the worker to healthy.
        abortSignal?.addEventListener("abort", () => {
          aborted = true;
        });
        return await new Promise<RunResult>((resolve) => {
          runControl.resolve = resolve;
        });
      },
    }),
  );

  try {
    await runtime.pollOnce();
    await waitFor(() => orchestrator.snapshot().running[0]?.lastAgentTimestamp != null, 1_000);
    const running = orchestrator.snapshot().running[0];
    assert.ok(running);
    running.lastAgentTimestamp = new Date(Date.now() - 1_000);

    // The stall reconciliation aborts the run (handle.reason='stalled').
    await runtime.pollOnce({ dryRun: true });
    await waitFor(() => aborted, 1_000);
    assert.equal(runtime.snapshot().runHistory[0]?.outcome, "stalled");

    // The runner now resolves SUCCESSFULLY (it ignored the abort / raced past it).
    runControl.resolve?.({
      workspace: path.join(root, "workspace"),
      turnCount: 1,
      updates: [],
      agentKind: "codex",
      finalIssue: doneIssue,
    });
    await waitFor(() => lease.settles.length === 1, 1_000);

    // The worker is POISONED (lease.fail), NOT released healthy: a stalled worker must
    // never be reused even when the runner reports success after the abort.
    assert.deepEqual(
      lease.settles.map((s) => s.kind),
      ["fail"],
    );
    // The stall outcome is unchanged - no late success recorded.
    assert.equal(runtime.snapshot().runHistory[0]?.outcome, "stalled");
    assert.equal(runtime.snapshot().runHistory.length, 1);
  } finally {
    runtime.stop();
  }
});

test("worker pool: a stale-generation late resolve is a lease no-op (leaseId guard)", async () => {
  const issue = issueFixture("issue-bp-stale-gen", "MT-BP-STALE-GEN");
  const root = await tempDir("lorenz-runtime-workerpool-stale-gen");
  const workflow = workerPoolWorkflowFixture(root);
  workflow.settings.agent.maxRetryBackoffMs = 0;
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  // The first run's lease is "stale" - its settle is a guarded no-op (the worker
  // record's leaseId moved on). The second run's lease settles normally. The retry
  // binds a FRESH worker generation: the first (poisoned) worker is recycled and a new worker
  // is provisioned, so the leases carry distinct workerIds. This mirrors production - at
  // slotsPerMachine=1 the pool never re-leases a worker whose prior slot is still live
  // (pool inFlight is freed only when the slot settles, which also deregisters it from
  // the coordinator), so a retry never collides with the still-registered stale slot.
  const staleLease = makeFakeLease({
    leaseId: "lease-stale",
    workerId: "worker-stale",
    stale: true,
  });
  const freshLease = makeFakeLease({ leaseId: "lease-fresh", workerId: "worker-fresh" });
  const leases = [staleLease, freshLease];
  let acquireIndex = 0;
  const workerPool = makeFakeWorkerPool({
    result: () => {
      const lease = leases[acquireIndex] ?? freshLease;
      acquireIndex += 1;
      return { status: "leased", lease };
    },
  });
  const controls = new Map<number, { resolve: (value: RunResult) => void }>();
  let attempts = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal, onUpdate }) => {
        attempts += 1;
        const attempt = attempts;
        onUpdate?.({
          type: "workspace_prepared",
          workspacePath: path.join(root, `workspace-${attempt}`),
        });
        abortSignal?.addEventListener("abort", () => {});
        return await new Promise<RunResult>((resolve) => {
          controls.set(attempt, { resolve });
        });
      },
    }),
  );

  try {
    await runtime.pollOnce();
    // Wait until the first run's runner has emitted its first update so the stale
    // timestamp we set below sticks rather than being overwritten by a first update
    // that lands on the next poll.
    await waitFor(() => orchestrator.snapshot().running[0]?.lastAgentTimestamp != null, 1_000);
    const firstEntry = orchestrator.snapshot().running[0];
    assert.ok(firstEntry);
    firstEntry.lastAgentTimestamp = new Date(Date.now() - 1_000);

    await runtime.pollOnce({ dryRun: true });
    assert.equal(runtime.snapshot().runHistory[0]?.outcome, "stalled");

    await runtime.pollOnce();
    await waitFor(() => attempts === 2, 1_000);

    // The first (stale) generation resolves late; its finally calls the stale
    // lease whose settle is a guarded no-op.
    controls.get(1)?.resolve({
      workspace: path.join(root, "workspace-1"),
      turnCount: 1,
      updates: [],
      agentKind: "codex",
      finalIssue: issue,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(staleLease.settles.length, 0);
  } finally {
    runtime.stop();
  }
});

test("worker pool: a reserving (in-acquire) slot is never stall-finished and records no bogus retry host", async () => {
  // Regression pin: an in-acquire slot must never look like a stalled run. A flow
  // that placed the slot in `running` with lastAgentTimestamp=null and
  // startedAt=claim time would let a slow cold provision (longer than
  // stallTimeoutMs) be stall-finished, persisting a bogus non-concrete host into
  // RetryEntry.workerHost. A reservation has NO running entry, so the stall
  // reconciler structurally cannot touch it.
  const issue = issueFixture("issue-bp-reserving-stall", "MT-BP-RESERVING-STALL");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workerPoolWorkflowFixture();
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  const lease = makeFakeLease({ workerHost: "fake://worker-slow-provision" });
  const acquireControl: { release?: () => void } = {};
  const workerPool = makeFakeWorkerPool({
    result: async () => {
      // A slow (cold-provision) acquire held open until the test releases it.
      await new Promise<void>((resolve) => {
        acquireControl.release = resolve;
      });
      return { status: "leased", lease };
    },
  });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/lorenz/MT-BP-RESERVING-STALL",
        turnCount: 1,
        updates: [],
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  try {
    await runtime.pollOnce();
    await waitFor(() => orchestrator.snapshot().reserving.length === 1, 1_000);

    // Let the acquire window outlast the stall timeout, then run the reconciler.
    // This asserts an absence (the reserving slot is NOT stall-finished), which
    // cannot be polled for, so settle past the stall window before reconciling.
    await settle(80);
    await runtime.pollOnce({ dryRun: true });

    // The reserving slot was NOT stall-finished: no run_stalled, no retry entry
    // (and therefore no bogus retry host), the reservation still live.
    const snapshot = runtime.snapshot();
    assert.equal(
      snapshot.recentEvents.some((event) => event.type === "run_stalled"),
      false,
    );
    assert.equal(snapshot.retrying.length, 0);
    assert.equal(orchestrator.snapshot().reserving.length, 1);

    // The acquire completes; the run binds, executes, and finishes normally with
    // the CONCRETE host recorded everywhere (RetryEntry.workerHost included).
    acquireControl.release?.();
    await waitFor(() => runtime.snapshot().runHistory.length === 1, 2_000);
    assert.equal(runtime.snapshot().runHistory[0]?.outcome, "success");
    assert.equal(runtime.snapshot().runHistory[0]?.workerHost, "fake://worker-slow-provision");
    const retryHosts = orchestrator.snapshot().retrying.map((entry) => entry.workerHost ?? null);
    for (const host of retryHosts) {
      assert.equal(host, "fake://worker-slow-provision");
    }
  } finally {
    runtime.stop();
  }
});

test("worker pool: a bind after cleanup releases the worker healthy and skips as reservation_lapsed", async () => {
  // Failure path C: the issue went terminal mid-acquire (cleanupIssue cancelled
  // the reservation), then the acquire resolves bound. The late bind is token
  // guarded to null; the runtime releases the just-bound worker HEALTHY (back to
  // warm inventory) and skips the run with the reservation_lapsed detail.
  const issue = issueFixture("issue-bp-lapsed", "MT-BP-LAPSED");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workerPoolWorkflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  const lease = makeFakeLease({ workerHost: "fake://worker-lapsed" });
  const acquireControl: { release?: () => void } = {};
  const workerPool = makeFakeWorkerPool({
    result: async () => {
      await new Promise<void>((resolve) => {
        acquireControl.release = resolve;
      });
      return { status: "leased", lease };
    },
  });
  let runnerCalls = 0;
  let fetchedTerminal = false;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      workerPool,
      client: {
        fetchCandidateIssues: async () => (fetchedTerminal ? [] : [issue]),
        fetchIssuesByIds: async () => (fetchedTerminal ? [doneIssue] : [issue]),
      },
      runner: async () => {
        runnerCalls += 1;
        throw new Error("runner should not run after the reservation lapsed");
      },
    }),
  );

  try {
    await runtime.pollOnce();
    await waitFor(() => orchestrator.snapshot().reserving.length === 1, 1_000);

    // The issue goes terminal while the acquire is in flight: the reconciler
    // cancels the reservation (and aborts the run handle).
    fetchedTerminal = true;
    await runtime.pollOnce({ dryRun: true });
    assert.equal(orchestrator.snapshot().reserving.length, 0);

    // The acquire now resolves bound: late bind -> null -> release healthy + skip.
    acquireControl.release?.();
    await waitFor(() => lease.settles.length === 1, 2_000);

    assert.deepEqual(lease.settles, [{ kind: "release", arg: "healthy" }]);
    assert.equal(runnerCalls, 0);
    const snapshot = runtime.snapshot();
    assert.equal(snapshot.runHistory.length, 0);
    assert.equal(
      snapshot.recentEvents.some(
        (event) =>
          event.type === "dispatch_skipped" && event.message.includes("reservation_lapsed"),
      ),
      true,
    );
    assert.equal(
      snapshot.recentEvents.some((event) => event.type === "run_started"),
      false,
    );
  } finally {
    runtime.stop();
  }
});

test("worker pool: bind checkpoint failure releases the acquired worker and clears the reservation", async () => {
  const issue = issueFixture("issue-bp-bind-failure", "MT-BP-BIND-FAILURE");
  const workflow = workerPoolWorkflowFixture();
  const store = new FailingBindClaimStore(createState(), { ownerId: "bind-failure-store" });
  const orchestrator = new Orchestrator(workflow.settings, undefined, store, {
    governs: () => true,
    canAcquire: () => true,
  });
  const lease = makeFakeLease({ workerHost: "fake://worker-bind-failure" });
  const workerPool = makeFakeWorkerPool({ lease });
  let runnerCalls = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        throw new Error("runner should not start after bind failure");
      },
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });

  assert.deepEqual(lease.settles, [{ kind: "release", arg: "healthy" }]);
  assert.equal(runnerCalls, 0);
  assert.equal(orchestrator.snapshot().reserving.length, 0);
  assert.equal(orchestrator.snapshot().running.length, 0);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.appStatus, "error");
  assert.match(snapshot.poll.lastError ?? "", /claim_bind_failed/);
  assert.equal(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "dispatch_skipped" && event.message.includes("bind_reservation_error"),
    ),
    true,
  );
  assert.equal(
    snapshot.recentEvents.some(
      (event) => event.type === "poll_error" && event.message.includes("bind failed"),
    ),
    true,
  );
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "run_started"),
    false,
  );
});

test("worker pool: onUpdate triggers a lease heartbeat", async () => {
  const issue = issueFixture("issue-bp-heartbeat", "MT-BP-HEARTBEAT");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const lease = makeFakeLease();
  const workerPool = makeFakeWorkerPool({ lease });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workerPoolWorkflowFixture(),
      workerPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ onUpdate }) => {
        onUpdate?.({ type: "turn_completed", sessionId: "s" });
        onUpdate?.({ type: "turn_completed", sessionId: "s" });
        return {
          workspace: "/tmp/lorenz/MT-BP-HEARTBEAT",
          turnCount: 2,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  assert.equal(lease.heartbeats.count, 2);
});

test("worker pool: reconcile is called on workflow reload with the next worker-pool settings", async () => {
  const issue = issueFixture("issue-bp-reload", "MT-BP-RELOAD");
  const firstWorkflow = workerPoolWorkflowFixture();
  const secondWorkflow = workerPoolWorkflowFixture("/tmp/lorenz-runtime-workerpool-2", {
    max: 3,
  });
  const workerPool = makeFakeWorkerPool({ canAcquire: false });
  let reloads = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      workerPool,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  assert.equal(workerPool.reconcileCalls.length, 1);
  assert.equal(workerPool.reconcileCalls[0]?.max, 3);
});

test("worker pool: a reload that removes the worker_pool block reconciles to the default local pool", async () => {
  // The pool is the single dispatch path, so REMOVING the worker_pool block reconciles to the
  // DEFAULT enabled `local` pool (min=0/warm=0/max=1), which provisions nothing eagerly. The
  // "drain to zero on disable" coverage lives in the sibling test that sets an EXPLICIT
  // `enabled:false`; disabling requires that explicit shape, not deleting the block.
  const issue = issueFixture("issue-bp-remove", "MT-BP-REMOVE");
  const firstWorkflow = workerPoolWorkflowFixture();
  // The reloaded workflow has NO worker.worker_pool block: it carries the default local pool.
  const secondWorkflow = workflowFixture("/tmp/lorenz-runtime-workerpool-removed");
  assert.equal(secondWorkflow.settings.worker.workerPool?.enabled, true);
  assert.equal(secondWorkflow.settings.worker.workerPool?.driver, "local");
  assert.equal(secondWorkflow.settings.worker.workerPool?.warm, 0);
  const workerPool = makeFakeWorkerPool({ canAcquire: false });
  let reloads = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      workerPool,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  // The reload reconciles the live pool to the default local pool: enabled, with warm=0/min=0 so
  // it holds no idle (paid) workers and the fake pool reconciles exactly once.
  assert.equal(workerPool.reconcileCalls.length, 1);
  assert.equal(workerPool.reconcileCalls[0]?.enabled, true);
  assert.equal(workerPool.reconcileCalls[0]?.driver, "local");
  assert.equal(workerPool.reconcileCalls[0]?.warm, 0);
});

test("worker pool: a reload that disables the worker_pool block drains the live pool (no leak)", async () => {
  const issue = issueFixture("issue-bp-disable", "MT-BP-DISABLE");
  const firstWorkflow = workerPoolWorkflowFixture();
  const secondWorkflow = workerPoolWorkflowFixture("/tmp/lorenz-runtime-workerpool-disabled", {
    enabled: false,
  });
  assert.equal(secondWorkflow.settings.worker.workerPool?.enabled, false);
  const workerPool = makeFakeWorkerPool({ canAcquire: false });
  let reloads = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      workerPool,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  // Disabling the block must reconcile so the pool drains to zero.
  assert.equal(workerPool.reconcileCalls.length, 1);
  assert.equal(workerPool.reconcileCalls[0]?.enabled, false);
});

test("worker pool: a reload that disables the pool resumes dispatch via the local path (no lease, not blocked)", async () => {
  // Reload enabled -> disabled: the pool drains to zero and its canAcquire() now
  // returns false, but the orchestrator's lifetime probe stays installed. Dispatch
  // must RESUME via the local path (workerHost null), eligible work must NOT be
  // blocked as worker_host_capacity, and NO lease must be acquired against the
  // disabled pool.
  const issue = issueFixture("issue-bp-disabled-resume", "MT-BP-DISABLED-RESUME");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const firstWorkflow = workerPoolWorkflowFixture();
  const secondWorkflow = workerPoolWorkflowFixture(
    "/tmp/lorenz-runtime-workerpool-disabled-resume",
    { enabled: false },
  );
  let poolEnabled = true;
  // Once disabled the pool drains to zero: canAcquire() is false and the pool no
  // longer governs (isEnabled() false).
  const workerPool = makeFakeWorkerPool({
    isEnabled: () => poolEnabled,
    canAcquire: () => poolEnabled,
  });
  let runnerWorkerHost: string | null | undefined = "unset";
  let reloads = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      workerPool,
      reloadWorkflow: async () => {
        reloads += 1;
        // The reconcile (driven below) flips the live pool to disabled.
        poolEnabled = false;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ workerHost }) => {
        runnerWorkerHost = workerHost;
        return {
          workspace: "/tmp/lorenz/MT-BP-DISABLED-RESUME",
          turnCount: 1,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  const snapshot = runtime.snapshot();
  assert.equal(reloads, 1);
  // The reload reconciled the pool to disabled.
  assert.equal(workerPool.reconcileCalls.length, 1);
  assert.equal(workerPool.reconcileCalls[0]?.enabled, false);
  // Dispatch resumed via the local path: no lease was acquired against the disabled
  // pool, and the runner ran with the local workerHost (null), never a reservation.
  assert.equal(workerPool.acquireCalls.length, 0);
  assert.equal(runnerWorkerHost, null);
  // The run completed (not blocked as worker_host_capacity).
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(
    snapshot.recentEvents.some((event) => event.message.includes("worker_host_capacity")),
    false,
  );
});

test("worker pool: a reload that re-enables the pool governs again and acquires a lease", async () => {
  // Reload disabled -> re-enabled: the pool governs once more, so a lease is
  // acquired and the leased workerHost (not the local null) drives the run.
  const issue = issueFixture("issue-bp-reenable", "MT-BP-REENABLE");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const firstWorkflow = workerPoolWorkflowFixture("/tmp/lorenz-runtime-workerpool-reenable-1", {
    enabled: false,
  });
  const secondWorkflow = workerPoolWorkflowFixture("/tmp/lorenz-runtime-workerpool-reenable-2", {
    enabled: true,
  });
  let poolEnabled = false;
  const lease = makeFakeLease({ workerHost: "fake://worker-reenabled" });
  const workerPool = makeFakeWorkerPool({
    isEnabled: () => poolEnabled,
    canAcquire: () => poolEnabled,
    lease,
  });
  let runnerWorkerHost: string | null | undefined = "unset";
  let reloads = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      workerPool,
      reloadWorkflow: async () => {
        reloads += 1;
        poolEnabled = true;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ workerHost }) => {
        runnerWorkerHost = workerHost;
        return {
          workspace: "/tmp/lorenz/MT-BP-REENABLE",
          turnCount: 1,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  const snapshot = runtime.snapshot();
  assert.equal(reloads, 1);
  assert.equal(workerPool.reconcileCalls.length, 1);
  assert.equal(workerPool.reconcileCalls[0]?.enabled, true);
  // The re-enabled pool governs again: a lease was acquired and drives the run.
  assert.equal(workerPool.acquireCalls.length, 1);
  assert.equal(runnerWorkerHost, "fake://worker-reenabled");
  assert.equal(snapshot.runHistory[0]?.workerHost, "fake://worker-reenabled");
  assert.deepEqual(
    lease.settles.map((s) => s.kind),
    ["release"],
  );
});

test("worker pool: a reload that throws the anti-double-capacity guard keeps last-good and surfaces the message", async () => {
  const issue = issueFixture("issue-bp-guard", "MT-BP-GUARD");
  const firstWorkflow = workerPoolWorkflowFixture();
  const workerPool = makeFakeWorkerPool({ canAcquire: false });
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      workerPool,
      reloadWorkflow: async () => {
        // An ambiguous reload (worker_pool.driver + ssh_hosts) throws this message. The test
        // injects it to drive the throwing-reload path (keep last-good, surface the message); the
        // throw source is irrelevant to what is asserted here.
        throw new Error("worker.worker_pool.driver cannot be combined with worker.ssh_hosts");
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  // Last-good settings retained: the worker pool is still enabled.
  assert.equal(runtime.workflow.settings.worker.workerPool?.enabled, true);
  assert.equal(workerPool.reconcileCalls.length, 0);
  const reloadFailed = runtime
    .snapshot()
    .recentEvents.find((event) => event.type === "workflow_reload_failed");
  assert.ok(reloadFailed);
  assert.ok(reloadFailed.message.includes("cannot be combined with worker.ssh_hosts"));
  assert.ok(reloadFailed.message.includes("worker.worker_pool.driver"));
});

function perRunEndpointManager(): McpEndpointManager {
  // A concrete-style manager (perRunClaimEnforcement=true) so the coordinator advertises
  // the per-run-endpoint capability; open() returns null (no real endpoint needed
  // for the reload-gate tests, which never run an agent).
  return {
    perRunClaimEnforcement: true,
    async open() {
      return null;
    },
    async release() {},
  };
}

test("worker pool: a reload to max_in_flight>1 without co_residence is rejected (gate), keeps last-good, NOT reconciled", async () => {
  // Codex iter-3 HIGH #3: the slots-per-machine co-residence gate ran ONLY at
  // startup. A live daemon could reload max_in_flight 1 -> >1 WITHOUT co_residence
  // and silently widen the shared-machine blast radius the startup gate rejects.
  // The reload path must enforce the SAME gate: keep last-good settings, do NOT
  // reconcile the live pool onto the unsafe settings, and emit
  // workflow_reload_failed with the gate's message.
  const issue = issueFixture("issue-bp-reload-gate", "MT-BP-RELOAD-GATE");
  const firstWorkflow = workerPoolWorkflowFixture();
  // The reloaded workflow raises max_in_flight to 2 but supplies NO co_residence
  // opt-in: the gate must reject it even though the coordinator IS capable.
  const secondWorkflow = workerPoolWorkflowFixture("/tmp/lorenz-runtime-workerpool-reload-gate", {
    max_in_flight: 2,
  });
  assert.equal(secondWorkflow.settings.worker.workerPool?.slotsPerMachine, 2);
  assert.equal(secondWorkflow.settings.worker.workerPool?.coResidence, undefined);
  const workerPool = makeFakeWorkerPool({ canAcquire: false });
  const coordinator = createDispatchCoordinator({
    pool: workerPool,
    mcpEndpointManager: perRunEndpointManager(),
    settings: firstWorkflow.settings.worker.workerPool!,
  });
  let reloads = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      coordinator,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  // Last-good settings retained: still the original single-slot worker pool.
  assert.equal(runtime.workflow.settings.worker.workerPool?.slotsPerMachine, 1);
  // The coordinator must NOT have reconciled onto the unsafe slotsPerMachine>1.
  assert.equal(workerPool.reconcileCalls.length, 0);
  const reloadFailed = runtime
    .snapshot()
    .recentEvents.find((event) => event.type === "workflow_reload_failed");
  assert.ok(reloadFailed);
  assert.match(reloadFailed!.message, /co.?residence/i);
  // No workflow_reloaded event was emitted for the rejected reload.
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "workflow_reloaded"),
    false,
  );
});

test("worker pool: a reload to max_in_flight>1 without the per-run-endpoint capability is rejected (gate)", async () => {
  // A bare workerPool wraps in a null-endpoint coordinator (perRunClaimEnforcement=false), so
  // even WITH the co_residence opt-in the gate must reject slotsPerMachine>1 for
  // lack of the per-run-endpoint capability - mirroring the startup gate.
  const issue = issueFixture("issue-bp-reload-endpoint", "MT-BP-RELOAD-ENDPOINT");
  const firstWorkflow = workerPoolWorkflowFixture();
  const secondWorkflow = workerPoolWorkflowFixture(
    "/tmp/lorenz-runtime-workerpool-reload-endpoint",
    { max_in_flight: 2, co_residence: true },
  );
  const workerPool = makeFakeWorkerPool({ canAcquire: false });
  let reloads = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      // Bare workerPool -> null-endpoint passthrough coordinator (perRunClaimEnforcement=false).
      workerPool,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  assert.equal(runtime.workflow.settings.worker.workerPool?.slotsPerMachine, 1);
  assert.equal(workerPool.reconcileCalls.length, 0);
  const reloadFailed = runtime
    .snapshot()
    .recentEvents.find((event) => event.type === "workflow_reload_failed");
  assert.ok(reloadFailed);
  assert.match(reloadFailed!.message, /per-run scoped claims|perRunClaimEnforcement/i);
});

test("worker pool: a reload to max_in_flight>1 WITH co_residence + per-run-endpoint applies and reconciles", async () => {
  // The safe widening: a capable coordinator + the explicit co_residence opt-in.
  // The gate passes, so the reload applies and the live pool is reconciled onto the
  // new slotsPerMachine>1 settings.
  const issue = issueFixture("issue-bp-reload-ok", "MT-BP-RELOAD-OK");
  const firstWorkflow = workerPoolWorkflowFixture();
  const secondWorkflow = workerPoolWorkflowFixture("/tmp/lorenz-runtime-workerpool-reload-ok", {
    max_in_flight: 2,
    co_residence: true,
  });
  const workerPool = makeFakeWorkerPool({ canAcquire: false });
  const coordinator = createDispatchCoordinator({
    pool: workerPool,
    mcpEndpointManager: perRunEndpointManager(),
    settings: firstWorkflow.settings.worker.workerPool!,
  });
  let reloads = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      coordinator,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  // The reload applied: settings now carry slotsPerMachine=2.
  assert.equal(runtime.workflow.settings.worker.workerPool?.slotsPerMachine, 2);
  // The live pool was reconciled onto the new settings.
  assert.equal(workerPool.reconcileCalls.length, 1);
  assert.equal(workerPool.reconcileCalls[0]?.slotsPerMachine, 2);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "workflow_reloaded"),
    true,
  );
});

test("worker pool: a default (slotsPerMachine=1) reload applies unchanged through the gate", async () => {
  // With the default single-slot shape, the gate does not trigger and the reload applies.
  const issue = issueFixture("issue-bp-reload-default", "MT-BP-RELOAD-DEFAULT");
  const firstWorkflow = workerPoolWorkflowFixture();
  const secondWorkflow = workerPoolWorkflowFixture(
    "/tmp/lorenz-runtime-workerpool-reload-default",
    {
      max: 3,
    },
  );
  assert.equal(secondWorkflow.settings.worker.workerPool?.slotsPerMachine, 1);
  const workerPool = makeFakeWorkerPool({ canAcquire: false });
  let reloads = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      workerPool,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  assert.equal(workerPool.reconcileCalls.length, 1);
  assert.equal(workerPool.reconcileCalls[0]?.max, 3);
  assert.equal(workerPool.reconcileCalls[0]?.slotsPerMachine, 1);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "workflow_reload_failed"),
    false,
  );
});

test("worker pool: a reload whose reconcile throws keeps last-good settings AND the live pool unchanged (transactional)", async () => {
  // Codex iter-5 HIGH (non-transactional reload): the reload assigned
  // this.input.workflow + this.orchestrator.settings BEFORE coordinator.reconcile.
  // If reconcile throws (e.g. driver unavailable / invalid driverOptions), the
  // catch emits workflow_reload_failed but the runtime has ALREADY switched to the
  // failed settings - 'last-good' is violated and dispatch uses settings that do not
  // match the live pool/coordinator. The reload must be transactional: run the
  // throwing reconcile side effect FIRST and only swap runtime settings AFTER it
  // succeeds. On failure, BOTH the runtime settings AND the pool state stay on the
  // PREVIOUS config.
  const issue = issueFixture("issue-bp-reload-reconcile-throws", "MT-BP-RELOAD-RECONCILE");
  const firstWorkflow = workerPoolWorkflowFixture();
  assert.equal(firstWorkflow.settings.worker.workerPool?.max, 1);
  const secondWorkflow = workerPoolWorkflowFixture(
    "/tmp/lorenz-runtime-workerpool-reload-reconcile",
    { max: 3 },
  );
  assert.equal(secondWorkflow.settings.worker.workerPool?.max, 3);
  // The pool rejects the reconcile (e.g. driver unavailable on the new settings).
  const workerPool = makeFakeWorkerPool({
    canAcquire: false,
    reconcileError: "driver unavailable",
  });
  let reloads = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      workerPool,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  // Last-good is preserved: the runtime still carries the FIRST workflow's settings
  // (workerPool.max unchanged at 1, NOT the failed reload's 3) and the FIRST workflow.
  assert.equal(runtime.workflow.settings.worker.workerPool?.max, 1);
  assert.equal(runtime.workflow.path, firstWorkflow.path);
  assert.equal(runtime.workflow, firstWorkflow);
  // The failure surfaced as workflow_reload_failed carrying the reconcile message...
  const reloadFailed = runtime
    .snapshot()
    .recentEvents.find((event) => event.type === "workflow_reload_failed");
  assert.ok(reloadFailed);
  assert.ok(reloadFailed.message.includes("driver unavailable"));
  // ...and NO workflow_reloaded event was emitted for the rejected reload.
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "workflow_reloaded"),
    false,
  );
});

test("worker pool: drainWorkerPool awaits the pool drain with the configured deadline", async () => {
  const workerPool = makeFakeWorkerPool();
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workerPoolWorkflowFixture(),
      workerPool,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  await runtime.drainWorkerPool();
  // Idempotent: a second call does not drain again.
  await runtime.drainWorkerPool();

  assert.equal(workerPool.drainCalls.length, 1);
  assert.equal(workerPool.drainCalls[0]?.deadlineMs, 9_999);
});

test("worker pool: drainWorkerPool resolves as a no-op when no pool is configured", async () => {
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  await runtime.drainWorkerPool();
});

test("worker pool undefined: static path does not acquire or classify worker leases", async () => {
  const issue = issueFixture("issue-no-bp", "MT-NO-BP");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  let runnerWorkerHost: string | null | undefined = "unset";
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ workerHost }) => {
        runnerWorkerHost = workerHost;
        return {
          workspace: "/tmp/lorenz/MT-NO-BP",
          turnCount: 1,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  // No worker pool means the static local path is taken: workerHost is null, no
  // pending sentinel, no lease, success recorded exactly as before.
  assert.equal(runnerWorkerHost, null);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(snapshot.runHistory[0]?.workerHost ?? null, null);
});

test("runtime reconcile tracks a reserved (in-acquire) issue with a null workerHost and cleans it up", async () => {
  const workflow = workflowFixture();
  // A governing capacity probe makes claim() hold a host-less reservation,
  // reproducing the claim->acquire window where no real worker is bound yet.
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  const issue = issueFixture("issue-reserved-terminal", "MT-RESERVED-TERMINAL");
  const claimed = orchestrator.claim(issue);
  assert.equal(claimed?.kind, "reserved");

  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  let removeCalls = 0;
  let observedWorkerHost: string | null | undefined = "unset";
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [doneIssue],
      },
      removeIssueWorkspaces: async (_settings, _identifier, workerHost) => {
        removeCalls += 1;
        observedWorkerHost = workerHost;
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  // The terminal branch must still clean up the (local) workspace, and the
  // host-less reservation reconciles with a null workerHost - no fake host can
  // ever reach the cleanup sink's SSH path.
  assert.equal(removeCalls, 1);
  assert.equal(observedWorkerHost ?? null, null);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "workspace_cleanup"),
    true,
  );
  // cleanupIssue cancelled the reservation, so a late bind is a guarded no-op.
  assert.equal(orchestrator.state.reserved.size, 0);
  if (claimed?.kind === "reserved") {
    assert.equal(orchestrator.bindReservation(claimed.reservation, "ssh://late-worker"), null);
  }
});

test("runtime reconcile still passes a real workerHost to remote workspace cleanup", async () => {
  const workflow = workflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  const issue = issueFixture("issue-real-terminal", "MT-REAL-TERMINAL");
  const claimed = orchestrator.claim(issue);
  assert.equal(claimed?.kind, "reserved");
  // The acquire resolved: the reservation bound to the concrete worker address.
  if (claimed?.kind !== "reserved") return;
  assert.ok(orchestrator.bindReservation(claimed.reservation, "ssh://worker-real"));

  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  let observedWorkerHost: string | null | undefined = "unset";
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [doneIssue],
      },
      removeIssueWorkspaces: async (_settings, _identifier, workerHost) => {
        observedWorkerHost = workerHost;
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(observedWorkerHost, "ssh://worker-real");
});

test("runtime reconcile of a reserved issue cancels the reservation without remote cleanup", async () => {
  const workflow = workflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  const issue = issueFixture("issue-reserved-resume", "MT-RESERVED-RESUME");
  const claimed = orchestrator.claim(issue);
  assert.equal(claimed?.kind, "reserved");

  // Non-terminal but inactive (state not in active_states, not terminal) -> the
  // reconciler cleans up the issue. A reservation has no workspace and no host to SSH to.
  const canceledIssue: Issue = { ...issue, state: "Canceled", stateType: "canceled" };
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [canceledIssue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(orchestrator.state.reserved.size, 0);
  assert.equal(orchestrator.state.claimed.size, 0);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "run_reconciled"),
    true,
  );
  // The in-flight acquire's late bind no-ops against the cancelled reservation.
  if (claimed?.kind === "reserved") {
    assert.equal(orchestrator.bindReservation(claimed.reservation, "ssh://late-worker"), null);
  }
});

test("runtime replays retry timer due while a poll is active", async () => {
  const issue = issueFixture("issue-timer-overlap", "MT-TIMER-OVERLAP");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workflowFixture();
  workflow.settings.polling.intervalMs = 60_000;
  workflow.settings.agent.maxRetryBackoffMs = 1;
  const fetchControl: { release?: () => void } = {};
  let attempts = 0;
  let blockCandidateFetch = false;
  let candidateFetches = 0;
  const runtime = new LorenzRuntime(
    runtimeOptions({
      workflow,
      client: {
        fetchCandidateIssues: async () => {
          candidateFetches += 1;
          if (blockCandidateFetch) {
            blockCandidateFetch = false;
            await new Promise<void>((resolve) => {
              fetchControl.release = resolve;
            });
          }
          return [issue];
        },
        fetchIssuesByIds: async () => (attempts >= 2 ? [doneIssue] : [issue]),
      },
      runner: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("agent exited: retry me");
        return {
          workspace: "/tmp/lorenz/MT-TIMER-OVERLAP",
          turnCount: 1,
          updates: [],
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  try {
    await runtime.pollOnce({ waitForRuns: true });
    assert.equal(attempts, 1);
    blockCandidateFetch = true;

    const dryPoll = runtime.pollOnce({ dryRun: true });
    await waitFor(() => candidateFetches === 2, 1_000);
    // The second fetch is confirmed entered; settle briefly to be sure the poll
    // has parked on the blocked fetch before we release it.
    await settle(50);

    const unblockFetch = fetchControl.release;
    assert.ok(unblockFetch);
    unblockFetch();
    await dryPoll;

    await waitFor(() => attempts === 2, 1_000);
    assert.equal(
      runtime.snapshot().recentEvents.some((event) => event.type === "retry_timer_due"),
      true,
    );
  } finally {
    runtime.stop();
  }
});

function workflowFixture(root = "/tmp/lorenz-runtime-test"): WorkflowDefinition {
  const settings = parseConfig({
    tracker: {
      kind: "linear",
      api_key: "linear-token",
      project_slug: "mono",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 5 },
    workspace: { root },
  });
  return {
    path: "/tmp/WORKFLOW.md",
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };
}

function workflowMarkdown({
  acceptUnrouted = true,
  intervalMs = 5,
  prompt = "Issue {{ issue.identifier }}",
}: {
  acceptUnrouted?: boolean;
  intervalMs?: number;
  prompt?: string;
} = {}): string {
  return [
    "---",
    "tracker:",
    "  kind: linear",
    "  api_key: linear-token",
    "  project_slug: mono",
    "  active_states:",
    "    - Todo",
    "    - In Progress",
    "  terminal_states:",
    "    - Done",
    "  dispatch:",
    `    accept_unrouted: ${acceptUnrouted}`,
    "polling:",
    `  interval_ms: ${intervalMs}`,
    "---",
    prompt,
  ].join("\n");
}

function issueFixture(id: string, identifier: string): Issue {
  return normalizeIssue({
    id,
    identifier,
    title: "Runtime fixture",
    state: { name: "Todo", type: "unstarted" },
    labels: [],
    blockers: [],
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  await vi.waitFor(
    async () => {
      if (!(await predicate())) throw new Error("condition not met");
    },
    { timeout: timeoutMs, interval: 10 },
  );
}

async function fileText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
