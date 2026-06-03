import { test } from "vitest";
import { Orchestrator, normalizeIssue, parseConfig, slotKey } from "@symphony/cli";
import type { ClockPort } from "@symphony/ports";

import { assert } from "../../../test/assert.js";

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

// --- claim ---

test("claim — null return when global concurrency cap reached", () => {
  const settings = parseConfig({ agent: { max_concurrent_agents: 1 } });
  const orchestrator = new Orchestrator(settings);
  const first = makeIssue({ id: "a", identifier: "MT-A" });
  const second = makeIssue({ id: "b", identifier: "MT-B" });

  assert.ok(orchestrator.claim(first));
  assert.equal(orchestrator.claim(second), null);
});

test("claim — null return when all ensemble slots claimed", () => {
  const settings = parseConfig({ agent: { ensemble_size: 2 } });
  const orchestrator = new Orchestrator(settings);
  const issue = makeIssue();

  assert.ok(orchestrator.claim(issue));
  assert.ok(orchestrator.claim(issue));
  assert.equal(orchestrator.claim(issue), null);
});

test("claim — null return when worker hosts at capacity", () => {
  const settings = parseConfig({
    worker: { ssh_hosts: ["host-a:2200"], max_concurrent_agents_per_host: 1 },
    agent: { max_concurrent_agents: 5 },
  });
  const orchestrator = new Orchestrator(settings);
  const first = makeIssue({ id: "a", identifier: "MT-A" });
  const second = makeIssue({ id: "b", identifier: "MT-B" });

  assert.ok(orchestrator.claim(first));
  assert.equal(orchestrator.claim(second), null);
});

test("claim — preferred slot honored on retry", () => {
  const settings = parseConfig({ agent: { ensemble_size: 3 } });
  const orchestrator = new Orchestrator(settings);
  const issue = makeIssue();

  orchestrator.state.retryAttempts.set(issue.id, {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(Date.now() - 1).toISOString(),
    slotIndex: 2,
    error: "failed",
  });

  const claimed = orchestrator.claim(issue);
  assert.equal(claimed?.slotIndex, 2);
  assert.equal(claimed?.retryAttempt, 1);
});

test("claim — non-existent retry does not interfere with fresh claim", () => {
  const settings = parseConfig();
  const orchestrator = new Orchestrator(settings);
  const issue = makeIssue();

  const claimed = orchestrator.claim(issue);
  assert.ok(claimed);
  assert.equal(claimed?.slotIndex, 0);
  assert.equal(claimed?.retryAttempt, null);
});

// --- applyUpdate ---

test("applyUpdate — unknown slotKey is silently ignored", () => {
  const orchestrator = new Orchestrator(parseConfig());
  orchestrator.applyUpdate("nonexistent", 99, {
    type: "turn_completed",
    sessionId: "s1",
  });
  assert.equal(orchestrator.snapshot().running.length, 0);
});

test("applyUpdate — turnCount increments on each turn_completed", () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  orchestrator.claim(issue);

  orchestrator.applyUpdate(issue.id, 0, { type: "turn_completed" });
  orchestrator.applyUpdate(issue.id, 0, { type: "turn_completed" });
  orchestrator.applyUpdate(issue.id, 0, { type: "turn_completed" });

  assert.equal(orchestrator.snapshot().running[0]?.turnCount, 3);
});

test("applyUpdate — rateLimits propagated to state", () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  orchestrator.claim(issue);

  const limits = { provider: "anthropic", retryAfter: 30 };
  orchestrator.applyUpdate(issue.id, 0, {
    type: "rate_limit",
    message: "rate limited by anthropic",
    rateLimits: limits,
  });

  assert.deepEqual(orchestrator.snapshot().rateLimits, limits);
});

// --- finish ---

test("finish — non-normal finish does not create retry entry", () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  orchestrator.claim(issue);

  orchestrator.finish(issue.id, 0, false, "crashed");

  assert.equal(orchestrator.snapshot().retrying.length, 0);
  assert.equal(orchestrator.snapshot().running.length, 0);
});

