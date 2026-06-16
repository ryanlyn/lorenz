import { test } from "vitest";
import fc from "fast-check";
import { Orchestrator, normalizeIssue, parseConfig, slotKey } from "@lorenz/cli";
import { systemClock, type ClockPort, type Issue, type RunningEntry } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";

import { createState, type SlotReservation } from "@lorenz/orchestrator";

function fakeClock(initial = new Date()) {
  let tick = initial.getTime();
  const clock: ClockPort & { advance(ms: number): void } = {
    now: () => new Date(tick),
    monotonicMs: () => tick,
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    advance(ms: number) {
      tick += ms;
    },
  };
  return clock;
}

/** Claims on the static/local path, asserting the union arm and unwrapping the entry. */
function claimEntry(orchestrator: Orchestrator, issue: Issue): RunningEntry | null {
  const result = orchestrator.claim(issue);
  if (result === null) return null;
  assert.equal(result.kind, "running");
  return result.kind === "running" ? result.entry : null;
}

/** Claims on the pool-governed path, asserting the union arm and unwrapping the reservation. */
function claimReservation(orchestrator: Orchestrator, issue: Issue): SlotReservation | null {
  const result = orchestrator.claim(issue);
  if (result === null) return null;
  assert.equal(result.kind, "reserved");
  return result.kind === "reserved" ? result.reservation : null;
}

test("orchestrator claims ensemble slots independently and snapshots backend-neutral fields", () => {
  const settings = parseConfig({
    agent: { ensemble_size: 2 },
    status_overrides: { Todo: { agent: { kind: "claude" } } },
  });
  const orchestrator = new Orchestrator(settings);
  const issue = normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "Title",
    state: { name: "Todo", type: "unstarted" },
  });

  const first = claimEntry(orchestrator, issue);
  const second = claimEntry(orchestrator, issue);
  const third = claimEntry(orchestrator, issue);

  assert.equal(first?.slotIndex, 0);
  assert.equal(second?.slotIndex, 1);
  assert.equal(third, null);
  assert.equal(first?.agentKind, "claude");

  orchestrator.applyUpdate(issue.id, 0, {
    type: "turn_completed",
    sessionId: "session-1",
    executorPid: "123",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });

  const snapshot = orchestrator.snapshot();
  assert.equal(snapshot.running[0]?.sessionId, "session-1");
  assert.equal(snapshot.running[0]?.executorPid, "123");
  assert.equal(snapshot.usageTotals.totalTokens, 15);

  orchestrator.finish(issue.id, 0, true);
  assert.equal(orchestrator.snapshot().retrying[0]?.attempt, 1);
});

test("orchestrator preserves pending ensemble retries per slot", () => {
  const clock = fakeClock(new Date("2026-01-01T00:00:00.000Z"));
  const settings = parseConfig({
    agent: { ensemble_size: 2, max_retry_backoff_ms: 60_000 },
    worker: { ssh_hosts: ["worker-a", "worker-b"], max_concurrent_agents_per_host: 2 },
  });
  const orchestrator = new Orchestrator(settings, clock);
  const issue = normalizeIssue({
    id: "ensemble-retry-collision",
    identifier: "MT-ENSEMBLE-RETRY-COLLISION",
    title: "Retry collision",
    state: { name: "Todo", type: "unstarted" },
  });

  const first = claimEntry(orchestrator, issue);
  const second = claimEntry(orchestrator, issue);
  assert.equal(first?.slotIndex, 0);
  assert.equal(second?.slotIndex, 1);

  orchestrator.applyUpdate(issue.id, 0, {
    type: "turn_completed",
    workspacePath: "/work/slot-0",
  });
  orchestrator.applyUpdate(issue.id, 1, {
    type: "turn_completed",
    workspacePath: "/work/slot-1",
  });

  orchestrator.finish(issue.id, 0, true, "slot 0 failed");
  orchestrator.finish(issue.id, 1, true, "slot 1 failed");

  const pending = orchestrator
    .snapshot()
    .retrying.toSorted((left, right) => (left.slotIndex ?? -1) - (right.slotIndex ?? -1));
  assert.equal(pending.length, 2);
  assert.equal(pending[0]?.slotIndex, 0);
  assert.equal(pending[0]?.workerHost, first?.workerHost);
  assert.equal(pending[0]?.workspacePath, "/work/slot-0");
  assert.equal(pending[0]?.error, "slot 0 failed");
  assert.equal(pending[1]?.slotIndex, 1);
  assert.equal(pending[1]?.workerHost, second?.workerHost);
  assert.equal(pending[1]?.workspacePath, "/work/slot-1");
  assert.equal(pending[1]?.error, "slot 1 failed");

  clock.advance(10_000);
  assert.equal(orchestrator.eligibleIssues([issue])[0]?.identifier, issue.identifier);

  const retryFirst = claimEntry(orchestrator, issue);
  assert.equal(retryFirst?.slotIndex, 0);
  assert.equal(retryFirst?.retryAttempt, 1);
  assert.equal(retryFirst?.workerHost, first?.workerHost);
  const remaining = orchestrator.snapshot().retrying;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.slotIndex, 1);
  assert.equal(remaining[0]?.workspacePath, "/work/slot-1");

  const retrySecond = claimEntry(orchestrator, issue);
  assert.equal(retrySecond?.slotIndex, 1);
  assert.equal(retrySecond?.retryAttempt, 1);
  assert.equal(retrySecond?.workerHost, second?.workerHost);
  assert.equal(orchestrator.snapshot().retrying.length, 0);
});

test("refreshRunningIssue updates the tracker state of all slots for a running issue", () => {
  const orchestrator = new Orchestrator(parseConfig({ agent: { ensemble_size: 2 } }));
  const issue = normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "Title",
    state: { name: "Todo", type: "unstarted" },
  });
  assert.ok(claimEntry(orchestrator, issue));
  assert.ok(claimEntry(orchestrator, issue));
  assert.equal(orchestrator.snapshot().running[0]?.issue.state, "Todo");
  assert.equal(orchestrator.snapshot().running[1]?.issue.state, "Todo");

  orchestrator.refreshRunningIssue({ ...issue, state: "In Progress", stateType: "started" });

  assert.equal(orchestrator.snapshot().running[0]?.issue.state, "In Progress");
  assert.equal(orchestrator.snapshot().running[1]?.issue.state, "In Progress");
});

