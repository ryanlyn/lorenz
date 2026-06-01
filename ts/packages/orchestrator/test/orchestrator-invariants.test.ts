import { test, describe } from "vitest";
import fc from "fast-check";
import { defaultSettings, parseConfig } from "@symphony/config";
import { slotKey } from "@symphony/dispatch";
import type { Issue, RunningEntry, Settings } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import { Orchestrator } from "@symphony/orchestrator";

// --- Helpers ---

function makeClock(baseMs: number) {
  let now = baseMs;
  let monotonic = 0;
  return {
    now: () => new Date(now),
    monotonicMs: () => monotonic,
    setTimeout: (_cb: () => void, _ms: number) => ({ unref: undefined }),
    clearTimeout: (_h: unknown) => {},
    advance(ms: number) {
      now += ms;
      monotonic += ms;
    },
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "Test issue",
    state: "Todo",
    stateType: "unstarted",
    description: null,
    branchName: null,
    url: null,
    priority: 1,
    createdAt: null,
    updatedAt: null,
    labels: [],
    blockers: [],
    assigneeId: null,
    assignedToWorker: true,
    ...overrides,
  };
}

function makeSettings(overrides: { maxConcurrent?: number; ensembleSize?: number } = {}): Settings {
  const s = defaultSettings();
  if (overrides.maxConcurrent !== undefined) s.agent.maxConcurrentAgents = overrides.maxConcurrent;
  if (overrides.ensembleSize !== undefined) s.agent.ensembleSize = overrides.ensembleSize;
  return s;
}

// ============================================================================
// DISPATCH CONCURRENCY
// ============================================================================

describe("INVARIANT: When the global concurrency cap is reached, the system SHALL NOT dispatch new work", () => {
  test("eligibleIssues blocks dispatch when running map size equals global maxConcurrentAgents", () => {
    const settings = parseConfig({ agent: { max_concurrent_agents: 2 } });
    const clock = makeClock(1000000);
    const orch = new Orchestrator(settings, clock);

    const i1 = makeIssue({ id: "i1", identifier: "T-1" });
    const i2 = makeIssue({ id: "i2", identifier: "T-2" });
    const i3 = makeIssue({ id: "i3", identifier: "T-3" });

    assert.ok(orch.claim(i1) !== null);
    assert.ok(orch.claim(i2) !== null);
    assert.equal(orch.state.running.size, 2);

    const eligible = orch.eligibleIssues([i3]);
    assert.deepEqual(eligible, []);

    const snap = orch.snapshot();
    const blockedEntry = snap.blocked.find((b) => b.issueId === "i3");
    assert.ok(blockedEntry);
    assert.equal(blockedEntry!.reason, "global_concurrency_cap");
  });
});

describe("INVARIANT: When a per-state concurrency cap is reached, the system SHALL block only issues in that state", () => {
  test("eligibleIssues applies per-state cap only to running entries in that state", () => {
    const settings = parseConfig({
      agent: { max_concurrent_agents: 10 },
      status_overrides: { Todo: { agent: { max_concurrent_agents: 1 } } },
    });
    const clock = makeClock(1000000);
    const orch = new Orchestrator(settings, clock);

    const issueA = makeIssue({ id: "todo-a", identifier: "T-A", state: "Todo" });
    const issueB = makeIssue({
      id: "ip-b",
      identifier: "T-B",
      state: "In Progress",
      stateType: "started",
    });
    const issueC = makeIssue({ id: "todo-c", identifier: "T-C", state: "Todo" });

    assert.ok(orch.claim(issueA) !== null);

    const eligible = orch.eligibleIssues([issueC, issueB]);

    assert.ok(eligible.some((i) => i.id === "ip-b"));
    assert.ok(!eligible.some((i) => i.id === "todo-c"));
  });
});

describe("INVARIANT: When dispatch is evaluated, both global and per-state caps SHALL have room simultaneously", () => {
  test("dispatch requires both global and state caps to have room simultaneously", () => {
    const settings = parseConfig({
      agent: { max_concurrent_agents: 2 },
      status_overrides: { Todo: { agent: { max_concurrent_agents: 2 } } },
    });
    const clock = makeClock(1000000);
    const orch = new Orchestrator(settings, clock);

    const a = makeIssue({ id: "a", identifier: "T-A", state: "Todo" });
    const b = makeIssue({ id: "b", identifier: "T-B", state: "Todo" });
    const c = makeIssue({
      id: "c",
      identifier: "T-C",
      state: "In Progress",
      stateType: "started",
    });

    assert.ok(orch.claim(a) !== null);
    assert.ok(orch.claim(b) !== null);

    const eligible = orch.eligibleIssues([c]);
    assert.deepEqual(eligible, []);

    const snap = orch.snapshot();
    const blockedEntry = snap.blocked.find((bl) => bl.issueId === "c");
    assert.ok(blockedEntry);
    assert.equal(blockedEntry!.reason, "global_concurrency_cap");
  });
});

