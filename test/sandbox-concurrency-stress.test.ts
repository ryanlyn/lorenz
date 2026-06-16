import { describe, test, expect } from "vitest";

import {
  runScenario,
  makeIssue,
  makeDependencyChain,
  checkAssertions,
} from "../sandbox/sandbox.js";
import type { SandboxScenario, ChaosLinearClient } from "../sandbox/sandbox.js";

describe("Sandbox: Concurrency and Stress", () => {
  // ---------------------------------------------------------------------------
  // No starvation under load
  // ---------------------------------------------------------------------------
  test(
    "no starvation: all 20 issues eventually dispatched under cap=5",
    { timeout: 15_000 },
    async () => {
      const maxConcurrentAgents = 5;
      const issues = Array.from({ length: 20 }, (_, i) =>
        makeIssue(`traffic-${i}`, `TRAFFIC-${i}`, { priority: 2 }),
      );

      const result = await runScenario({
        issues,
        settingsOverrides: { agent: { maxConcurrentAgents, maxRetryBackoffMs: 1000 } },
        runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 5 } },
        pollTicks: Math.ceil(issues.length / maxConcurrentAgents),
      });

      const startedIssueIds = new Set(
        result.events.filter((e) => e.type === "run_started").map((e) => e.message.split(" ")[0]),
      );
      expect(startedIssueIds).toEqual(new Set(issues.map((issue) => issue.identifier)));

      const capResults = checkAssertions(result, [
        { type: "concurrency_cap", maxConcurrent: maxConcurrentAgents },
      ]);
      for (const r of capResults) {
        expect(r.passed).toBe(true);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // High load
  // ---------------------------------------------------------------------------
  test("high load: 20 issues, cap=5, 5 ticks, no errors", { timeout: 10_000 }, async () => {
    const issues = Array.from({ length: 20 }, (_, i) =>
      makeIssue(`load-${i}`, `LOAD-${i}`, { priority: 2 }),
    );

    const result = await runScenario({
      issues,
      settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 100 } },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 5 } },
      pollTicks: 5,
      tickDelayMs: 30,
    });

    const assertionResults = checkAssertions(result, [
      { type: "no_errors" },
      { type: "concurrency_cap", maxConcurrent: 5 },
    ]);
    for (const r of assertionResults) {
      expect(r.passed).toBe(true);
    }

    // Verify all 5 ticks executed
    expect(result.ticksExecuted).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // Chaos rate sweep
  // ---------------------------------------------------------------------------
  test.each([0.1, 0.5, 0.9])(
    "chaos rate sweep: failure rate %f does not crash the system",
    { timeout: 10_000 },
    async (failureRate) => {
      const issues = Array.from({ length: 5 }, (_, i) =>
        makeIssue(`chaos-${i}`, `CHAOS-${i}`, { priority: 2 }),
      );

      // The system should not throw even under high chaos;
      // errors in result.errors are acceptable, but no unhandled exceptions
      const result = await runScenario({
        issues,
        settingsOverrides: { agent: { maxConcurrentAgents: 3, maxRetryBackoffMs: 50 } },
        chaosConfig: { failureRate },
        runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 5 } },
        pollTicks: 5,
        tickDelayMs: 20,
      });

      // The scenario completed without throwing
      expect(result.ticksExecuted).toBe(5);
      // Concurrency cap is still respected even under failures
      const capResults = checkAssertions(result, [{ type: "concurrency_cap", maxConcurrent: 3 }]);
      for (const r of capResults) {
        expect(r.passed).toBe(true);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Rapid mutations
  // ---------------------------------------------------------------------------
  test(
    "rapid mutations: 10 mutations across 5 ticks, system stable",
    { timeout: 10_000 },
    async () => {
      const issues = Array.from({ length: 5 }, (_, i) =>
        makeIssue(`mut-${i}`, `MUT-${i}`, { priority: 2 }),
      );

      const mutations: SandboxScenario["mutations"] = {
        0: (client: ChaosLinearClient) => {
          client.addIssue(makeIssue("mut-new-0", "MUT-NEW-0", { priority: 1 }));
          client.addIssue(makeIssue("mut-new-1", "MUT-NEW-1", { priority: 3 }));
        },
        1: (client: ChaosLinearClient) => {
          client.removeIssue("mut-0");
          client.changeIssueState("mut-1", "Done", "completed");
        },
        2: (client: ChaosLinearClient) => {
          client.addIssue(makeIssue("mut-new-2", "MUT-NEW-2", { priority: 1 }));
          client.updateIssue("mut-2", { priority: 1 });
        },
        3: (client: ChaosLinearClient) => {
          client.removeIssue("mut-new-0");
          client.changeIssueState("mut-3", "In Progress", "started");
        },
        4: (client: ChaosLinearClient) => {
          client.addIssue(makeIssue("mut-new-3", "MUT-NEW-3", { priority: 2 }));
          client.changeIssueState("mut-4", "Done", "completed");
        },
      };

      const result = await runScenario({
        issues,
        settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 50 } },
        runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 5 } },
        pollTicks: 5,
        tickDelayMs: 30,
        mutations,
      });

      // System did not crash, all ticks completed
      expect(result.ticksExecuted).toBe(5);
      // Concurrency cap still holds
      const capResults = checkAssertions(result, [{ type: "concurrency_cap", maxConcurrent: 5 }]);
      for (const r of capResults) {
        expect(r.passed).toBe(true);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Ensemble slot management
  // ---------------------------------------------------------------------------
  test(
    "ensemble slot management: 3 issues with ensemble:2, cap=4, correct slot arithmetic",
    { timeout: 10_000 },
    async () => {
      const issues = [
        makeIssue("ens-a", "ENS-A", { priority: 1, labels: ["ensemble:2"] }),
        makeIssue("ens-b", "ENS-B", { priority: 2, labels: ["ensemble:2"] }),
        makeIssue("ens-c", "ENS-C", { priority: 3, labels: ["ensemble:2"] }),
      ];

      const result = await runScenario({
        issues,
        settingsOverrides: { agent: { maxConcurrentAgents: 4, maxRetryBackoffMs: 50 } },
        runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 20 } },
        pollTicks: 5,
        tickDelayMs: 40,
        waitForRuns: false,
      });

      // The global concurrency cap of 4 should be respected (3 issues * 2 slots = 6 desired,
      // but only 4 can run simultaneously)
      const capResults = checkAssertions(result, [{ type: "concurrency_cap", maxConcurrent: 4 }]);
      for (const r of capResults) {
        expect(r.passed).toBe(true);
      }

      // At least some issues should have been started
      const started = result.events.filter((e) => e.type === "run_started");
      expect(started.length).toBeGreaterThan(0);
    },
  );

  // ---------------------------------------------------------------------------
  // Varying latencies
  // ---------------------------------------------------------------------------
  test(
    "varying latencies: runner with different per-turn latencies, cap respected",
    { timeout: 15_000 },
    async () => {
      const issues = Array.from({ length: 5 }, (_, i) =>
        makeIssue(`lat-${i}`, `LAT-${i}`, { priority: 2 }),
      );

      const result = await runScenario({
        issues,
        settingsOverrides: { agent: { maxConcurrentAgents: 3, maxRetryBackoffMs: 100 } },
        runnerConfig: {
          defaultBehavior: { turnCount: 2, latencyPerTurnMs: 10 },
          byId: {
            "lat-0": { turnCount: 1, latencyPerTurnMs: 5 },
            "lat-1": { turnCount: 3, latencyPerTurnMs: 50 },
            "lat-2": { turnCount: 2, latencyPerTurnMs: 100 },
            "lat-3": { turnCount: 1, latencyPerTurnMs: 200 },
            "lat-4": { turnCount: 2, latencyPerTurnMs: 30 },
          },
        },
        pollTicks: 8,
        tickDelayMs: 60,
      });

      // Cap should still be respected even with varying latencies
      const capResults = checkAssertions(result, [{ type: "concurrency_cap", maxConcurrent: 3 }]);
      for (const r of capResults) {
        expect(r.passed).toBe(true);
      }

      // All ticks executed
      expect(result.ticksExecuted).toBe(8);
    },
  );

  // ---------------------------------------------------------------------------
  // Mixed ensemble sizes competing for cap
  // ---------------------------------------------------------------------------
  test("mixed ensemble sizes [1,2,3] competing for cap=5", { timeout: 10_000 }, async () => {
    const issues = [
      makeIssue("mix-1", "MIX-1", { priority: 1, labels: ["ensemble:1"] }),
      makeIssue("mix-2", "MIX-2", { priority: 2, labels: ["ensemble:2"] }),
      makeIssue("mix-3", "MIX-3", { priority: 3, labels: ["ensemble:3"] }),
    ];

    const result = await runScenario({
      issues,
      settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 50 } },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 20 } },
      pollTicks: 5,
      tickDelayMs: 40,
      waitForRuns: false,
    });

    // Total slots desired: 1 + 2 + 3 = 6, but cap is 5
    const capResults = checkAssertions(result, [{ type: "concurrency_cap", maxConcurrent: 5 }]);
    for (const r of capResults) {
      expect(r.passed).toBe(true);
    }

    // At least some runs started
    const started = result.events.filter((e) => e.type === "run_started");
    expect(started.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Intermittent fetch errors
  // ---------------------------------------------------------------------------
  test(
    "intermittent fetch errors: some issues always fail to fetch, others succeed",
    { timeout: 10_000 },
    async () => {
      const issues = [
        makeIssue("good-0", "GOOD-0", { priority: 1 }),
        makeIssue("good-1", "GOOD-1", { priority: 2 }),
        makeIssue("bad-0", "BAD-0", { priority: 3 }),
        makeIssue("bad-1", "BAD-1", { priority: 4 }),
      ];

      const result = await runScenario({
        issues,
        settingsOverrides: { agent: { maxConcurrentAgents: 4, maxRetryBackoffMs: 50 } },
        chaosConfig: {
          intermittentErrorIds: new Set(["bad-0", "bad-1"]),
        },
        runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 10 } },
        pollTicks: 5,
        tickDelayMs: 30,
      });

      // System should not crash
      expect(result.ticksExecuted).toBe(5);

      // Good issues should be dispatched successfully
      const startedMessages = result.events
        .filter((e) => e.type === "run_started")
        .map((e) => e.message);
      const goodStarted = startedMessages.some((m) => m.includes("GOOD"));
      expect(goodStarted).toBe(true);

      // Concurrency cap respected
      const capResults = checkAssertions(result, [{ type: "concurrency_cap", maxConcurrent: 4 }]);
      for (const r of capResults) {
        expect(r.passed).toBe(true);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Sequential unblocking (dependency chain)
  // ---------------------------------------------------------------------------
  test(
    "sequential unblocking: chain of 3 issues, each depends on previous",
    { timeout: 15_000 },
    async () => {
      const chain = makeDependencyChain(3);
      // chain[0] has no blockers, chain[1] blocked by chain[0], chain[2] blocked by chain[1]

      const result = await runScenario({
        issues: chain,
        settingsOverrides: { agent: { maxConcurrentAgents: 3, maxRetryBackoffMs: 50 } },
        runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 10 } },
        pollTicks: 10,
        tickDelayMs: 50,
        // Simulate chain unblocking: after each issue completes, mark its blocker as done
        mutations: {
          2: (client: ChaosLinearClient) => {
            // After tick 2, mark chain-0 as done so chain-1 can be unblocked
            client.changeIssueState("chain-0", "Done", "completed");
            // Remove blocker from chain-1
            const issues = client.getIssues();
            const chain1 = issues.find((i) => i.id === "chain-1");
            if (chain1) {
              client.updateIssue("chain-1", {
                blockers: chain1.blockers.filter((b) => b.id !== "chain-0"),
              });
            }
          },
          5: (client: ChaosLinearClient) => {
            // After tick 5, mark chain-1 as done so chain-2 can be unblocked
            client.changeIssueState("chain-1", "Done", "completed");
            const issues = client.getIssues();
            const chain2 = issues.find((i) => i.id === "chain-2");
            if (chain2) {
              client.updateIssue("chain-2", {
                blockers: chain2.blockers.filter((b) => b.id !== "chain-1"),
              });
            }
          },
        },
      });

      // The first issue (chain-0) should always be started since it has no blockers
      const startedMessages = result.events
        .filter((e) => e.type === "run_started")
        .map((e) => e.message);
      const chain0Started = startedMessages.some((m) => m.includes("CHAIN-0"));
      expect(chain0Started).toBe(true);

      // System should complete all ticks without crashing
      expect(result.ticksExecuted).toBe(10);

      // Concurrency cap respected
      const capResults = checkAssertions(result, [{ type: "concurrency_cap", maxConcurrent: 3 }]);
      for (const r of capResults) {
        expect(r.passed).toBe(true);
      }
    },
  );
});