test("finish — secondsRunning accumulates across multiple finishes", () => {
  const now = new Date("2025-01-01T00:00:00Z");
  const clock = fakeClock(now);
  const orchestrator = new Orchestrator(parseConfig(), clock);
  const issueA = makeIssue({ id: "a", identifier: "MT-A" });
  const issueB = makeIssue({ id: "b", identifier: "MT-B" });

  orchestrator.claim(issueA);
  clock.advance(10_000);
  orchestrator.finish(issueA.id, 0, false);

  orchestrator.claim(issueB);
  clock.advance(15_000);
  orchestrator.finish(issueB.id, 0, false);

  assert.equal(orchestrator.snapshot().usageTotals.secondsRunning, 25);
});

test("finish — finishing same slot twice is idempotent (second is no-op)", () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  orchestrator.claim(issue);

  orchestrator.finish(issue.id, 0, true);
  const afterFirst = orchestrator.snapshot().usageTotals.secondsRunning;

  orchestrator.finish(issue.id, 0, true);
  assert.equal(orchestrator.snapshot().usageTotals.secondsRunning, afterFirst);
});

// --- cleanupIssue ---

test("cleanupIssue — removes running entry and claimed slot", () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  orchestrator.claim(issue);

  assert.equal(orchestrator.snapshot().running.length, 1);
  orchestrator.cleanupIssue(issue.id);
  assert.equal(orchestrator.snapshot().running.length, 0);
  assert.equal(orchestrator.state.claimed.has(slotKey(issue.id, 0)), false);
});

test("cleanupIssue — removes retry attempts for issue", () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  orchestrator.claim(issue);
  orchestrator.finish(issue.id, 0, true);
  assert.equal(orchestrator.snapshot().retrying.length, 1);

  orchestrator.cleanupIssue(issue.id);
  assert.equal(orchestrator.snapshot().retrying.length, 0);
});

test("cleanupIssue — adds issue to completed set", () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  orchestrator.claim(issue);

  orchestrator.cleanupIssue(issue.id);
  assert.equal(orchestrator.state.completed.has(issue.id), true);
});

// --- snapshot ---

test("snapshot — returns defensive copy (mutation does not affect state)", () => {
  const orchestrator = new Orchestrator(parseConfig());
  const issue = makeIssue();
  orchestrator.claim(issue);

  const snap = orchestrator.snapshot();
  snap.running.length = 0;
  snap.usageTotals.inputTokens = 9999;

  assert.equal(orchestrator.snapshot().running.length, 1);
  assert.equal(orchestrator.snapshot().usageTotals.inputTokens, 0);
});

// --- eligibleIssues ---

test("eligibleIssues — inactive issue cleared from retryAttempts", () => {
  const settings = parseConfig({ tracker: { terminal_states: ["Done"] } });
  const orchestrator = new Orchestrator(settings);
  const issue = makeIssue();

  orchestrator.claim(issue);
  orchestrator.finish(issue.id, 0, true);
  assert.equal(orchestrator.snapshot().retrying.length, 1);

  const doneIssue = normalizeIssue({
    ...issue,
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    state: "Done",
    stateType: "completed",
  });
  orchestrator.eligibleIssues([doneIssue]);
  assert.equal(orchestrator.snapshot().retrying.length, 0);
});

test("eligibleIssues — issue with unresolved blockers excluded", () => {
  const settings = parseConfig({ tracker: { terminal_states: ["Done"] } });
  const orchestrator = new Orchestrator(settings);
  const blockedIssue = normalizeIssue({
    id: "blocked",
    identifier: "MT-BLOCKED",
    title: "Blocked",
    state: { name: "Todo", type: "unstarted" },
    blockers: [{ id: "dep-1", identifier: "MT-DEP", state: "In Progress" }],
  });

  const eligible = orchestrator.eligibleIssues([blockedIssue]);
  assert.deepEqual(eligible, []);
});

// --- ClockPort ---

test("Orchestrator — accepts custom ClockPort for deterministic time assertions", () => {
  const fixedTime = new Date("2025-06-01T12:00:00Z");
  const clock = fakeClock(fixedTime);
  const orchestrator = new Orchestrator(parseConfig(), clock);
  const issue = makeIssue();

  const entry = orchestrator.claim(issue);
  assert.equal(entry?.startedAt.getTime(), fixedTime.getTime());
});