describe("INVARIANT: When all worker hosts are at capacity, the system SHALL NOT dispatch new work", () => {
  test("worker host running count derived from running map entries per host", () => {
    const settings = defaultSettings();
    settings.agent.maxConcurrentAgents = 10;
    settings.worker.sshHosts = ["host-a", "host-b"];
    settings.worker.maxConcurrentAgentsPerHost = 2;
    const clock = makeClock(1000000);
    const orch = new Orchestrator(settings, clock);

    const claimed: RunningEntry[] = [];
    for (let i = 0; i < 4; i++) {
      const entry = orch.claim(makeIssue({ id: `i${i}`, identifier: `T-${i}` }));
      assert.ok(entry !== null);
      claimed.push(entry!);
    }

    // Both hosts should be at capacity (2 each)
    const fifth = orch.claim(makeIssue({ id: "i4", identifier: "T-4" }));
    assert.equal(fifth, null);

    // Finish one entry on host-a
    const hostAEntry = claimed.find((e) => e.workerHost === "host-a")!;
    clock.advance(1000);
    orch.finish(hostAEntry.issue.id, hostAEntry.slotIndex, false);

    // Now a new claim should succeed and go to host-a (freed host)
    const reclaimed = orch.claim(makeIssue({ id: "i5", identifier: "T-5" }));
    assert.ok(reclaimed !== null);
    assert.equal(reclaimed!.workerHost, "host-a");
  });
});

describe("INVARIANT: When multiple hosts are tied at the lowest load, the system SHALL select the first in config order", () => {
  test("host selection picks first host in config order on equal load tie", () => {
    const settings = defaultSettings();
    settings.agent.maxConcurrentAgents = 10;
    settings.worker.sshHosts = ["host-a", "host-b", "host-c"];
    settings.worker.maxConcurrentAgentsPerHost = 3;
    const clock = makeClock(1000000);
    const orch = new Orchestrator(settings, clock);

    // All hosts at load 0: first in config order wins
    const entry1 = orch.claim(makeIssue({ id: "i1", identifier: "T-1" }));
    assert.equal(entry1!.workerHost, "host-a");

    // host-a:1, host-b:0, host-c:0 -> host-b is least-loaded first in order
    const entry2 = orch.claim(makeIssue({ id: "i2", identifier: "T-2" }));
    assert.equal(entry2!.workerHost, "host-b");

    // host-a:1, host-b:1, host-c:0 -> host-c is least-loaded
    const entry3 = orch.claim(makeIssue({ id: "i3", identifier: "T-3" }));
    assert.equal(entry3!.workerHost, "host-c");

    // host-a:1, host-b:1, host-c:1 -> all tied at 1, first in config order
    const entry4 = orch.claim(makeIssue({ id: "i4", identifier: "T-4" }));
    assert.equal(entry4!.workerHost, "host-a");
  });
});

// ============================================================================
// CLAIM LIFECYCLE
// ============================================================================

describe("INVARIANT: When a slot is already claimed, a repeated claim for the same issue SHALL return null", () => {
  test("claimed slot cannot be double-claimed by repeated claim calls", () => {
    const settings = makeSettings({ maxConcurrent: 10, ensembleSize: 1 });
    const clock = makeClock(1000000);
    const orch = new Orchestrator(settings, clock);
    const issue = makeIssue();

    const first = orch.claim(issue);
    assert.ok(first !== null);

    const second = orch.claim(issue);
    assert.equal(second, null);

    assert.equal(orch.state.claimed.has(slotKey(issue.id, 0)), true);
    assert.equal(orch.state.running.size, 1);
  });
});

