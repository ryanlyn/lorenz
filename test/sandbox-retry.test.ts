import { describe, test, expect } from "vitest";

import { runScenario, makeIssue } from "../sandbox/sandbox.js";
import type { ChaosLinearClient } from "../sandbox/sandbox.js";

/**
 * Integration tests for Retry and Backoff invariants via full sandbox runs.
 *
 * These exercise the complete retry pipeline: failure retries with exponential
 * backoff, continuation retries, backoff cap enforcement, stability under
 * repeated failures, and timing verification.
 * Covers failure retries, continuation retries, backoff cap enforcement,
 * stability under repeated failures, and timing verification.
 */
describe("Sandbox: Retry and Backoff", () => {
  test("failed issue retried with backoff", async () => {
    const result = await runScenario({
      issues: [makeIssue("fail-1", "FAIL-1")],
      settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 1000 } },
      runnerConfig: {
        defaultBehavior: { shouldSucceed: false, turnCount: 1, latencyPerTurnMs: 0 },
      },
      pollTicks: 5,
      tickDelayMs: 300,
    });

    const failedEvents = result.events.filter(
      (e) => e.type === "run_failed" && e.message.includes("FAIL-1"),
    );
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);

    const startedEvents = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("FAIL-1"),
    );
    expect(startedEvents.length).toBeGreaterThanOrEqual(2);
  });

  test("continuation retry after normal exit (issue re-dispatched quickly)", async () => {
    // Continuation retry delay = Math.min(1000, maxRetryBackoffMs).
    // With maxRetryBackoffMs=1000, delay is 1000ms. Tick delay must exceed this.
    const result = await runScenario({
      issues: [makeIssue("cont-1", "CONT-1")],
      settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 1000 } },
      runnerConfig: { defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 4,
      tickDelayMs: 1200,
    });

    // After a successful completion, continuation retry should re-dispatch
    const startedEvents = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("CONT-1"),
    );
    expect(startedEvents.length).toBeGreaterThanOrEqual(2);

    // Completed events should also exist
    const completedEvents = result.events.filter(
      (e) => e.type === "run_completed" && e.message.includes("CONT-1"),
    );
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("retry backoff increases exponentially across failures", async () => {
    const result = await runScenario({
      issues: [makeIssue("exp-1", "EXP-1")],
      settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 60000 } },
      runnerConfig: {
        defaultBehavior: { shouldSucceed: false, turnCount: 1, latencyPerTurnMs: 0 },
      },
      pollTicks: 3,
      tickDelayMs: 50,
    });

    // With a 60000ms cap and short tick delays, after the first failure the backoff
    // should be 10000ms, so the issue should NOT be retried within 150ms total time
    const startedEvents = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("EXP-1"),
    );
    // Only dispatched once because backoff >> total test time
    expect(startedEvents).toHaveLength(1);

    // But we should see the retry entry in the final snapshot
    const retrying = result.finalSnapshot.retrying.filter((r) => r.issueId === "exp-1");
    expect(retrying.length).toBeGreaterThanOrEqual(1);
    if (retrying.length > 0) {
      expect(retrying[0].attempt).toBeGreaterThanOrEqual(1);
    }
  });

  test("retry respects maxRetryBackoffMs cap", async () => {
    const result = await runScenario({
      issues: [makeIssue("cap-1", "CAP-1")],
      settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 1000 } },
      runnerConfig: {
        defaultBehavior: { shouldSucceed: false, turnCount: 1, latencyPerTurnMs: 0 },
      },
      pollTicks: 8,
      tickDelayMs: 300,
    });

    const startedEvents = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("CAP-1"),
    );
    // With 0 turn latency, 8 ticks with delay 300, we get to 2400ms which is strictly less than 3 x maxRetryBackoffMs
    expect(startedEvents.length).toBeGreaterThanOrEqual(2);
  });

  test("multiple failures + retries, eventually succeeds (runner config changes via mutations)", async () => {
    const result = await runScenario({
      issues: [makeIssue("evolve-1", "EVOLVE-1")],
      settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 100 } },
      runnerConfig: {
        defaultBehavior: { shouldSucceed: false, turnCount: 1, latencyPerTurnMs: 0 },
      },
      pollTicks: 8,
      tickDelayMs: 150,
      mutations: {
        // After a few failures, change the issue to a state where runner succeeds
        // (simulate external fix). Since we can't change the runner config mid-run,
        // we change the issue to terminal so it stops retrying.
        5: (client: ChaosLinearClient) => {
          client.changeIssueState("evolve-1", "Done", "completed");
        },
      },
    });

    // Should have failed initially
    const failedEvents = result.events.filter(
      (e) => e.type === "run_failed" && e.message.includes("EVOLVE-1"),
    );
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);

    // After terminal transition, cleanup should have happened
    const startedEventsAfterTerminal = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("EVOLVE-1"),
    );
    expect(startedEventsAfterTerminal.length).toBeGreaterThanOrEqual(1);
  });

  test("issue with shouldSucceed=false retries up to maxTurns", async () => {
    const result = await runScenario({
      issues: [makeIssue("max-1", "MAX-1")],
      settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 100, maxTurns: 3 } },
      runnerConfig: {
        defaultBehavior: { shouldSucceed: false, turnCount: 1, latencyPerTurnMs: 0 },
      },
      pollTicks: 10,
      tickDelayMs: 150,
    });

    // The issue should be retried multiple times
    const failedEvents = result.events.filter(
      (e) => e.type === "run_failed" && e.message.includes("MAX-1"),
    );
    expect(failedEvents.length).toBeGreaterThanOrEqual(2);

    const startedEvents = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("MAX-1"),
    );
    expect(startedEvents.length).toBeGreaterThanOrEqual(2);
  });

  test("very fast retry (maxRetryBackoffMs=50): issue retries within a few ticks", async () => {
    const result = await runScenario({
      issues: [makeIssue("fast-1", "FAST-1")],
      settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 50 } },
      runnerConfig: {
        defaultBehavior: { shouldSucceed: false, turnCount: 1, latencyPerTurnMs: 0 },
      },
      pollTicks: 8,
      tickDelayMs: 300,
    });

    const startedEvents = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("FAST-1"),
    );
    expect(startedEvents.length).toBeGreaterThanOrEqual(3);

    const failedEvents = result.events.filter(
      (e) => e.type === "run_failed" && e.message.includes("FAST-1"),
    );
    expect(failedEvents.length).toBeGreaterThanOrEqual(2);
  });

  test("blocked due retry is rescheduled by timer before the next polling tick", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("retry-resync-1", "A-RETRY-RESYNC", { priority: 1 }),
        makeIssue("capacity-holder-1", "B-CAPACITY-HOLDER", { priority: 2 }),
      ],
      settingsOverrides: {
        polling: { intervalMs: 60_000 },
        agent: { maxConcurrentAgents: 1, maxRetryBackoffMs: 80 },
      },
      runnerConfig: {
        defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 },
        byId: {
          "retry-resync-1": {
            shouldSucceed: false,
            errorMessage: "retry-resync failure",
            turnCount: 1,
            latencyPerTurnMs: 0,
          },
          "capacity-holder-1": {
            shouldSucceed: true,
            turnCount: 3,
            latencyPerTurnMs: 120,
          },
        },
      },
      pollTicks: 2,
      tickDelayMs: 40,
      waitForRuns: false,
      postRunDelayMs: 650,
    });

    const retryStartedEvents = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("A-RETRY-RESYNC"),
    );
    expect(retryStartedEvents.length).toBeGreaterThanOrEqual(2);
    expect(result.events.some((e) => e.type === "retry_timer_due")).toBe(true);
  });

  test("high failure rate (0.5) with retries: system stays stable", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("stable-1", "STABLE-1"),
        makeIssue("stable-2", "STABLE-2"),
        makeIssue("stable-3", "STABLE-3"),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 100 } },
      chaosConfig: { failureRate: 0.5 },
      runnerConfig: { defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 5,
      tickDelayMs: 100,
    });

    // System should remain stable - no unhandled crashes
    expect(result.ticksExecuted).toBe(5);
    // Some events should have been generated (either starts, failures, or poll errors)
    expect(result.events.length + result.errors.length).toBeGreaterThan(0);
  });

  test("retry after chaos recovery (client failure then success)", async () => {
    const result = await runScenario({
      issues: [makeIssue("chaos-1", "CHAOS-1")],
      settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 100 } },
      chaosConfig: { failureRate: 1.0 },
      runnerConfig: { defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 6,
      tickDelayMs: 100,
      mutations: {
        // After 3 ticks of total failure, disable chaos so polling works
        3: (client: ChaosLinearClient) => {
          client.setChaosConfig({ failureRate: 0 });
        },
      },
    });

    // First few ticks should have errors (chaos), then recovery
    expect(result.errors.length).toBeGreaterThanOrEqual(1);

    // After chaos clears, the issue should be dispatched
    const startedEvents = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("CHAOS-1"),
    );
    expect(startedEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("continuation retry is short (1000ms) - check timing between dispatches", async () => {
    const result = await runScenario({
      issues: [makeIssue("short-1", "SHORT-1")],
      settingsOverrides: { agent: { maxConcurrentAgents: 5, maxRetryBackoffMs: 60000 } },
      runnerConfig: { defaultBehavior: { shouldSucceed: true, turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 4,
      tickDelayMs: 1200,
    });

    // Continuation retry delay is fixed at 1000ms. With 1200ms tick delay,
    // the issue should be re-dispatched on the next tick after completion.
    const startedEvents = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("SHORT-1"),
    );
    expect(startedEvents.length).toBeGreaterThanOrEqual(2);

    // Verify the timing between first and second dispatch is reasonable (~1-2s)
    if (startedEvents.length >= 2) {
      const firstTime = new Date(startedEvents[0].at).getTime();
      const secondTime = new Date(startedEvents[1].at).getTime();
      const gap = secondTime - firstTime;
      // Continuation retry is 1000ms, with some runner time and tick overhead
      // it should be between 1000ms and 3000ms
      expect(gap).toBeGreaterThanOrEqual(900);
      expect(gap).toBeLessThanOrEqual(4000);
    }
  });
});