test("orchestrator keeps per-entry usage totals monotonic across runner corrections", () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = normalizeIssue({
    id: "usage-non-monotonic",
    identifier: "MT-USAGE",
    title: "Usage",
    state: { name: "Todo", type: "unstarted" },
  });

  assert.ok(claimEntry(orchestrator, issue));
  orchestrator.applyUpdate(issue.id, 0, {
    type: "usage",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  });
  orchestrator.applyUpdate(issue.id, 0, {
    type: "usage",
    usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
  });

  const snapshot = orchestrator.snapshot();
  assert.deepEqual(snapshot.running[0]?.usageTotals, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    secondsRunning: 0,
  });
  assert.deepEqual(snapshot.usageTotals, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    secondsRunning: 0,
  });
});

test("orchestrator accumulates per-turn usage deltas for dashboard snapshots", () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = normalizeIssue({
    id: "usage-deltas",
    identifier: "MT-USAGE-DELTAS",
    title: "Usage deltas",
    state: { name: "Todo", type: "unstarted" },
  });

  assert.ok(claimEntry(orchestrator, issue));
  orchestrator.applyUpdate(issue.id, 0, {
    type: "turn_completed",
    usageKind: "delta",
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  });
  orchestrator.applyUpdate(issue.id, 0, {
    type: "turn_completed",
    usageKind: "delta",
    usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
  });

  const snapshot = orchestrator.snapshot();
  assert.deepEqual(snapshot.running[0]?.usageTotals, {
    inputTokens: 300,
    outputTokens: 150,
    totalTokens: 450,
    secondsRunning: 0,
  });
  assert.deepEqual(snapshot.usageTotals, {
    inputTokens: 300,
    outputTokens: 150,
    totalTokens: 450,
    secondsRunning: 0,
  });
});

test("orchestrator does not double count streamed cumulative usage before final turn deltas", () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = normalizeIssue({
    id: "usage-mixed",
    identifier: "MT-USAGE-MIXED",
    title: "Usage mixed",
    state: { name: "Todo", type: "unstarted" },
  });

  assert.ok(claimEntry(orchestrator, issue));
  orchestrator.applyUpdate(issue.id, 0, {
    type: "session_notification",
    usageKind: "cumulative",
    usage: { totalTokens: 150 },
  });
  orchestrator.applyUpdate(issue.id, 0, {
    type: "turn_completed",
    usageKind: "delta",
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  });
  orchestrator.applyUpdate(issue.id, 0, {
    type: "session_notification",
    usageKind: "cumulative",
    usage: { totalTokens: 450 },
  });
  orchestrator.applyUpdate(issue.id, 0, {
    type: "turn_completed",
    usageKind: "delta",
    usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
  });

  const snapshot = orchestrator.snapshot();
  assert.deepEqual(snapshot.running[0]?.usageTotals, {
    inputTokens: 300,
    outputTokens: 150,
    totalTokens: 450,
    secondsRunning: 0,
  });
  assert.deepEqual(snapshot.usageTotals, {
    inputTokens: 300,
    outputTokens: 150,
    totalTokens: 450,
    secondsRunning: 0,
  });
});

test("orchestrator does not double-count ACP usage updates when turn completion repeats the same total", () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = normalizeIssue({
    id: "usage-acp",
    identifier: "MT-ACP-USAGE",
    title: "ACP usage",
    state: { name: "Todo", type: "unstarted" },
  });

  assert.ok(claimEntry(orchestrator, issue));
  orchestrator.applyUpdate(issue.id, 0, {
    type: "session_notification",
    usageKind: "cumulative",
    usage: { totalTokens: 5 },
  });

  let snapshot = orchestrator.snapshot();
  assert.deepEqual(snapshot.running[0]?.usageTotals, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 5,
    secondsRunning: 0,
  });
  assert.deepEqual(snapshot.usageTotals, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 5,
    secondsRunning: 0,
  });

  orchestrator.applyUpdate(issue.id, 0, {
    type: "turn_completed",
    usageKind: "delta",
    usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
  });

  snapshot = orchestrator.snapshot();
  assert.deepEqual(snapshot.running[0]?.usageTotals, {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
    secondsRunning: 0,
  });
  assert.deepEqual(snapshot.usageTotals, {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
    secondsRunning: 0,
  });
});

test("orchestrator assigns SSH worker hosts by least loaded capacity", () => {
  const settings = parseConfig({
    worker: { ssh_hosts: ["worker-a:2200", "worker-b:2200"], max_concurrent_agents_per_host: 1 },
    agent: { max_concurrent_agents: 2 },
  });
  const orchestrator = new Orchestrator(settings);
  const firstIssue = normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "One",
    state: { name: "Todo", type: "unstarted" },
  });
  const secondIssue = normalizeIssue({
    id: "i2",
    identifier: "MT-2",
    title: "Two",
    state: { name: "Todo", type: "unstarted" },
  });
  const thirdIssue = normalizeIssue({
    id: "i3",
    identifier: "MT-3",
    title: "Three",
    state: { name: "Todo", type: "unstarted" },
  });

  assert.equal(claimEntry(orchestrator, firstIssue)?.workerHost, "worker-a:2200");
  assert.equal(claimEntry(orchestrator, secondIssue)?.workerHost, "worker-b:2200");
  assert.equal(claimEntry(orchestrator, thirdIssue), null);

  orchestrator.finish(firstIssue.id, 0, false);
  assert.equal(claimEntry(orchestrator, thirdIssue)?.workerHost, "worker-a:2200");
});

test("orchestrator retries on the previous worker host while it has capacity", () => {
  const settings = parseConfig({
    worker: { ssh_hosts: ["worker-a", "worker-b"], max_concurrent_agents_per_host: 2 },
    agent: { max_concurrent_agents: 4 },
  });
  const orchestrator = new Orchestrator(settings);
  const runningIssue = normalizeIssue({
    id: "running",
    identifier: "MT-RUNNING",
    title: "Running",
    state: { name: "Todo", type: "unstarted" },
  });
  const retryIssue = normalizeIssue({
    id: "retry-sticky-host",
    identifier: "MT-RETRY-STICKY",
    title: "Retry sticky host",
    state: { name: "Todo", type: "unstarted" },
  });

  assert.equal(claimEntry(orchestrator, runningIssue)?.workerHost, "worker-a");
  orchestrator.state.retryAttempts.set(slotKey(retryIssue.id, 0), {
    issueId: retryIssue.id,
    identifier: retryIssue.identifier,
    attempt: 1,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(Date.now() - 1).toISOString(),
    slotIndex: 0,
    workerHost: "worker-a",
    workspacePath: "/work/worker-a/MT-RETRY-STICKY",
    error: "agent exited",
  });

  const retryClaim = claimEntry(orchestrator, retryIssue);

  assert.equal(retryClaim?.workerHost, "worker-a");
  assert.equal(retryClaim?.retryAttempt, 1);
});