describe("INVARIANT: When a claim succeeds, the retryAttempts entry for that issue SHALL be deleted", () => {
  test("successful claim deletes the retryAttempts entry for the issue", () => {
    const clock = makeClock(1000000);
    const settings = makeSettings({ maxConcurrent: 10 });
    const orch = new Orchestrator(settings, clock);
    const issue = makeIssue();

    const entry = orch.claim(issue);
    assert.ok(entry !== null);
    clock.advance(1000);
    orch.finish(issue.id, 0, true, undefined, "continuation");

    const snap1 = orch.snapshot();
    assert.equal(snap1.retrying.length, 1);

    // Advance past due time
    clock.advance(10000);
    const entry2 = orch.claim(issue);
    assert.ok(entry2 !== null);

    assert.equal(orch.state.retryAttempts.has(issue.id), false);
    assert.equal(orch.snapshot().retrying.length, 0);
  });
});

describe("INVARIANT: When an entry is finished, its slot key SHALL be removed from both the running map and claimed set", () => {
  test("finish removes slot key from running map and claimed set", () => {
    const clock = makeClock(1000000);
    const settings = makeSettings({ maxConcurrent: 10 });
    const orch = new Orchestrator(settings, clock);
    const issue = makeIssue();

    orch.claim(issue);
    assert.equal(orch.state.running.has(slotKey(issue.id, 0)), true);
    assert.equal(orch.state.claimed.has(slotKey(issue.id, 0)), true);

    clock.advance(5000);
    orch.finish(issue.id, 0, false);

    assert.equal(orch.state.running.has(slotKey(issue.id, 0)), false);
    assert.equal(orch.state.claimed.has(slotKey(issue.id, 0)), false);
    assert.equal(orch.snapshot().running.length, 0);
  });
});

describe("INVARIANT: When all ensemble slots are claimed, the system SHALL return null on subsequent claim attempts", () => {
  test("issue with all ensemble slots claimed returns null on subsequent claim", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (ensembleSize) => {
        const clock = makeClock(1000000);
        const settings = makeSettings({ maxConcurrent: 20, ensembleSize });
        const orch = new Orchestrator(settings, clock);
        const issue = makeIssue();

        for (let i = 0; i < ensembleSize; i++) {
          const entry = orch.claim(issue);
          assert.ok(entry !== null);
          assert.equal(entry!.slotIndex, i);
        }

        assert.equal(orch.claim(issue), null);
        assert.equal(orch.eligibleIssues([issue]).length, 0);
      }),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When a retry becomes due, stale claimed slots SHALL be released and re-dispatch SHALL proceed", () => {
  test("stale claim released when retry becomes due and re-dispatch proceeds", () => {
    const clock = makeClock(1000000);
    const settings = makeSettings({ maxConcurrent: 10 });
    const orch = new Orchestrator(settings, clock);
    const issue = makeIssue();

    // Add stale claim (claimed but NOT running)
    orch.state.claimed.add(slotKey(issue.id, 0));

    // Set a retry entry with monotonicDeadlineMs in the past
    orch.state.retryAttempts.set(issue.id, {
      issueId: issue.id,
      identifier: issue.identifier,
      attempt: 1,
      monotonicDeadlineMs: clock.monotonicMs() - 1,
      dueAtIso: new Date(clock.now().getTime() - 1000).toISOString(),
      error: "agent exited",
    });

    // claim should release the stale claim and succeed
    const claimed = orch.claim(issue);
    assert.ok(claimed !== null);
    assert.equal(claimed!.slotIndex, 0);
    assert.equal(orch.snapshot().retrying.length, 0);
  });
});

// ============================================================================
// RUNNING ENTRY UPDATES
// ============================================================================

