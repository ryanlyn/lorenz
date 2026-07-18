import { test } from "vitest";
import { Orchestrator, normalizeIssue, parseConfig, slotKey } from "@lorenz/cli";
import type { ClockPort, Issue, RunningEntry } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";

/** Claims on the static/local path, asserting the union arm and unwrapping the entry. */
async function claimEntry(orchestrator: Orchestrator, issue: Issue): Promise<RunningEntry | null> {
  const result = await orchestrator.claimAsync(issue);
  if (result === null) return null;
  assert.equal(result.kind, "running");
  return result.kind === "running" ? result.entry : null;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return normalizeIssue({
    id: "edge-1",
    identifier: "MT-EDGE-1",
    title: "Edge case issue",
    state: { name: "Todo", type: "unstarted" },
    ...overrides,
  });
}

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

// --- claimAsync ---

test("claimAsync - null return when global concurrency cap reached", async () => {
  const settings = parseConfig({ agent: { max_concurrent_agents: 1 } });
  const orchestrator = new Orchestrator(settings);
  const first = makeIssue({ id: "a", identifier: "MT-A" });
  const second = makeIssue({ id: "b", identifier: "MT-B" });

  assert.ok(await claimEntry(orchestrator, first));
  assert.equal(await claimEntry(orchestrator, second), null);
});

test("claimAsync - null return when all ensemble slots claimed", async () => {
  const settings = parseConfig({ agent: { ensemble_size: 2 } });
  const orchestrator = new Orchestrator(settings);
  const issue = makeIssue();

  assert.ok(await claimEntry(orchestrator, issue));
  assert.ok(await claimEntry(orchestrator, issue));
  assert.equal(await claimEntry(orchestrator, issue), null);
});

test("claimAsync - null return when worker hosts at capacity", async () => {
  const settings = parseConfig({
    worker: { ssh_hosts: ["host-a:2200"], max_concurrent_agents_per_host: 1 },
    agent: { max_concurrent_agents: 5 },
  });
  const orchestrator = new Orchestrator(settings);
  const first = makeIssue({ id: "a", identifier: "MT-A" });
  const second = makeIssue({ id: "b", identifier: "MT-B" });

  assert.ok(await claimEntry(orchestrator, first));
  assert.equal(await claimEntry(orchestrator, second), null);
});

test("claimAsync - preferred slot honored on retry", async () => {
  const settings = parseConfig({ agent: { ensemble_size: 3 } });
  const orchestrator = new Orchestrator(settings);
  const issue = makeIssue();

  orchestrator.state.retryAttempts.set(slotKey(issue.id, 2), {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(Date.now() - 1).toISOString(),
    slotIndex: 2,
    error: "failed",
  });

  const claimed = await claimEntry(orchestrator, issue);
  assert.equal(claimed?.slotIndex, 2);
  assert.equal(claimed?.retryAttempt, 1);
});

test("claimAsync - non-existent retry does not interfere with fresh claim", async () => {
  const settings = parseConfig();
  const orchestrator = new Orchestrator(settings);
  const issue = makeIssue();

  const claimed = await claimEntry(orchestrator, issue);
  assert.ok(claimed);
  assert.equal(claimed?.slotIndex, 0);
  assert.equal(claimed?.retryAttempt, null);
});

// --- applyUpdateAsync ---

test("applyUpdateAsync - unknown slotKey is silently ignored", async () => {
  const orchestrator = new Orchestrator(parseConfig());
  await orchestrator.applyUpdateAsync("nonexistent", 99, {
    type: "turn_completed",
    sessionId: "s1",
  });
  assert.equal(orchestrator.snapshot().running.length, 0);
});

test("applyUpdateAsync - turnCount increments on each turn_completed", async () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  await claimEntry(orchestrator, issue);

  await orchestrator.applyUpdateAsync(issue.id, 0, { type: "turn_completed" });
  await orchestrator.applyUpdateAsync(issue.id, 0, { type: "turn_completed" });
  await orchestrator.applyUpdateAsync(issue.id, 0, { type: "turn_completed" });

  assert.equal(orchestrator.snapshot().running[0]?.turnCount, 3);
});

test("applyUpdateAsync - rateLimits propagated to state", async () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  await claimEntry(orchestrator, issue);

  const limits = { provider: "anthropic", retryAfter: 30 };
  await orchestrator.applyUpdateAsync(issue.id, 0, {
    type: "rate_limit",
    message: "rate limited by anthropic",
    rateLimits: limits,
  });

  assert.deepEqual(orchestrator.snapshot().rateLimits, limits);
});

// --- finishAsync ---