test("config reload that adds worker pools leaves running workspaces in place", () => {
  // Mirrors runtime.reloadWorkflowIfConfigured, which swaps orchestrator.settings in place.
  const orchestrator = new Orchestrator(
    parseConfig({
      worker: { ssh_hosts: ["worker-a"], max_concurrent_agents_per_host: 1 },
      agent: { max_concurrent_agents: 4 },
    }),
  );
  const issue = normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "One",
    state: "Todo",
    stateType: "unstarted",
  });

  const claimed = claimEntry(orchestrator, issue);
  assert.equal(claimed?.workerHost, "worker-a");
  orchestrator.applyUpdate(issue.id, 0, {
    type: "turn_completed",
    sessionId: "session-1",
    workspacePath: "/work/worker-a/MT-1",
  });

  orchestrator.settings = parseConfig({
    worker: { ssh_hosts: ["worker-a", "worker-b"], max_concurrent_agents_per_host: 1 },
    agent: { max_concurrent_agents: 4 },
  });

  const running = orchestrator.snapshot().running;
  assert.equal(running.length, 1);
  // Same entry instance: not recreated, and still pinned to its original host/workspace.
  assert.equal(running[0], claimed);
  assert.equal(running[0]?.workerHost, "worker-a");
  assert.equal(running[0]?.workspacePath, "/work/worker-a/MT-1");
  assert.equal(running[0]?.sessionId, "session-1");

  // The newly added pool only takes future dispatches; the existing run stays put.
  const secondIssue = normalizeIssue({
    id: "i2",
    identifier: "MT-2",
    title: "Two",
    state: "Todo",
    stateType: "unstarted",
  });
  assert.equal(claimEntry(orchestrator, secondIssue)?.workerHost, "worker-b");
  assert.equal(orchestrator.snapshot().running[0]?.workerHost, "worker-a");
});

test("config reload that removes a worker pool keeps its running workspace until completion", () => {
  const orchestrator = new Orchestrator(
    parseConfig({
      worker: { ssh_hosts: ["worker-a", "worker-b"], max_concurrent_agents_per_host: 1 },
      agent: { max_concurrent_agents: 4 },
    }),
  );
  const first = normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "One",
    state: "Todo",
    stateType: "unstarted",
  });
  const second = normalizeIssue({
    id: "i2",
    identifier: "MT-2",
    title: "Two",
    state: "Todo",
    stateType: "unstarted",
  });

  assert.equal(claimEntry(orchestrator, first)?.workerHost, "worker-a");
  const onRemovedHost = claimEntry(orchestrator, second);
  assert.equal(onRemovedHost?.workerHost, "worker-b");
  orchestrator.applyUpdate(second.id, 0, {
    type: "turn_completed",
    workspacePath: "/work/worker-b/MT-2",
  });

  orchestrator.settings = parseConfig({
    worker: { ssh_hosts: ["worker-a"], max_concurrent_agents_per_host: 1 },
    agent: { max_concurrent_agents: 4 },
  });

  // The run on the removed pool is neither relocated nor recreated: same instance, same host.
  const stillRunning = orchestrator
    .snapshot()
    .running.find((entry) => entry.issue.id === second.id);
  assert.equal(stillRunning, onRemovedHost);
  assert.equal(stillRunning?.workerHost, "worker-b");
  assert.equal(stillRunning?.workspacePath, "/work/worker-b/MT-2");

  // New dispatches only consider the remaining pool; worker-a is at capacity so the next issue blocks.
  const third = normalizeIssue({
    id: "i3",
    identifier: "MT-3",
    title: "Three",
    state: "Todo",
    stateType: "unstarted",
  });
  assert.deepEqual(orchestrator.eligibleIssues([third]), []);
  assert.equal(orchestrator.snapshot().blocked[0]?.reason, "worker_host_capacity");
});

test("orchestrator snapshots capacity-blocked dispatch candidates", () => {
  const globalSettings = parseConfig({ agent: { max_concurrent_agents: 1 } });
  const globalOrchestrator = new Orchestrator(globalSettings);
  const running = normalizeIssue({
    id: "running",
    identifier: "MT-RUN",
    title: "Running",
    state: { name: "Todo", type: "unstarted" },
  });
  const blocked = normalizeIssue({
    id: "blocked",
    identifier: "MT-BLOCK",
    title: "Blocked",
    state: { name: "Todo", type: "unstarted" },
  });
  assert.ok(claimEntry(globalOrchestrator, running));
  assert.deepEqual(globalOrchestrator.eligibleIssues([blocked]), []);
  assert.equal(globalOrchestrator.snapshot().blocked[0]?.reason, "global_concurrency_cap");

  const localSettings = parseConfig({
    agent: { max_concurrent_agents: 5 },
    status_overrides: { Todo: { agent: { max_concurrent_agents: 1 } } },
  });
  const localOrchestrator = new Orchestrator(localSettings);
  assert.ok(claimEntry(localOrchestrator, running));
  assert.deepEqual(localOrchestrator.eligibleIssues([blocked]), []);
  assert.equal(localOrchestrator.snapshot().blocked[0]?.reason, "local_concurrency_cap");

  const workerSettings = parseConfig({
    worker: { ssh_hosts: ["worker-a"], max_concurrent_agents_per_host: 1 },
    agent: { max_concurrent_agents: 5 },
  });
  const workerOrchestrator = new Orchestrator(workerSettings);
  assert.ok(claimEntry(workerOrchestrator, running));
  assert.deepEqual(workerOrchestrator.eligibleIssues([blocked]), []);
  assert.equal(workerOrchestrator.snapshot().blocked[0]?.reason, "worker_host_capacity");
});