describe("INVARIANT: When an update targets a nonexistent slot key, the system SHALL NOT throw or mutate state", () => {
  test("applyUpdate with nonexistent slotKey does not throw and does not mutate state", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 100 }),
        (issueId, slotIndex) => {
          const clock = makeClock(1000000);
          const settings = makeSettings({ maxConcurrent: 10 });
          const orch = new Orchestrator(settings, clock);

          const existing = makeIssue({ id: "existing-1", identifier: "E-1" });
          orch.claim(existing);

          const snapBefore = JSON.stringify(orch.snapshot());
          if (slotKey(issueId, slotIndex) === slotKey("existing-1", 0)) return;

          orch.applyUpdate(issueId, slotIndex, {
            type: "turn_completed",
            sessionId: "s1",
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          });
          const snapAfter = JSON.stringify(orch.snapshot());

          assert.equal(snapBefore, snapAfter);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When a turn_completed event is applied, turnCount SHALL increment by exactly one", () => {
  test("turnCount increments by exactly one per turn_completed event", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (numTurns) => {
        const clock = makeClock(1000000);
        const settings = makeSettings({ maxConcurrent: 10 });
        const orch = new Orchestrator(settings, clock);
        const issue = makeIssue();

        orch.claim(issue);

        for (let i = 0; i < numTurns; i++) {
          orch.applyUpdate(issue.id, 0, { type: "turn_completed" });
        }

        const running = orch.state.running.get(slotKey(issue.id, 0));
        assert.equal(running!.turnCount, numTurns);

        // Non-turn_completed events do NOT increment turnCount
        orch.applyUpdate(issue.id, 0, { type: "usage", usage: { inputTokens: 10 } });
        assert.equal(running!.turnCount, numTurns);
      }),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When a usage update reports lower values, entry usageTotals SHALL NOT decrease", () => {
  test("entry usageTotals never decrease even when update reports lower values", () => {
    const clock = makeClock(1000000);
    const settings = makeSettings({ maxConcurrent: 10 });
    const orch = new Orchestrator(settings, clock);
    const issue = makeIssue();

    orch.claim(issue);

    orch.applyUpdate(issue.id, 0, {
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    // Report lower values
    orch.applyUpdate(issue.id, 0, {
      type: "usage",
      usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
    });

    const snap = orch.snapshot();
    assert.equal(snap.running[0]!.usageTotals.inputTokens, 100);
    assert.equal(snap.running[0]!.usageTotals.outputTokens, 50);
    assert.equal(snap.running[0]!.usageTotals.totalTokens, 150);
  });
});

describe("INVARIANT: When global usage totals are updated, growth SHALL be bounded by positive deltas from highwater marks", () => {
  test("global usageTotals only accumulates positive deltas from lastReported highwater marks", () => {
    const clock = makeClock(1000000);
    const settings = makeSettings({ maxConcurrent: 10 });
    const orch = new Orchestrator(settings, clock);
    const issue = makeIssue();

    orch.claim(issue);

    // First update: global totals become 100/50/150
    orch.applyUpdate(issue.id, 0, {
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    assert.equal(orch.state.usageTotals.inputTokens, 100);
    assert.equal(orch.state.usageTotals.outputTokens, 50);
    assert.equal(orch.state.usageTotals.totalTokens, 150);

    // Regression: global totals should remain unchanged (delta clamped to 0)
    orch.applyUpdate(issue.id, 0, {
      type: "usage",
      usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
    });
    assert.equal(orch.state.usageTotals.inputTokens, 100);
    assert.equal(orch.state.usageTotals.outputTokens, 50);
    assert.equal(orch.state.usageTotals.totalTokens, 150);

    // Increase past highwater: delta of 20/10/30 added to previous 100/50/150
    orch.applyUpdate(issue.id, 0, {
      type: "usage",
      usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180 },
    });
    assert.equal(orch.state.usageTotals.inputTokens, 120);
    assert.equal(orch.state.usageTotals.outputTokens, 60);
    assert.equal(orch.state.usageTotals.totalTokens, 180);
  });
});

describe("INVARIANT: When a running issue is refreshed, the update SHALL propagate to every ensemble slot for that issue", () => {
  test("refreshRunningIssue updates issue object on every ensemble slot for the same issue", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 5 }), (ensembleSize) => {
        const clock = makeClock(1000000);
        const settings = makeSettings({ maxConcurrent: 20, ensembleSize });
        const orch = new Orchestrator(settings, clock);
        const issue = makeIssue();

        for (let i = 0; i < ensembleSize; i++) {
          orch.claim(issue);
        }

        const updatedIssue = makeIssue({ state: "In Progress", stateType: "started" });
        orch.refreshRunningIssue(updatedIssue);

        const snap = orch.snapshot();
        for (let i = 0; i < ensembleSize; i++) {
          const entry = orch.state.running.get(slotKey(issue.id, i));
          assert.equal(entry!.issue.state, "In Progress");
        }
        assert.equal(snap.running.length, ensembleSize);
      }),
      { numRuns: 200 },
    );
  });
});

// ============================================================================
// ORCHESTRATOR COMPLETION
// ============================================================================