test("finishAsync - non-normal finish does not create retry entry", async () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  await claimEntry(orchestrator, issue);

  await orchestrator.finishAsync(issue.id, 0, false, "crashed");

  assert.equal(orchestrator.snapshot().retrying.length, 0);
  assert.equal(orchestrator.snapshot().running.length, 0);
});

test("finishAsync - secondsRunning accumulates across multiple finishes", async () => {
  const now = new Date("2025-01-01T00:00:00Z");
  const clock = fakeClock(now);
  const orchestrator = new Orchestrator(parseConfig(), clock);
  const issueA = makeIssue({ id: "a", identifier: "MT-A" });
  const issueB = makeIssue({ id: "b", identifier: "MT-B" });

  await claimEntry(orchestrator, issueA);
  clock.advance(10_000);
  await orchestrator.finishAsync(issueA.id, 0, false);

  await claimEntry(orchestrator, issueB);
  clock.advance(15_000);
  await orchestrator.finishAsync(issueB.id, 0, false);

  assert.equal(orchestrator.snapshot().usageTotals.secondsRunning, 25);
});

test("finishAsync - finishing same slot twice is idempotent (second is no-op)", async () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  await claimEntry(orchestrator, issue);

  await orchestrator.finishAsync(issue.id, 0, true);
  const afterFirst = orchestrator.snapshot().usageTotals.secondsRunning;

  await orchestrator.finishAsync(issue.id, 0, true);
  assert.equal(orchestrator.snapshot().usageTotals.secondsRunning, afterFirst);
});

// --- cleanupIssueAsync ---

test("cleanupIssueAsync - removes running entry and claimed slot", async () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  await claimEntry(orchestrator, issue);

  assert.equal(orchestrator.snapshot().running.length, 1);
  await orchestrator.cleanupIssueAsync(issue.id);
  assert.equal(orchestrator.snapshot().running.length, 0);
  assert.equal(orchestrator.state.claimed.has(slotKey(issue.id, 0)), false);
});

test("cleanupIssueAsync - removes retry attempts for issue", async () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  await claimEntry(orchestrator, issue);
  await orchestrator.finishAsync(issue.id, 0, true);
  assert.equal(orchestrator.snapshot().retrying.length, 1);

  await orchestrator.cleanupIssueAsync(issue.id);
  assert.equal(orchestrator.snapshot().retrying.length, 0);
});

test("cleanupIssueAsync - adds issue to completed set", async () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  await claimEntry(orchestrator, issue);

  await orchestrator.cleanupIssueAsync(issue.id);
  assert.equal(orchestrator.state.completed.has(issue.id), true);
});

// --- snapshot ---

test("snapshot — returns defensive copy (mutation does not affect state)", async () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  await claimEntry(orchestrator, issue);

  const snap = orchestrator.snapshot();
  snap.running.length = 0;
  snap.usageTotals.inputTokens = 9999;

  assert.equal(orchestrator.snapshot().running.length, 1);
  assert.equal(orchestrator.snapshot().usageTotals.inputTokens, 0);
});

// --- eligibleIssuesAsync ---

test("eligibleIssuesAsync - inactive issue cleared from retryAttempts", async () => {
  const settings = parseConfig({ tracker: { terminal_states: ["Done"] } });
  const orchestrator = new Orchestrator(settings);
  const issue = makeIssue();

  await claimEntry(orchestrator, issue);
  await orchestrator.finishAsync(issue.id, 0, true);
  assert.equal(orchestrator.snapshot().retrying.length, 1);

  const doneIssue = normalizeIssue({
    ...issue,
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    state: "Done",
    stateType: "completed",
  });
  await orchestrator.eligibleIssuesAsync([doneIssue]);
  assert.equal(orchestrator.snapshot().retrying.length, 0);
});

test("eligibleIssuesAsync - issue with unresolved blockers excluded", async () => {
  const settings = parseConfig({ tracker: { terminal_states: ["Done"] } });
  const orchestrator = new Orchestrator(settings);
  const blockedIssue = normalizeIssue({
    id: "blocked",
    identifier: "MT-BLOCKED",
    title: "Blocked",
    state: { name: "Todo", type: "unstarted" },
    blockers: [{ id: "dep-1", identifier: "MT-DEP", state: "In Progress" }],
  });

  const eligible = await orchestrator.eligibleIssuesAsync([blockedIssue]);
  assert.deepEqual(eligible, []);
});

// --- ClockPort ---

test("Orchestrator — accepts custom ClockPort for deterministic time assertions", async () => {
  const fixedTime = new Date("2025-06-01T12:00:00Z");
  const clock = fakeClock(fixedTime);
  const orchestrator = new Orchestrator(parseConfig(), clock);
  const issue = makeIssue();

  const entry = await claimEntry(orchestrator, issue);
  assert.equal(entry?.startedAt.getTime(), fixedTime.getTime());
});