test("orchestrator reschedules due retries that are still capacity-blocked", () => {
  const clock = fakeClock(new Date("2026-01-01T00:00:00.000Z"));
  const settings = parseConfig({
    agent: { max_concurrent_agents: 1, max_retry_backoff_ms: 60_000 },
  });
  const orchestrator = new Orchestrator(settings, clock);
  const running = normalizeIssue({
    id: "running",
    identifier: "MT-RUN",
    title: "Running",
    state: { name: "Todo", type: "unstarted" },
  });
  const retryIssue = normalizeIssue({
    id: "capacity-blocked-retry",
    identifier: "MT-CAPACITY-RETRY",
    title: "Capacity blocked retry",
    state: { name: "Todo", type: "unstarted" },
  });

  assert.ok(claimEntry(orchestrator, running));
  orchestrator.state.retryAttempts.set(slotKey(retryIssue.id, 0), {
    issueId: retryIssue.id,
    identifier: retryIssue.identifier,
    attempt: 1,
    monotonicDeadlineMs: clock.monotonicMs() - 1,
    dueAtIso: "2025-12-31T23:59:59.999Z",
    slotIndex: 0,
    workerHost: null,
    workspacePath: "/work/MT-CAPACITY-RETRY",
    issueUrl: retryIssue.url ?? null,
    error: "agent exited",
  });

  assert.deepEqual(orchestrator.eligibleIssues([retryIssue]), []);
  let retry = orchestrator.snapshot().retrying[0];
  assert.equal(orchestrator.snapshot().blocked[0]?.reason, "global_concurrency_cap");
  assert.equal(retry?.attempt, 2);
  assert.equal(retry?.monotonicDeadlineMs, clock.monotonicMs() + 20_000);
  assert.equal(retry?.dueAtIso, "2026-01-01T00:00:20.000Z");
  assert.equal(retry?.error, "dispatch blocked by global concurrency cap");

  assert.deepEqual(orchestrator.eligibleIssues([retryIssue]), []);
  retry = orchestrator.snapshot().retrying[0];
  assert.equal(orchestrator.snapshot().blocked.length, 0);
  assert.equal(retry?.attempt, 2);
  assert.equal(retry?.monotonicDeadlineMs, clock.monotonicMs() + 20_000);

  clock.advance(20_000);
  assert.deepEqual(orchestrator.eligibleIssues([retryIssue]), []);
  retry = orchestrator.snapshot().retrying[0];
  assert.equal(orchestrator.snapshot().blocked[0]?.reason, "global_concurrency_cap");
  assert.equal(retry?.attempt, 3);
  assert.equal(retry?.monotonicDeadlineMs, clock.monotonicMs() + 40_000);
  assert.equal(retry?.dueAtIso, "2026-01-01T00:01:00.000Z");
});

test("orchestrator gates retry attempts until backoff is due and clears terminal retries", () => {
  const clock = fakeClock();
  const settings = parseConfig({ agent: { max_retry_backoff_ms: 2_000 } });
  const orchestrator = new Orchestrator(settings, clock);
  const issue = normalizeIssue({
    id: "retry-1",
    identifier: "MT-RETRY",
    title: "Retry",
    state: { name: "Todo", type: "unstarted" },
  });
  const doneIssue = normalizeIssue({ ...issue, state: "Done", stateType: "completed" });

  assert.ok(claimEntry(orchestrator, issue));
  orchestrator.finish(issue.id, 0, true);
  const retry = orchestrator.snapshot().retrying[0];
  assert.equal(retry?.attempt, 1);
  // Issue will only be available for a retry after the retry backoff is due
  assert.deepEqual(orchestrator.eligibleIssues([issue]), []);
  // Advance the clock to make sure the retry backoff is due
  clock.advance(100_000);

  assert.equal(orchestrator.eligibleIssues([issue])[0]?.identifier, "MT-RETRY");
  assert.equal(claimEntry(orchestrator, issue)?.retryAttempt, 1);
  orchestrator.finish(issue.id, 0, true);
  assert.equal(orchestrator.snapshot().retrying[0]?.attempt, 2);

  assert.deepEqual(orchestrator.eligibleIssues([doneIssue]), []);
  assert.equal(orchestrator.snapshot().retrying.length, 0);
});

test("orchestrator uses configured retry delays for failures and active continuations", () => {
  const settings = parseConfig({ agent: { max_retry_backoff_ms: 60_000 } });
  const orchestrator = new Orchestrator(settings);
  const issue = normalizeIssue({
    id: "retry-delay",
    identifier: "MT-RETRY-DELAY",
    title: "Retry delay",
    state: { name: "Todo", type: "unstarted" },
  });

  assert.ok(claimEntry(orchestrator, issue));
  const beforeFailure = Date.now();
  orchestrator.finish(issue.id, 0, true, "agent exited", "failure");
  let retry = orchestrator.snapshot().retrying[0];
  assert.ok(retry);
  assert.equal(retry.attempt, 1);
  assert.ok(Date.parse(retry.dueAtIso) - beforeFailure >= 9_900);

  const continuationOrchestrator = new Orchestrator(settings);
  assert.ok(claimEntry(continuationOrchestrator, issue));
  const beforeContinuation = Date.now();
  continuationOrchestrator.finish(issue.id, 0, true, undefined, "continuation");
  retry = continuationOrchestrator.snapshot().retrying[0];
  assert.ok(retry);
  assert.equal(retry.attempt, 1);
  const continuationDelay = Date.parse(retry.dueAtIso) - beforeContinuation;
  assert.ok(continuationDelay >= 900 && continuationDelay <= 1_500);

  assert.equal(claimEntry(continuationOrchestrator, issue)?.retryAttempt, 1);
  const beforeSecondContinuation = Date.now();
  continuationOrchestrator.finish(issue.id, 0, true, undefined, "continuation");
  retry = continuationOrchestrator.snapshot().retrying[0];
  assert.ok(retry);
  assert.equal(retry.attempt, 1);
  const secondContinuationDelay = Date.parse(retry.dueAtIso) - beforeSecondContinuation;
  assert.ok(secondContinuationDelay >= 900 && secondContinuationDelay <= 1_500);

  assert.equal(claimEntry(continuationOrchestrator, issue)?.retryAttempt, 1);
  const beforeFailureAfterContinuations = Date.now();
  continuationOrchestrator.finish(
    issue.id,
    0,
    true,
    "transient failure after healthy continuations",
    "failure",
  );
  retry = continuationOrchestrator.snapshot().retrying[0];
  assert.ok(retry);
  assert.equal(retry.attempt, 2);
  const failureDelay = Date.parse(retry.dueAtIso) - beforeFailureAfterContinuations;
  assert.ok(failureDelay >= 19_900 && failureDelay <= 20_500);
});