describe("INVARIANT: When an issue is cleaned up, all running entries, claimed slots, and retry state SHALL be removed", () => {
  test("cleanupIssue removes all running entries, claimed slots, and retry for the issue", () => {
    const clock = makeClock(1000000);
    const settings = makeSettings({ maxConcurrent: 20, ensembleSize: 2 });
    const orch = new Orchestrator(settings, clock);
    const issue = makeIssue();

    // Claim both ensemble slots
    orch.claim(issue);
    orch.claim(issue);

    // Finish slot 0 to create retry entry
    clock.advance(1000);
    orch.finish(issue.id, 0, true, undefined, "continuation");

    // Confirm state before cleanup
    assert.equal(orch.state.running.has(slotKey(issue.id, 1)), true);
    assert.equal(orch.state.claimed.has(slotKey(issue.id, 1)), true);
    assert.equal(orch.state.retryAttempts.has(issue.id), true);

    orch.cleanupIssue(issue.id);

    assert.equal(orch.state.running.size, 0);
    assert.equal(orch.state.claimed.size, 0);
    assert.equal(orch.state.retryAttempts.has(issue.id), false);
    assert.equal(orch.state.completed.has(issue.id), true);
  });
});

describe("INVARIANT: When an entry is finished, elapsed seconds SHALL be computed from startedAt to clock.now and accumulated", () => {
  test("finish computes elapsed seconds from startedAt to clock.now and accumulates", () => {
    const clock = makeClock(new Date("2025-01-01T00:00:00Z").getTime());
    const settings = makeSettings({ maxConcurrent: 10 });
    const orch = new Orchestrator(settings, clock);

    const issue1 = makeIssue({ id: "i1", identifier: "T-1" });
    orch.claim(issue1);

    clock.advance(30_000);
    orch.finish(issue1.id, 0, false);
    assert.equal(orch.snapshot().usageTotals.secondsRunning, 30);

    const issue2 = makeIssue({ id: "i2", identifier: "T-2" });
    orch.claim(issue2);

    clock.advance(15_000);
    orch.finish(issue2.id, 0, false);
    assert.equal(orch.snapshot().usageTotals.secondsRunning, 45);
  });
});

describe("INVARIANT: When a continuation finish occurs, the issue SHALL be added to both the completed set AND retryAttempts (scheduling re-dispatch)", () => {
  test("continuation finish adds issue to completed set and creates retry entry for re-dispatch", () => {
    const clock = makeClock(1000000);
    const settings = makeSettings({ maxConcurrent: 10 });
    const orch = new Orchestrator(settings, clock);
    const issue = makeIssue();

    orch.claim(issue);
    clock.advance(5000);
    orch.finish(issue.id, 0, true, undefined, "continuation");

    const snap = orch.snapshot();
    assert.equal(snap.retrying.length, 1);
    assert.equal(snap.retrying[0]!.issueId, issue.id);
    assert.equal(snap.retrying[0]!.attempt, 1);

    // Issue is tracked in completed set
    assert.equal(orch.state.completed.has(issue.id), true);
    // But retryAttempts still holds the re-dispatch schedule
    assert.equal(orch.state.retryAttempts.has(issue.id), true);
  });
});

describe("INVARIANT: When a snapshot is taken, its arrays and objects SHALL be independent copies that do not alias internals", () => {
  test("snapshot arrays and objects are independent copies that do not alias orchestrator internals", () => {
    const clock = makeClock(1000000);
    const settings = makeSettings({ maxConcurrent: 10 });
    const orch = new Orchestrator(settings, clock);
    const issue = makeIssue();

    orch.claim(issue);
    clock.advance(5000);
    orch.finish(issue.id, 0, true, undefined, "continuation");

    // Take first snapshot and mutate it
    const snap1 = orch.snapshot();
    snap1.running.push({} as RunningEntry);
    snap1.usageTotals.inputTokens = 99999;
    snap1.blocked.push({} as any);
    snap1.retrying.push({} as any);

    // Take second snapshot - should be unaffected
    const snap2 = orch.snapshot();
    assert.equal(snap2.running.length, 0); // issue was finished, no longer running
    assert.equal(snap2.usageTotals.inputTokens, 0);
    assert.equal(snap2.blocked.length, 0);
    assert.equal(snap2.retrying.length, 1); // only the real retry entry

    // Also verify internal state was not affected
    assert.notEqual(orch.state.usageTotals.inputTokens, 99999);
  });
});
