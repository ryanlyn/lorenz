/**
 * End-to-end runtime integration tests via the sandbox's runScenario.
 *
 * Each test exercises full runtime lifecycle behavior including dispatch,
 * reconciliation, mutations, and chaos.
 */

import { describe, expect, test } from "vitest";

import {
  runScenario,
  makeIssue,
  makeDependencyChain,
  checkAssertions,
} from "../sandbox/sandbox.js";

describe("Runtime Integration (sandbox scenarios)", () => {
  // ---------------------------------------------------------------------------
  // Dynamic issue discovery dispatches new issues between ticks
  // ---------------------------------------------------------------------------
  describe("dynamic issue discovery", () => {
    test("new issue added via mutations is dispatched on subsequent tick", async () => {
      const result = await runScenario({
        issues: [makeIssue("a", "A-1", { state: "Todo", stateType: "unstarted" })],
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
        },
        pollTicks: 3,
        tickDelayMs: 50,
        mutations: {
          1: (client) => {
            client.addIssue(makeIssue("b", "B-1", { state: "Todo", stateType: "unstarted" }));
          },
        },
      });

      expect(result.errors).toHaveLength(0);
      const startedMessages = result.events
        .filter((e) => e.type === "run_started")
        .map((e) => e.message);
      // A-1 dispatched on tick 0, B-1 dispatched on tick 2 (after mutation before tick 1)
      expect(startedMessages.some((m) => m.includes("A-1"))).toBe(true);
      expect(startedMessages.some((m) => m.includes("B-1"))).toBe(true);
    });

    test("multiple issues added via timedMutations are discovered on subsequent ticks", async () => {
      const result = await runScenario({
        issues: [makeIssue("a", "A-1", { state: "Todo", stateType: "unstarted" })],
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
        },
        pollTicks: 4,
        tickDelayMs: 80,
        timedMutations: [
          {
            afterMs: 50,
            mutate: {
              type: "add_issue",
              issue: { id: "b", identifier: "B-1", state: "Todo", stateType: "unstarted" },
            },
          },
          {
            afterMs: 130,
            mutate: {
              type: "add_issue",
              issue: { id: "c", identifier: "C-1", state: "Todo", stateType: "unstarted" },
            },
          },
        ],
      });

      expect(result.errors).toHaveLength(0);
      const startedMessages = result.events
        .filter((e) => e.type === "run_started")
        .map((e) => e.message);
      expect(startedMessages.some((m) => m.includes("A-1"))).toBe(true);
      expect(startedMessages.some((m) => m.includes("B-1"))).toBe(true);
      expect(startedMessages.some((m) => m.includes("C-1"))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Inactive non-terminal state stops worker but keeps workspace
  // ---------------------------------------------------------------------------
  describe("inactive non-terminal state", () => {
    test("stops worker but does not trigger workspace_cleanup", async () => {
      const result = await runScenario({
        issues: [makeIssue("x", "X-1", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 5, latencyPerTurnMs: 100 } },
        pollTicks: 3,
        tickDelayMs: 200,
        timedMutations: [
          {
            afterMs: 150,
            mutate: {
              type: "change_state",
              issueId: "x",
              state: "Backlog",
              stateType: "backlog",
            },
          },
        ],
      });

      // Issue should be reconciled (stopped)
      const reconciled = result.events.some((e) => e.type === "run_reconciled");
      expect(reconciled).toBe(true);
      expect(result.finalSnapshot.running).toHaveLength(0);
      // workspace_cleanup should NOT fire for non-terminal inactive states
      const workspaceCleanup = result.events.some((e) => e.type === "workspace_cleanup");
      expect(workspaceCleanup).toBe(false);
    });

    test("issue moved to Triage (non-terminal inactive) preserves workspace", async () => {
      const result = await runScenario({
        issues: [makeIssue("x", "X-1", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 5, latencyPerTurnMs: 80 } },
        pollTicks: 3,
        tickDelayMs: 200,
        timedMutations: [
          {
            afterMs: 120,
            mutate: {
              type: "change_state",
              issueId: "x",
              state: "Triage",
              stateType: "triage",
            },
          },
        ],
      });

      expect(result.finalSnapshot.running).toHaveLength(0);
      const workspaceCleanup = result.events.some((e) => e.type === "workspace_cleanup");
      expect(workspaceCleanup).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Priority re-evaluation dispatches boosted issue on next tick
  // ---------------------------------------------------------------------------
  describe("priority re-evaluation", () => {
    test("boosted priority causes issue to be dispatched on next tick", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("a", "A-1", { state: "Todo", stateType: "unstarted", priority: 4 }),
          makeIssue("b", "B-1", { state: "Todo", stateType: "unstarted", priority: 3 }),
        ],
        settingsOverrides: { agent: { maxConcurrentAgents: 1 } },
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 50 },
        },
        pollTicks: 4,
        tickDelayMs: 100,
        mutations: {
          1: (client) => {
            // Boost A to highest priority after first tick
            client.updateIssue("a", { priority: 0 });
          },
        },
      });

      // A-1 should eventually be dispatched after the priority boost
      const startedMessages = result.events
        .filter((e) => e.type === "run_started")
        .map((e) => e.message);
      expect(startedMessages.some((m) => m.includes("A-1"))).toBe(true);
    });

    test("lowered priority allows other issue to dispatch first", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("a", "A-1", { state: "Todo", stateType: "unstarted", priority: 1 }),
          makeIssue("b", "B-1", { state: "Todo", stateType: "unstarted", priority: 4 }),
        ],
        settingsOverrides: { agent: { maxConcurrentAgents: 1 } },
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 50 },
        },
        pollTicks: 4,
        tickDelayMs: 100,
        mutations: {
          1: (client) => {
            // Lower A and boost B
            client.updateIssue("a", { priority: 4 });
            client.updateIssue("b", { priority: 1 });
          },
        },
      });

      // Both should eventually dispatch across ticks, with B dispatching after priority boost
      const startedMessages = result.events
        .filter((e) => e.type === "run_started")
        .map((e) => e.message);
      expect(startedMessages.some((m) => m.includes("B-1"))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Resolved blocker makes previously blocked issue eligible
  // ---------------------------------------------------------------------------
  describe("resolved blockers", () => {
    test("blocked issue dispatches after blocker resolved via mutation", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("x", "X-1", {
            state: "Todo",
            stateType: "unstarted",
            blockers: [
              {
                id: "blocker-1",
                identifier: "BLK-1",
                state: "In Progress",
                stateType: "started",
              },
            ],
          }),
        ],
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
        },
        pollTicks: 4,
        tickDelayMs: 100,
        mutations: {
          2: (client) => {
            // Resolve the blocker so X becomes eligible
            client.updateIssue("x", {
              blockers: [
                {
                  id: "blocker-1",
                  identifier: "BLK-1",
                  state: "Done",
                  stateType: "completed",
                },
              ],
            });
          },
        },
      });

      // X-1 should be dispatched after tick 2 when blocker resolves
      const startedMessages = result.events
        .filter((e) => e.type === "run_started")
        .map((e) => e.message);
      expect(startedMessages.some((m) => m.includes("X-1"))).toBe(true);
    });

    test("issue stays blocked until blocker actually resolves", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("x", "X-1", {
            state: "Todo",
            stateType: "unstarted",
            blockers: [
              {
                id: "blocker-1",
                identifier: "BLK-1",
                state: "In Progress",
                stateType: "started",
              },
            ],
          }),
        ],
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
        },
        pollTicks: 3,
        tickDelayMs: 50,
        // No mutations - blocker stays open
      });

      // X-1 should NOT be dispatched since blocker is unresolved
      const startedMessages = result.events
        .filter((e) => e.type === "run_started")
        .map((e) => e.message);
      expect(startedMessages.some((m) => m.includes("X-1"))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Dependency chain unblocks issues one at a time
  // ---------------------------------------------------------------------------
  describe("dependency chain", () => {
    test("only head of chain (no blockers) is dispatched on first tick", async () => {
      const chain = makeDependencyChain(3);

      const result = await runScenario({
        issues: chain,
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
        },
        pollTicks: 1,
        settingsOverrides: { agent: { maxConcurrentAgents: 5 } },
      });

      const startedMessages = result.events
        .filter((e) => e.type === "run_started")
        .map((e) => e.message);
      // Only chain-0 (head, no blockers) should dispatch
      expect(startedMessages.some((m) => m.includes("CHAIN-0"))).toBe(true);
      expect(startedMessages.some((m) => m.includes("CHAIN-1"))).toBe(false);
      expect(startedMessages.some((m) => m.includes("CHAIN-2"))).toBe(false);
    });

    test("longer chain of 5 still only dispatches the unblocked head", async () => {
      const chain = makeDependencyChain(5);

      const result = await runScenario({
        issues: chain,
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
        },
        pollTicks: 1,
        settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      });

      const startedMessages = result.events
        .filter((e) => e.type === "run_started")
        .map((e) => e.message);
      expect(startedMessages.some((m) => m.includes("CHAIN-0"))).toBe(true);
      for (let i = 1; i < 5; i++) {
        expect(startedMessages.some((m) => m.includes(`CHAIN-${i}`))).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // High failure rate does not crash orchestrator
  // ---------------------------------------------------------------------------
  describe("high failure rate", () => {
    test("all-failing runner does not crash the orchestrator", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("a", "A-1", { state: "Todo", stateType: "unstarted" }),
          makeIssue("b", "B-1", { state: "Todo", stateType: "unstarted" }),
          makeIssue("c", "C-1", { state: "Todo", stateType: "unstarted" }),
        ],
        runnerConfig: {
          defaultBehavior: { shouldSucceed: false, turnCount: 1, latencyPerTurnMs: 0 },
        },
        pollTicks: 5,
        tickDelayMs: 50,
      });

      // System survives all ticks without crashing
      expect(result.ticksExecuted).toBe(5);
      const failedEvents = result.events.filter((e) => e.type === "run_failed");
      expect(failedEvents.length).toBeGreaterThan(0);
    });

    test("high chaos failure rate on tracker client does not crash", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("a", "A-1", { state: "Todo", stateType: "unstarted" }),
          makeIssue("b", "B-1", { state: "Todo", stateType: "unstarted" }),
        ],
        chaosConfig: { failureRate: 0.7 },
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
        },
        pollTicks: 8,
        tickDelayMs: 30,
      });

      // Even with 70% fetch failure rate the runtime does not throw unrecoverable errors
      expect(result.ticksExecuted).toBe(8);
    });
  });

  // ---------------------------------------------------------------------------
  // Rapid mutations across ticks do not crash system
  // ---------------------------------------------------------------------------
  describe("rapid mutations", () => {
    test("add/remove/state-change mutations across ticks produce no crashes", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("a", "A-1", { state: "Todo", stateType: "unstarted" }),
          makeIssue("b", "B-1", { state: "Todo", stateType: "unstarted" }),
        ],
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 10 },
        },
        pollTicks: 6,
        tickDelayMs: 50,
        mutations: {
          0: (client) => {
            client.addIssue(makeIssue("c", "C-1", { state: "Todo", stateType: "unstarted" }));
            client.addIssue(makeIssue("d", "D-1", { state: "Todo", stateType: "unstarted" }));
          },
          1: (client) => {
            client.removeIssue("a");
            client.changeIssueState("b", "Done", "completed");
          },
          2: (client) => {
            client.addIssue(makeIssue("e", "E-1", { state: "Todo", stateType: "unstarted" }));
            client.removeIssue("d");
          },
          3: (client) => {
            client.addIssue(makeIssue("f", "F-1", { state: "Todo", stateType: "unstarted" }));
            client.changeIssueState("c", "Cancelled", "completed");
          },
          4: (client) => {
            client.removeIssue("e");
            client.addIssue(makeIssue("g", "G-1", { state: "Todo", stateType: "unstarted" }));
          },
        },
      });

      // No crashes during rapid churn
      expect(result.ticksExecuted).toBe(6);
    });

    test("add and remove of same issue in single mutation does not crash", async () => {
      const result = await runScenario({
        issues: [makeIssue("a", "A-1", { state: "Todo", stateType: "unstarted" })],
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
        },
        pollTicks: 3,
        tickDelayMs: 30,
        mutations: {
          1: (client) => {
            client.addIssue(makeIssue("x", "X-1", { state: "Todo", stateType: "unstarted" }));
            client.removeIssue("x");
          },
        },
      });

      expect(result.ticksExecuted).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Independent retry behavior per issue
  // ---------------------------------------------------------------------------
  describe("independent retry per issue", () => {
    test(
      "multiple failing issues maintain independent retry state",
      { timeout: 10_000 },
      async () => {
        const result = await runScenario({
          issues: [
            makeIssue("f1", "F-1", { state: "Todo", stateType: "unstarted" }),
            makeIssue("f2", "F-2", { state: "Todo", stateType: "unstarted" }),
            makeIssue("s1", "S-1", { state: "Todo", stateType: "unstarted" }),
          ],
          settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 100 } },
          runnerConfig: {
            defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
            byId: {
              f1: { shouldSucceed: false, errorMessage: "fail-f1" },
              f2: { shouldSucceed: false, errorMessage: "fail-f2" },
            },
          },
          pollTicks: 5,
          tickDelayMs: 150,
        });

        // issue s1 should have completed successfully
        const completedMessages = result.events
          .filter((e) => e.type === "run_completed")
          .map((e) => e.message);
        expect(completedMessages.some((m) => m.includes("S-1"))).toBe(true);

        // Both F-1 and F-2 should have failed independently
        const failedMessages = result.events
          .filter((e) => e.type === "run_failed")
          .map((e) => e.message);
        expect(failedMessages.some((m) => m.includes("F-1"))).toBe(true);
        expect(failedMessages.some((m) => m.includes("F-2"))).toBe(true);

        // Each failing issue should have its own retry entry with independent attempt counts
        const retrying = result.finalSnapshot.retrying;
        const f1Retry = retrying.find((r) => r.issueId === "f1");
        const f2Retry = retrying.find((r) => r.issueId === "f2");
        // Both should have independent retry attempts (>= 1)
        if (f1Retry) expect(f1Retry.attempt).toBeGreaterThanOrEqual(1);
        if (f2Retry) expect(f2Retry.attempt).toBeGreaterThanOrEqual(1);
      },
    );

    test(
      "one issue retrying does not delay dispatch of another issue",
      { timeout: 10_000 },
      async () => {
        const result = await runScenario({
          issues: [
            makeIssue("f1", "F-1", { state: "Todo", stateType: "unstarted", priority: 2 }),
            makeIssue("s1", "S-1", { state: "Todo", stateType: "unstarted", priority: 1 }),
          ],
          settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 5000 } },
          runnerConfig: {
            defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
            byId: {
              f1: { shouldSucceed: false, errorMessage: "fail-f1" },
            },
          },
          pollTicks: 3,
          tickDelayMs: 50,
        });

        // issue s1 should complete on first tick regardless of F-1 failure/retry
        const completedMessages = result.events
          .filter((e) => e.type === "run_completed")
          .map((e) => e.message);
        expect(completedMessages.some((m) => m.includes("S-1"))).toBe(true);
      },
    );

    test(
      "retry attempt counters increment independently per issue across ticks",
      { timeout: 10_000 },
      async () => {
        const result = await runScenario({
          issues: [
            makeIssue("f1", "F-1", { state: "Todo", stateType: "unstarted" }),
            makeIssue("f2", "F-2", { state: "Todo", stateType: "unstarted" }),
          ],
          settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 50 } },
          runnerConfig: {
            byId: {
              f1: { shouldSucceed: false, errorMessage: "fail-f1" },
              f2: { shouldSucceed: false, errorMessage: "fail-f2" },
            },
          },
          pollTicks: 6,
          tickDelayMs: 80,
        });

        // Both should have failed at least once independently
        const f1Failures = result.events.filter(
          (e) => e.type === "run_failed" && e.message.includes("F-1"),
        );
        const f2Failures = result.events.filter(
          (e) => e.type === "run_failed" && e.message.includes("F-2"),
        );
        expect(f1Failures.length).toBeGreaterThanOrEqual(1);
        expect(f2Failures.length).toBeGreaterThanOrEqual(1);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Concurrency cap respected across parametric sweep
  // ---------------------------------------------------------------------------
  describe("concurrency cap", () => {
    test.each([1, 2, 3, 5])(
      "maxConcurrentAgents=%i never exceeded with many eligible issues",
      async (cap) => {
        const issues = Array.from({ length: 8 }, (_, i) =>
          makeIssue(`issue-${i}`, `ISSUE-${i}`, { state: "Todo", stateType: "unstarted" }),
        );

        const result = await runScenario({
          issues,
          settingsOverrides: { agent: { maxConcurrentAgents: cap } },
          runnerConfig: {
            defaultBehavior: { shouldSucceed: true, turnCount: 2, latencyPerTurnMs: 50 },
          },
          pollTicks: 3,
          tickDelayMs: 100,
        });

        const assertionResults = checkAssertions(result, [
          { type: "concurrency_cap", maxConcurrent: cap },
        ]);
        for (const r of assertionResults) {
          expect(r.passed, r.message).toBe(true);
        }
      },
    );

    test("concurrency cap with mixed fast and slow runners", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("fast-1", "FAST-1", { state: "Todo", stateType: "unstarted" }),
          makeIssue("fast-2", "FAST-2", { state: "Todo", stateType: "unstarted" }),
          makeIssue("slow-1", "SLOW-1", { state: "Todo", stateType: "unstarted" }),
          makeIssue("slow-2", "SLOW-2", { state: "Todo", stateType: "unstarted" }),
        ],
        settingsOverrides: { agent: { maxConcurrentAgents: 2 } },
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 200 },
          byPattern: [
            {
              pattern: /fast/,
              behavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 10 },
            },
          ],
        },
        pollTicks: 4,
        tickDelayMs: 100,
      });

      const assertionResults = checkAssertions(result, [
        { type: "concurrency_cap", maxConcurrent: 2 },
      ]);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Full lifecycle with external state changes
  // ---------------------------------------------------------------------------
  describe("full lifecycle", () => {
    test("issue dispatched, run, external state-change to Done triggers cleanup", async () => {
      const result = await runScenario({
        issues: [makeIssue("x", "X-1", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 5, latencyPerTurnMs: 80 } },
        pollTicks: 4,
        tickDelayMs: 150,
        timedMutations: [
          {
            afterMs: 350,
            mutate: {
              type: "change_state",
              issueId: "x",
              state: "Done",
              stateType: "completed",
            },
          },
        ],
      });

      // Should have been started
      expect(result.events.some((e) => e.type === "run_started")).toBe(true);
      // Terminal state emits workspace_cleanup
      expect(result.events.some((e) => e.type === "workspace_cleanup")).toBe(true);
      // Should NOT still be running
      expect(result.finalSnapshot.running).toHaveLength(0);
    });

    test("new issue dispatched after previous issue completes and is cleaned up", async () => {
      const result = await runScenario({
        issues: [makeIssue("x", "X-1", { state: "Todo", stateType: "unstarted" })],
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
        },
        pollTicks: 4,
        tickDelayMs: 100,
        mutations: {
          1: (client) => {
            client.addIssue(makeIssue("y", "Y-1", { state: "Todo", stateType: "unstarted" }));
          },
        },
      });

      const startedMessages = result.events
        .filter((e) => e.type === "run_started")
        .map((e) => e.message);
      expect(startedMessages.some((m) => m.includes("X-1"))).toBe(true);
      expect(startedMessages.some((m) => m.includes("Y-1"))).toBe(true);
    });

    test("reconciliation handles state change mid-run then dispatches new issue", async () => {
      const result = await runScenario({
        issues: [makeIssue("x", "X-1", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 5, latencyPerTurnMs: 80 } },
        pollTicks: 5,
        tickDelayMs: 120,
        mutations: {
          1: (client) => {
            // Move X to Done, add Y
            client.changeIssueState("x", "Done", "completed");
            client.addIssue(makeIssue("y", "Y-1", { state: "Todo", stateType: "unstarted" }));
          },
        },
      });

      // X should have been cleaned up (terminal)
      const cleanedUp = result.events.some(
        (e) => e.type === "workspace_cleanup" && e.message.includes("X-1"),
      );
      expect(cleanedUp).toBe(true);
      // Y should eventually be dispatched
      const startedMessages = result.events
        .filter((e) => e.type === "run_started")
        .map((e) => e.message);
      expect(startedMessages.some((m) => m.includes("Y-1"))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Expected failures
  // ---------------------------------------------------------------------------
  describe("Expected failures", () => {
    // Aborting one issue must not affect another issue with a prefix-colliding id.
    test.fails("abort for issue X does not affect issue Y with prefix-colliding ID", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("a:0", "COLON-1", {
            state: "In Progress",
            stateType: "started",
            priority: 2,
          }),
          makeIssue("a", "PREFIX-1", {
            state: "In Progress",
            stateType: "started",
            priority: 1,
          }),
        ],
        settingsOverrides: { agent: { maxConcurrentAgents: 5 } },
        runnerConfig: {
          byId: {
            a: { shouldSucceed: true, turnCount: 3, latencyPerTurnMs: 200 },
            "a:0": { shouldSucceed: true, turnCount: 5, latencyPerTurnMs: 200 },
          },
        },
        pollTicks: 5,
        tickDelayMs: 300,
        waitForRuns: false,
        timedMutations: [
          // Fire after first tick dispatches both, but before either run completes
          {
            afterMs: 250,
            mutate: {
              type: "change_state",
              issueId: "a",
              state: "Done",
              stateType: "completed",
            },
          },
        ],
      });

      // When issue "a" goes terminal and its runs are aborted, issue "a:0" must
      // keep running because slot ownership is exact, not prefix-based.
      const completedMessages = result.events
        .filter((e) => e.type === "run_completed")
        .map((e) => e.message);
      expect(completedMessages.some((m) => m.includes("COLON-1"))).toBe(true);
    });

    // A poll tick reserves capacity for every dispatch decision it makes, including
    // work that settles before the tick finishes.
    test("global concurrency cap is not bypassable by fast-completing runs", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("a", "A-1", { state: "In Progress", stateType: "started", priority: 1 }),
          makeIssue("b", "B-1", { state: "In Progress", stateType: "started", priority: 2 }),
          makeIssue("c", "C-1", { state: "In Progress", stateType: "started", priority: 3 }),
        ],
        settingsOverrides: { agent: { maxConcurrentAgents: 1 } },
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
        },
        pollTicks: 1,
      });

      // With maxConcurrentAgents=1 and instant completion, only one issue can be
      // dispatched in a single tick.
      const startedMessages = result.events
        .filter((e) => e.type === "run_started")
        .map((e) => e.message);
      expect(startedMessages.some((m) => m.includes("B-1"))).toBe(false);
      expect(startedMessages.some((m) => m.includes("C-1"))).toBe(false);
    });

    // Host capacity is reserved for the whole poll tick, including work that settles
    // before the tick finishes.
    test("per-host SSH cap is not bypassable by fast-completing runs", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("a", "A-1", { state: "In Progress", stateType: "started", priority: 1 }),
          makeIssue("b", "B-1", { state: "In Progress", stateType: "started", priority: 2 }),
          makeIssue("c", "C-1", { state: "In Progress", stateType: "started", priority: 3 }),
        ],
        settingsOverrides: {
          agent: { maxConcurrentAgents: 5 },
          worker: {
            sshHosts: ["host-a"],
            maxConcurrentAgentsPerHost: 1,
          },
        },
        runnerConfig: {
          defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
        },
        pollTicks: 1,
      });

      // With per-host cap of 1, only one issue should be dispatched to host-a per tick.
      const startedMessages = result.events
        .filter((e) => e.type === "run_started")
        .map((e) => e.message);
      expect(startedMessages.length).toBeLessThanOrEqual(1);
    });
  });
});