test("orchestrator retry dispatch reopens slots blocked only by stale claims", () => {
  const settings = parseConfig();
  const orchestrator = new Orchestrator(settings);
  const issue = normalizeIssue({
    id: "stale-retry",
    identifier: "MT-STALE",
    title: "Retry stale claim",
    state: { name: "Todo", type: "unstarted" },
  });
  orchestrator.state.claimed.add(slotKey(issue.id, 0));
  orchestrator.state.retryAttempts.set(slotKey(issue.id, 0), {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(Date.now() - 1).toISOString(),
    error: "agent exited: boom",
  });

  assert.equal(orchestrator.eligibleIssues([issue])[0]?.identifier, "MT-STALE");
  const claim = claimEntry(orchestrator, issue);
  assert.equal(claim?.slotIndex, 0);
  assert.equal(claim?.retryAttempt, 1);
  assert.equal(orchestrator.snapshot().retrying.length, 0);
});

test("orchestrator retries an ensemble issue in its original slot", () => {
  const settings = parseConfig({ agent: { ensemble_size: 3 } });
  const orchestrator = new Orchestrator(settings);
  const issue = normalizeIssue({
    id: "ensemble-retry",
    identifier: "MT-ENSEMBLE-RETRY",
    title: "Retry slot",
    state: { name: "Todo", type: "unstarted" },
  });

  orchestrator.state.retryAttempts.set(slotKey(issue.id, 2), {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(Date.now() - 1).toISOString(),
    slotIndex: 2,
    error: "agent exited",
  });

  assert.equal(claimEntry(orchestrator, issue)?.slotIndex, 2);
});

test("orchestrator workerCapacityAvailable consults capacityProbe.canAcquire when present", () => {
  const settings = parseConfig();
  let available = false;
  const probe = { governs: () => true, canAcquire: () => available };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "probe-capacity",
    identifier: "MT-PROBE",
    title: "Probe",
    state: "Todo",
    stateType: "unstarted",
  });

  assert.deepEqual(orchestrator.eligibleIssues([issue]), []);
  assert.equal(orchestrator.snapshot().blocked[0]?.reason, "worker_host_capacity");
  assert.equal(orchestrator.claim(issue), null);

  available = true;
  assert.equal(orchestrator.eligibleIssues([issue])[0]?.identifier, "MT-PROBE");
  assert.ok(claimReservation(orchestrator, issue));
});

test("orchestrator claim with a governing probe returns a host-less reservation (never a running entry)", () => {
  const settings = parseConfig();
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "reserved-issue",
    identifier: "MT-RESERVED",
    title: "Reserved",
    state: "Todo",
    stateType: "unstarted",
  });

  const reservation = claimReservation(orchestrator, issue);
  assert.ok(reservation);
  assert.equal(reservation?.issueId, issue.id);
  assert.equal(reservation?.slotIndex, 0);
  assert.equal(reservation?.affinityHost, null);
  assert.equal(reservation?.retryAttempt, null);
  // The slot is held (claimed + reserved) but NO running entry exists and NO host
  // string of any kind was recorded.
  assert.equal(orchestrator.state.claimed.has(slotKey(issue.id, 0)), true);
  assert.equal(orchestrator.state.reserved.has(slotKey(issue.id, 0)), true);
  assert.equal(orchestrator.state.running.size, 0);
  assert.equal(orchestrator.snapshot().running.length, 0);
  assert.equal(orchestrator.snapshot().reserving[0]?.issueId, issue.id);
  assert.equal(orchestrator.snapshot().reserving[0]?.affinityHost, null);
  // The held slot cannot be double-reserved.
  assert.equal(orchestrator.claim(issue), null);
});

test("orchestrator reservation carries affinityHost = retry.workerHost (retry affinity preserved)", () => {
  const settings = parseConfig();
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "affinity-issue",
    identifier: "MT-AFFINITY",
    title: "Affinity",
    state: "Todo",
    stateType: "unstarted",
  });

  orchestrator.state.retryAttempts.set(slotKey(issue.id, 0), {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(Date.now() - 1).toISOString(),
    slotIndex: 0,
    workerHost: "warm-worker-7:2200",
    error: "agent exited",
  });

  const reservation = claimReservation(orchestrator, issue);
  assert.equal(reservation?.affinityHost, "warm-worker-7:2200");
  assert.equal(reservation?.retryAttempt, 1);
  // The due retry entry was consumed (stashed on the reservation record).
  assert.equal(orchestrator.state.retryAttempts.size, 0);
});

test("orchestrator static sshHosts path unchanged when no capacity probe is present", () => {
  const settings = parseConfig({
    worker: { ssh_hosts: ["worker-a:2200", "worker-b:2200"], max_concurrent_agents_per_host: 1 },
    agent: { max_concurrent_agents: 2 },
  });
  const orchestrator = new Orchestrator(settings);
  const first = normalizeIssue({
    id: "s1",
    identifier: "MT-S1",
    title: "One",
    state: "Todo",
    stateType: "unstarted",
  });
  const second = normalizeIssue({
    id: "s2",
    identifier: "MT-S2",
    title: "Two",
    state: "Todo",
    stateType: "unstarted",
  });

  const firstEntry = claimEntry(orchestrator, first);
  const secondEntry = claimEntry(orchestrator, second);
  assert.equal(firstEntry?.workerHost, "worker-a:2200");
  assert.equal(secondEntry?.workerHost, "worker-b:2200");
  assert.equal(claimEntry(orchestrator, first), null);
});

