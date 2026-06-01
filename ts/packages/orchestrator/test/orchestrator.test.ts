import { test } from "vitest";
import { Orchestrator, normalizeIssue, parseConfig, slotKey } from "@symphony/cli";
import type { ClockPort } from "@symphony/ports";

import { assert } from "../../../test/assert.js";

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

  const first = orchestrator.claim(issue);
  const second = orchestrator.claim(issue);
  const third = orchestrator.claim(issue);

  assert.equal(first?.slotIndex, 0);
  assert.equal(second?.slotIndex, 1);
  assert.equal(third, null);
  assert.equal(first?.agentKind, "claude");

  orchestrator.applyUpdate(issue.id, 0, {
    type: "turn_completed",
    sessionId: "session-1",
    resumeId: "resume-1",
    executorPid: "123",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, secondsRunning: 0 },
  });

  const snapshot = orchestrator.snapshot();
  assert.equal(snapshot.running[0]?.sessionId, "session-1");
  assert.equal(snapshot.running[0]?.resumeId, "resume-1");
  assert.equal(snapshot.running[0]?.executorPid, "123");
  assert.equal(snapshot.usageTotals.totalTokens, 15);

  orchestrator.finish(issue.id, 0, true);
  assert.equal(orchestrator.snapshot().retrying[0]?.attempt, 1);
});

test("refreshRunningIssue updates the tracker state of all slots for a running issue", () => {
  const orchestrator = new Orchestrator(parseConfig({ agent: { ensemble_size: 2 } }));
  const issue = normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "Title",
    state: { name: "Todo", type: "unstarted" },
  });
  assert.ok(orchestrator.claim(issue));
  assert.ok(orchestrator.claim(issue));
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

  assert.ok(orchestrator.claim(issue));
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

  assert.equal(orchestrator.claim(firstIssue)?.workerHost, "worker-a:2200");
  assert.equal(orchestrator.claim(secondIssue)?.workerHost, "worker-b:2200");
  assert.equal(orchestrator.claim(thirdIssue), null);

  orchestrator.finish(firstIssue.id, 0, false);
  assert.equal(orchestrator.claim(thirdIssue)?.workerHost, "worker-a:2200");
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
  assert.ok(globalOrchestrator.claim(running));
  assert.deepEqual(globalOrchestrator.eligibleIssues([blocked]), []);
  assert.equal(globalOrchestrator.snapshot().blocked[0]?.reason, "global_concurrency_cap");

  const localSettings = parseConfig({
    agent: { max_concurrent_agents: 5 },
    status_overrides: { Todo: { agent: { max_concurrent_agents: 1 } } },
  });
  const localOrchestrator = new Orchestrator(localSettings);
  assert.ok(localOrchestrator.claim(running));
  assert.deepEqual(localOrchestrator.eligibleIssues([blocked]), []);
  assert.equal(localOrchestrator.snapshot().blocked[0]?.reason, "local_concurrency_cap");

  const workerSettings = parseConfig({
    worker: { ssh_hosts: ["worker-a"], max_concurrent_agents_per_host: 1 },
    agent: { max_concurrent_agents: 5 },
  });
  const workerOrchestrator = new Orchestrator(workerSettings);
  assert.ok(workerOrchestrator.claim(running));
  assert.deepEqual(workerOrchestrator.eligibleIssues([blocked]), []);
  assert.equal(workerOrchestrator.snapshot().blocked[0]?.reason, "worker_host_capacity");
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

  assert.ok(orchestrator.claim(issue));
  orchestrator.finish(issue.id, 0, true);
  const retry = orchestrator.snapshot().retrying[0];
  assert.equal(retry?.attempt, 1);
  // Issue will only be available for a retry after the retry backoff is due
  assert.deepEqual(orchestrator.eligibleIssues([issue]), []);
  // Advance the clock to make sure the retry backoff is due
  clock.advance(100_000);

  assert.equal(orchestrator.eligibleIssues([issue])[0]?.identifier, "MT-RETRY");
  assert.equal(orchestrator.claim(issue)?.retryAttempt, 1);
  orchestrator.finish(issue.id, 0, true);
  assert.equal(orchestrator.snapshot().retrying[0]?.attempt, 2);

  assert.deepEqual(orchestrator.eligibleIssues([doneIssue]), []);
  assert.equal(orchestrator.snapshot().retrying.length, 0);
});

test("orchestrator uses Elixir retry delays for failures and active continuations", () => {
  const settings = parseConfig({ agent: { max_retry_backoff_ms: 60_000 } });
  const orchestrator = new Orchestrator(settings);
  const issue = normalizeIssue({
    id: "retry-delay",
    identifier: "MT-RETRY-DELAY",
    title: "Retry delay",
    state: { name: "Todo", type: "unstarted" },
  });

  assert.ok(orchestrator.claim(issue));
  const beforeFailure = Date.now();
  orchestrator.finish(issue.id, 0, true, "agent exited", "failure");
  let retry = orchestrator.snapshot().retrying[0];
  assert.ok(retry);
  assert.equal(retry.attempt, 1);
  assert.ok(Date.parse(retry.dueAtIso) - beforeFailure >= 9_900);

  const continuationOrchestrator = new Orchestrator(settings);
  assert.ok(continuationOrchestrator.claim(issue));
  const beforeContinuation = Date.now();
  continuationOrchestrator.finish(issue.id, 0, true, undefined, "continuation");
  retry = continuationOrchestrator.snapshot().retrying[0];
  assert.ok(retry);
  assert.equal(retry.attempt, 1);
  const continuationDelay = Date.parse(retry.dueAtIso) - beforeContinuation;
  assert.ok(continuationDelay >= 900 && continuationDelay <= 1_500);

  assert.equal(continuationOrchestrator.claim(issue)?.retryAttempt, 1);
  const beforeSecondContinuation = Date.now();
  continuationOrchestrator.finish(issue.id, 0, true, undefined, "continuation");
  retry = continuationOrchestrator.snapshot().retrying[0];
  assert.ok(retry);
  assert.equal(retry.attempt, 1);
  const secondContinuationDelay = Date.parse(retry.dueAtIso) - beforeSecondContinuation;
  assert.ok(secondContinuationDelay >= 900 && secondContinuationDelay <= 1_500);

  assert.equal(continuationOrchestrator.claim(issue)?.retryAttempt, 1);
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
  orchestrator.state.retryAttempts.set(issue.id, {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(Date.now() - 1).toISOString(),
    error: "agent exited: boom",
  });

  assert.equal(orchestrator.eligibleIssues([issue])[0]?.identifier, "MT-STALE");
  const claim = orchestrator.claim(issue);
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

  orchestrator.state.retryAttempts.set(issue.id, {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(Date.now() - 1).toISOString(),
    slotIndex: 2,
    error: "agent exited",
  });

  assert.equal(orchestrator.claim(issue)?.slotIndex, 2);
});