test("orchestrator bindReservation mints the RunningEntry with the CONCRETE bound host", () => {
  const clock = fakeClock(new Date("2026-01-01T00:00:00.000Z"));
  const settings = parseConfig();
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, clock, createState(), probe);
  const issue = normalizeIssue({
    id: "bind-host-issue",
    identifier: "MT-BIND",
    title: "Bind host",
    state: "Todo",
    stateType: "unstarted",
  });

  const reservation = claimReservation(orchestrator, issue);
  assert.ok(reservation);

  // startedAt is the BIND time, so run seconds never bill the provision wait.
  clock.advance(5_000);
  const entry = orchestrator.bindReservation(reservation!, "leased-worker-3:2200");
  assert.equal(entry?.workerHost, "leased-worker-3:2200");
  assert.equal(entry?.startedAt.toISOString(), "2026-01-01T00:00:05.000Z");
  assert.equal(entry?.slotIndex, 0);
  // reserved -> running: the slot stays claimed and the reserving lane empties.
  assert.equal(orchestrator.state.reserved.size, 0);
  assert.equal(orchestrator.state.claimed.has(slotKey(issue.id, 0)), true);
  assert.equal(
    orchestrator.state.running.get(slotKey(issue.id, 0))?.workerHost,
    "leased-worker-3:2200",
  );
  assert.equal(orchestrator.snapshot().reserving.length, 0);
  assert.equal(orchestrator.snapshot().running[0]?.workerHost, "leased-worker-3:2200");

  // Bind is single-shot: the token was retired with the record.
  assert.equal(orchestrator.bindReservation(reservation!, "leased-worker-4:2200"), null);
});

test("orchestrator cancelReservation frees the slot with NO retry record, leaving the slot re-claimable", () => {
  const settings = parseConfig();
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "cancel-issue",
    identifier: "MT-CANCEL",
    title: "Cancel",
    state: "Todo",
    stateType: "unstarted",
  });

  const reservation = claimReservation(orchestrator, issue);
  assert.ok(reservation);
  assert.equal(orchestrator.state.claimed.has(slotKey(issue.id, 0)), true);
  const retryAttemptsBefore = orchestrator.state.retryAttempts.size;

  orchestrator.cancelReservation(reservation!);

  assert.equal(orchestrator.state.reserved.has(slotKey(issue.id, 0)), false);
  assert.equal(orchestrator.state.claimed.has(slotKey(issue.id, 0)), false);
  assert.equal(orchestrator.snapshot().retrying.length, 0);
  assert.equal(orchestrator.state.retryAttempts.size, retryAttemptsBefore);
  assert.equal(orchestrator.snapshot().usageTotals.secondsRunning, 0);

  // Idempotent: a second cancel of the same (retired) token is a no-op.
  orchestrator.cancelReservation(reservation!);

  // A cancelled reservation cannot be bound...
  assert.equal(orchestrator.bindReservation(reservation!, "leased-worker-9:2200"), null);
  // ...and the slot is immediately re-claimable.
  const reclaim = claimReservation(orchestrator, issue);
  assert.equal(reclaim?.slotIndex, 0);
});

test("orchestrator bindReservation is token-guarded: a cancel + re-reserve defeats a late bind (ABA)", () => {
  const settings = parseConfig();
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "aba-issue",
    identifier: "MT-ABA",
    title: "ABA",
    state: "Todo",
    stateType: "unstarted",
  });

  const first = claimReservation(orchestrator, issue);
  assert.ok(first);
  orchestrator.cancelReservation(first!);
  const second = claimReservation(orchestrator, issue);
  assert.ok(second);
  assert.notEqual(first?.token, second?.token);

  // The FIRST acquire resolves late: its bind must NOT activate against the
  // successor's record.
  assert.equal(orchestrator.bindReservation(first!, "stale-worker:2200"), null);
  assert.equal(orchestrator.state.reserved.size, 1);
  // A stale cancel must not free the successor's slot either.
  orchestrator.cancelReservation(first!);
  assert.equal(orchestrator.state.reserved.size, 1);

  // The successor binds normally.
  const entry = orchestrator.bindReservation(second!, "fresh-worker:2200");
  assert.equal(entry?.workerHost, "fresh-worker:2200");
});

test("orchestrator cancelReservation restores the consumed RetryEntry without clobbering a newer one", () => {
  const settings = parseConfig();
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "restore-issue",
    identifier: "MT-RESTORE",
    title: "Restore",
    state: "Todo",
    stateType: "unstarted",
  });
  const key = slotKey(issue.id, 0);
  const consumed = {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 3,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(Date.now() - 1).toISOString(),
    slotIndex: 0,
    workerHost: "warm-worker-7:2200",
    workspacePath: "/work/MT-RESTORE",
    error: "agent exited",
  };
  orchestrator.state.retryAttempts.set(key, consumed);

  const reservation = claimReservation(orchestrator, issue);
  assert.equal(orchestrator.state.retryAttempts.has(key), false);
  orchestrator.cancelReservation(reservation!);
  // Restored verbatim: affinity host and attempt counter survive the capacity miss.
  assert.deepEqual(orchestrator.state.retryAttempts.get(key), consumed);

  // A second round: when a NEWER entry occupies the key at cancel time, the
  // restore must not clobber it.
  const again = claimReservation(orchestrator, issue);
  assert.ok(again);
  const newer = { ...consumed, attempt: 9, workerHost: "warm-worker-9:2200" };
  orchestrator.state.retryAttempts.set(key, newer);
  orchestrator.cancelReservation(again!);
  assert.deepEqual(orchestrator.state.retryAttempts.get(key), newer);
});

test("orchestrator counts reserved slots against the global concurrency cap", () => {
  const settings = parseConfig({ agent: { max_concurrent_agents: 1 } });
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const reservedIssue = normalizeIssue({
    id: "cap-reserved",
    identifier: "MT-CAP-RESERVED",
    title: "Reserved",
    state: "Todo",
    stateType: "unstarted",
  });
  const blockedIssue = normalizeIssue({
    id: "cap-blocked",
    identifier: "MT-CAP-BLOCKED",
    title: "Blocked",
    state: "Todo",
    stateType: "unstarted",
  });

  assert.ok(claimReservation(orchestrator, reservedIssue));
  // The in-acquire reservation holds the single global slot at BOTH computation
  // sites: eligibility and claim's precheck.
  assert.deepEqual(orchestrator.eligibleIssues([blockedIssue]), []);
  assert.equal(orchestrator.snapshot().blocked[0]?.reason, "global_concurrency_cap");
  assert.equal(orchestrator.claim(blockedIssue), null);
});

test("orchestrator counts reserved slots against per-state concurrency caps", () => {
  const settings = parseConfig({
    agent: { max_concurrent_agents: 5 },
    status_overrides: { Todo: { agent: { max_concurrent_agents: 1 } } },
  });
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const reservedIssue = normalizeIssue({
    id: "state-cap-reserved",
    identifier: "MT-STATE-CAP-RESERVED",
    title: "Reserved",
    state: "Todo",
    stateType: "unstarted",
  });
  const blockedIssue = normalizeIssue({
    id: "state-cap-blocked",
    identifier: "MT-STATE-CAP-BLOCKED",
    title: "Blocked",
    state: "Todo",
    stateType: "unstarted",
  });

  assert.ok(claimReservation(orchestrator, reservedIssue));
  assert.deepEqual(orchestrator.eligibleIssues([blockedIssue]), []);
  assert.equal(orchestrator.snapshot().blocked[0]?.reason, "local_concurrency_cap");
  assert.equal(orchestrator.claim(blockedIssue), null);
});

test("orchestrator releaseStaleClaimsForRetry skips a live reservation's claimed key", () => {
  const clock = fakeClock(new Date("2026-01-01T00:00:00.000Z"));
  const settings = parseConfig({ agent: { ensemble_size: 2, max_concurrent_agents: 4 } });
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, clock, createState(), probe);
  const issue = normalizeIssue({
    id: "stale-skip-issue",
    identifier: "MT-STALE-SKIP",
    title: "Stale skip",
    state: "Todo",
    stateType: "unstarted",
  });

  // Slot 0 is mid-acquire (claimed-without-running, a legitimate state now).
  const reservation = claimReservation(orchestrator, issue);
  assert.equal(reservation?.slotIndex, 0);
  // Slot 1 has a DUE retry, which triggers releaseStaleClaimsForRetry.
  orchestrator.state.retryAttempts.set(slotKey(issue.id, 1), {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(clock.now().getTime() - 1).toISOString(),
    slotIndex: 1,
    error: "agent exited",
  });

  assert.equal(orchestrator.eligibleIssues([issue])[0]?.identifier, issue.identifier);
  // The live reservation survived the stale-claim release...
  assert.equal(orchestrator.state.reserved.has(slotKey(issue.id, 0)), true);
  assert.equal(orchestrator.state.claimed.has(slotKey(issue.id, 0)), true);
  // ...so the retry claim lands on ITS slot, never duplicating slot 0.
  const retryReservation = claimReservation(orchestrator, issue);
  assert.equal(retryReservation?.slotIndex, 1);
});

test("orchestrator expiry sweep cancels a past-expiry reservation and restores its retry entry", () => {
  const clock = fakeClock(new Date("2026-01-01T00:00:00.000Z"));
  const settings = parseConfig();
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, clock, createState(), probe);
  const issue = normalizeIssue({
    id: "expiry-issue",
    identifier: "MT-EXPIRY",
    title: "Expiry",
    state: "Todo",
    stateType: "unstarted",
  });
  const key = slotKey(issue.id, 0);
  const consumed = {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 2,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(clock.now().getTime() - 1).toISOString(),
    slotIndex: 0,
    workerHost: "warm-worker-2:2200",
    error: "agent exited",
  };
  orchestrator.state.retryAttempts.set(key, consumed);

  const reservation = claimReservation(orchestrator, issue);
  assert.ok(reservation);
  // Default acquireTimeoutMs (30s, no workerPool configured): expiry = 2x + 60s grace.
  assert.equal(reservation?.expiresAtMonotonicMs, clock.monotonicMs() + 120_000);

  // Not yet expired: the sweep leaves the reservation alone.
  clock.advance(119_999);
  orchestrator.eligibleIssues([]);
  assert.equal(orchestrator.state.reserved.size, 1);

  // Past expiry: the sweep cancels (a hung acquire cannot strand the slot) and
  // restores the consumed retry entry.
  clock.advance(1);
  orchestrator.eligibleIssues([]);
  assert.equal(orchestrator.state.reserved.size, 0);
  assert.equal(orchestrator.state.claimed.has(key), false);
  assert.deepEqual(orchestrator.state.retryAttempts.get(key), consumed);
  // A late successful acquire after the sweep is token-guarded to a null bind.
  assert.equal(orchestrator.bindReservation(reservation!, "late-worker:2200"), null);
});

test("orchestrator cleanupIssue cancels a mid-acquire reservation and clears its retry state", () => {
  const settings = parseConfig();
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "cleanup-reserved-issue",
    identifier: "MT-CLEANUP-RESERVED",
    title: "Cleanup reserved",
    state: "Todo",
    stateType: "unstarted",
  });
  const key = slotKey(issue.id, 0);
  orchestrator.state.retryAttempts.set(key, {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(Date.now() - 1).toISOString(),
    slotIndex: 0,
    workerHost: "warm-worker-1:2200",
    error: "agent exited",
  });
  const reservation = claimReservation(orchestrator, issue);
  assert.ok(reservation);

  orchestrator.cleanupIssue(issue.id);

  assert.equal(orchestrator.state.reserved.size, 0);
  assert.equal(orchestrator.state.claimed.size, 0);
  // The restore-then-delete composition: the restored retry entry was removed by
  // the issue-wide retry cleanup.
  assert.equal(orchestrator.state.retryAttempts.size, 0);
  assert.equal(orchestrator.state.completed.has(issue.id), true);
  // The in-flight acquire resolves afterwards: its bind is a guarded null.
  assert.equal(orchestrator.bindReservation(reservation!, "late-worker:2200"), null);
});

test("orchestrator refreshRunningIssue updates reserved records' issue for cap accounting", () => {
  const settings = parseConfig({
    agent: { max_concurrent_agents: 5 },
    status_overrides: { "In Progress": { agent: { max_concurrent_agents: 1 } } },
  });
  const probe = { governs: () => true, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "refresh-reserved-issue",
    identifier: "MT-REFRESH-RESERVED",
    title: "Refresh reserved",
    state: "Todo",
    stateType: "unstarted",
  });

  assert.ok(claimReservation(orchestrator, issue));
  orchestrator.refreshRunningIssue({ ...issue, state: "In Progress", stateType: "started" });
  assert.equal(orchestrator.state.reserved.get(slotKey(issue.id, 0))?.issue.state, "In Progress");

  // The refreshed state feeds per-state cap accounting during a long acquire.
  const blocked = normalizeIssue({
    id: "refresh-reserved-blocked",
    identifier: "MT-REFRESH-RESERVED-BLOCKED",
    title: "Blocked",
    state: "In Progress",
    stateType: "started",
  });
  assert.deepEqual(orchestrator.eligibleIssues([blocked]), []);
  assert.equal(orchestrator.snapshot().blocked[0]?.reason, "local_concurrency_cap");
});

test("orchestrator reserved map stays empty on the static path (no governing probe)", () => {
  const orchestrator = new Orchestrator(parseConfig({ agent: { max_concurrent_agents: 4 } }));
  for (let index = 0; index < 4; index += 1) {
    const issue = normalizeIssue({
      id: `static-${index}`,
      identifier: `MT-STATIC-${index}`,
      title: "Static",
      state: "Todo",
      stateType: "unstarted",
    });
    assert.ok(claimEntry(orchestrator, issue));
    assert.equal(orchestrator.state.reserved.size, 0);
    assert.equal(orchestrator.snapshot().reserving.length, 0);
  }
});

test("cap parity property: running + reserved never exceeds the cap and claimed === union(running, reserved)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 4 }),
      fc.array(
        fc.record({
          op: fc.constantFrom("claim", "bind", "cancel", "finish"),
          pick: fc.nat({ max: 40 }),
        }),
        { maxLength: 80 },
      ),
      (maxConcurrent, ops) => {
        const clock = fakeClock(new Date("2026-01-01T00:00:00.000Z"));
        const settings = parseConfig({ agent: { max_concurrent_agents: maxConcurrent } });
        const probe = { governs: () => true, canAcquire: () => true };
        const orchestrator = new Orchestrator(settings, clock, createState(), probe);
        const issues = Array.from({ length: 6 }, (_, index) =>
          normalizeIssue({
            id: `prop-${index}`,
            identifier: `MT-PROP-${index}`,
            title: "Prop",
            state: "Todo",
            stateType: "unstarted",
          }),
        );
        const reservations: SlotReservation[] = [];
        const runningSlots: Array<{ issueId: string; slotIndex: number }> = [];

        const assertInvariants = (): void => {
          assert.ok(
            orchestrator.state.running.size + orchestrator.state.reserved.size <= maxConcurrent,
          );
          const union = new Set([
            ...orchestrator.state.running.keys(),
            ...orchestrator.state.reserved.keys(),
          ]);
          assert.equal(orchestrator.state.claimed.size, union.size);
          for (const key of union) assert.ok(orchestrator.state.claimed.has(key));
        };

        for (const { op, pick } of ops) {
          if (op === "claim") {
            const issue = issues[pick % issues.length]!;
            const result = orchestrator.claim(issue);
            if (result) {
              assert.equal(result.kind, "reserved");
              if (result.kind === "reserved") reservations.push(result.reservation);
            }
          } else if (op === "bind" && reservations.length > 0) {
            const [reservation] = reservations.splice(pick % reservations.length, 1);
            const entry = orchestrator.bindReservation(reservation!, `worker-${pick}:2200`);
            if (entry) {
              runningSlots.push({ issueId: reservation!.issueId, slotIndex: entry.slotIndex });
            }
          } else if (op === "cancel" && reservations.length > 0) {
            const [reservation] = reservations.splice(pick % reservations.length, 1);
            orchestrator.cancelReservation(reservation!);
          } else if (op === "finish" && runningSlots.length > 0) {
            const [slot] = runningSlots.splice(pick % runningSlots.length, 1);
            clock.advance(1_000);
            orchestrator.finish(slot!.issueId, slot!.slotIndex, true);
          }
          assertInvariants();
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("orchestrator workerCapacityAvailable falls through to local (true) when probe is present but not governing", () => {
  // A disabled (reloaded-off) pool's probe is still installed for the lifetime, but
  // its canAcquire() returns false. When it no longer governs capacity the
  // orchestrator must NOT block on it; it must fall through to the static/local
  // path. With no ssh_hosts the local path always has capacity (true), so eligible
  // work resumes instead of being permanently blocked as worker_host_capacity.
  const settings = parseConfig();
  const probe = { governs: () => false, canAcquire: () => false };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "fallthrough-local",
    identifier: "MT-FALLTHROUGH-LOCAL",
    title: "Fallthrough local",
    state: "Todo",
    stateType: "unstarted",
  });

  assert.equal(orchestrator.eligibleIssues([issue])[0]?.identifier, "MT-FALLTHROUGH-LOCAL");
  assert.equal(orchestrator.snapshot().blocked.length, 0);
});

test("orchestrator workerCapacityAvailable honors static ssh_hosts when probe is present but not governing", () => {
  // When the probe does not govern, the static sshHosts host-selection path is the
  // source of truth: a saturated host pool still reports no capacity.
  const settings = parseConfig({
    worker: { ssh_hosts: ["worker-a"], max_concurrent_agents_per_host: 1 },
    agent: { max_concurrent_agents: 5 },
  });
  const probe = { governs: () => false, canAcquire: () => true };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const running = normalizeIssue({
    id: "static-running",
    identifier: "MT-STATIC-RUN",
    title: "Running",
    state: "Todo",
    stateType: "unstarted",
  });
  const blocked = normalizeIssue({
    id: "static-blocked",
    identifier: "MT-STATIC-BLOCK",
    title: "Blocked",
    state: "Todo",
    stateType: "unstarted",
  });

  // The claim takes the static selectWorkerHost path (real host, no reservation).
  assert.equal(claimEntry(orchestrator, running)?.workerHost, "worker-a");
  assert.deepEqual(orchestrator.eligibleIssues([blocked]), []);
  assert.equal(orchestrator.snapshot().blocked[0]?.reason, "worker_host_capacity");
});

test("orchestrator claim does NOT reserve when probe is present but not governing", () => {
  // A non-governing probe must use the normal selectWorkerHost path, which yields
  // a running entry with null/local host (no ssh_hosts) instead of a reservation.
  const settings = parseConfig();
  const probe = { governs: () => false, canAcquire: () => false };
  const orchestrator = new Orchestrator(settings, systemClock, createState(), probe);
  const issue = normalizeIssue({
    id: "no-reservation",
    identifier: "MT-NO-RESERVATION",
    title: "No reservation",
    state: "Todo",
    stateType: "unstarted",
  });

  const entry = claimEntry(orchestrator, issue);
  assert.ok(entry);
  assert.equal(entry?.workerHost, null);
  assert.equal(orchestrator.state.reserved.size, 0);
});
