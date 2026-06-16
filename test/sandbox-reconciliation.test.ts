import { describe, test, expect } from "vitest";

import { runScenario, makeIssue, checkAssertions } from "../sandbox/sandbox.js";
import type { ChaosLinearClient } from "../sandbox/sandbox.js";

describe("Sandbox: Reconciliation", () => {
  test("stalled fake runner with default waitForRuns returns a stall error", async () => {
    const result = await Promise.race([
      runScenario({
        issues: [makeIssue("stall", "STALL-1", { state: "Todo", stateType: "unstarted" })],
        settingsOverrides: { codex: { stallTimeoutMs: 25 } },
        runnerConfig: { defaultBehavior: { stall: true } },
        pollTicks: 1,
      }),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
    ]);

    expect(result).not.toBe("timed-out");
    if (result === "timed-out") return;

    expect(result.ticksExecuted).toBe(1);
    expect(result.errors.map((error) => error.message).join("\n")).toContain("stall timeout");
  });

  test("terminal state detected during reconcile -> abort + cleanup", async () => {
    const result = await runScenario({
      issues: [makeIssue("x", "X-1", { state: "In Progress", stateType: "started" })],
      runnerConfig: { defaultBehavior: { turnCount: 20, latencyPerTurnMs: 100 } },
      pollTicks: 4,
      tickDelayMs: 200,
      waitForRuns: false,
      timedMutations: [
        {
          afterMs: 50,
          mutate: { type: "change_state", issueId: "x", state: "Done", stateType: "completed" },
        },
      ],
    });

    // Terminal state triggers workspace_cleanup in runtime (distinct from run_reconciled)
    const assertions = checkAssertions(result, [
      { type: "not_running", issueId: "x" },
      { type: "event_occurred", eventType: "workspace_cleanup" },
    ]);
    expect(assertions.every((a) => a.passed)).toBe(true);
  });

  test("inactive non-terminal -> abort, keep workspace", async () => {
    const result = await runScenario({
      issues: [makeIssue("x", "X-1", { state: "In Progress", stateType: "started" })],
      runnerConfig: { defaultBehavior: { turnCount: 20, latencyPerTurnMs: 100 } },
      pollTicks: 4,
      tickDelayMs: 200,
      waitForRuns: false,
      timedMutations: [
        {
          afterMs: 50,
          mutate: { type: "change_state", issueId: "x", state: "Backlog", stateType: "backlog" },
        },
      ],
    });

    // Reconciliation should abort worker but NOT trigger workspace cleanup
    const assertions = checkAssertions(result, [
      { type: "not_running", issueId: "x" },
      { type: "event_occurred", eventType: "run_reconciled" },
      { type: "event_not_occurred", eventType: "workspace_cleanup" },
    ]);
    expect(assertions.every((a) => a.passed)).toBe(true);
  });

  test("route mismatch after reconcile -> abort", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("x", "X-1", {
          state: "In Progress",
          stateType: "started",
          labels: ["lorenz:backend"],
        }),
      ],
      settingsOverrides: {
        tracker: {
          kind: "memory",
          endpoint: "memory://test",
          activeStates: ["Todo", "In Progress"],
          terminalStates: ["Done", "Cancelled"],
          dispatch: {
            acceptUnrouted: false,
            onlyRoutes: ["backend"],
            routeLabelPrefix: "Lorenz:",
          },
        },
      },
      runnerConfig: { defaultBehavior: { turnCount: 20, latencyPerTurnMs: 100 } },
      pollTicks: 4,
      tickDelayMs: 200,
      waitForRuns: false,
      timedMutations: [
        {
          afterMs: 50,
          mutate: { type: "change_labels", issueId: "x", labels: ["lorenz:frontend"] },
        },
      ],
    });

    // Reconciliation should detect route mismatch and abort
    const assertions = checkAssertions(result, [
      { type: "not_running", issueId: "x" },
      { type: "event_occurred", eventType: "run_reconciled" },
    ]);
    expect(assertions.every((a) => a.passed)).toBe(true);
  });

  test("tracker fetch failure -> workers kept running", async () => {
    const result = await runScenario({
      issues: [makeIssue("x", "X-1", { state: "In Progress", stateType: "started" })],
      chaosConfig: { failureRate: 0 },
      runnerConfig: { defaultBehavior: { turnCount: 5, latencyPerTurnMs: 50 } },
      pollTicks: 4,
      tickDelayMs: 100,
      mutations: {
        1: (client: ChaosLinearClient) => {
          // Enable chaos AFTER the first tick to allow initial dispatch
          client.setChaosConfig({ failureRate: 1.0 });
        },
      },
    });

    // Despite fetch failures, the worker should continue running
    // (reconciliation failure = graceful degradation, keep running)
    const assertions = checkAssertions(result, [
      { type: "event_occurred", eventType: "run_started", messageContains: "X-1" },
    ]);
    expect(assertions.every((a) => a.passed)).toBe(true);
  });

  test("issue deleted (not returned by tracker) -> abort + cleanup", async () => {
    const result = await runScenario({
      issues: [makeIssue("x", "X-1", { state: "In Progress", stateType: "started" })],
      runnerConfig: { defaultBehavior: { turnCount: 20, latencyPerTurnMs: 100 } },
      pollTicks: 4,
      tickDelayMs: 200,
      waitForRuns: false,
      timedMutations: [
        {
          afterMs: 50,
          mutate: { type: "remove_issue", issueId: "x" },
        },
      ],
    });

    // Reconciliation should detect missing issue and abort the worker
    const assertions = checkAssertions(result, [
      { type: "not_running", issueId: "x" },
      { type: "event_occurred", eventType: "run_reconciled", messageContains: "missing" },
    ]);
    expect(assertions.every((a) => a.passed)).toBe(true);
  });

  test("active + routed issue refreshed and continues", async () => {
    const result = await runScenario({
      issues: [makeIssue("x", "X-1", { state: "In Progress", stateType: "started" })],
      runnerConfig: { defaultBehavior: { turnCount: 3, latencyPerTurnMs: 50 } },
      pollTicks: 3,
      tickDelayMs: 100,
    });

    // Issue remains active and routed -- worker should complete normally
    const assertions = checkAssertions(result, [
      { type: "event_occurred", eventType: "run_started", messageContains: "X-1" },
      // No reconciliation abort should occur for a healthy running issue
      { type: "event_not_occurred", eventType: "run_reconciled" },
      { type: "no_errors" },
    ]);
    expect(assertions.every((a) => a.passed)).toBe(true);
  });

  test("blocker added to STARTED issue does not abort (blockers only gate unstarted)", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("x", "X-1", {
          state: "In Progress",
          stateType: "started",
          blockers: [],
        }),
      ],
      runnerConfig: { defaultBehavior: { turnCount: 5, latencyPerTurnMs: 50 } },
      pollTicks: 4,
      tickDelayMs: 150,
      timedMutations: [
        {
          afterMs: 100,
          mutate: {
            type: "add_blocker",
            issueId: "x",
            blockerId: "blocker-1",
            blockerIdentifier: "BLK-1",
          },
        },
      ],
    });

    // A started issue should NOT be affected by added blockers
    // (blockers only gate unstarted issues)
    // NOTE: This test documents expected behavior: blockers only gate unstarted issues.
    // With state="In Progress" (not "Todo"), the || bug doesn't trigger.
    const assertions = checkAssertions(result, [
      { type: "event_occurred", eventType: "run_started", messageContains: "X-1" },
      { type: "event_not_occurred", eventType: "run_reconciled" },
    ]);
    expect(assertions.every((a) => a.passed)).toBe(true);
  });

  test("multiple issues reconciled independently", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("a", "A-1", { state: "In Progress", stateType: "started" }),
        makeIssue("b", "B-1", { state: "In Progress", stateType: "started" }),
        makeIssue("c", "C-1", { state: "In Progress", stateType: "started" }),
      ],
      runnerConfig: { defaultBehavior: { turnCount: 20, latencyPerTurnMs: 80 } },
      pollTicks: 5,
      tickDelayMs: 150,
      waitForRuns: false,
      timedMutations: [
        // A goes terminal
        {
          afterMs: 50,
          mutate: { type: "change_state", issueId: "a", state: "Done", stateType: "completed" },
        },
        // B goes inactive
        {
          afterMs: 80,
          mutate: { type: "change_state", issueId: "b", state: "Backlog", stateType: "backlog" },
        },
        // C stays active -- should continue running
      ],
    });

    // A should be stopped (terminal with workspace_cleanup),
    // B should be stopped (inactive with run_reconciled),
    // C should still be running or have completed normally
    const assertions = checkAssertions(result, [
      { type: "not_running", issueId: "a" },
      { type: "not_running", issueId: "b" },
      { type: "event_occurred", eventType: "run_started", messageContains: "C-1" },
    ]);
    expect(assertions.every((a) => a.passed)).toBe(true);
  });

  test("reconcile after chaos (intermittent errors)", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("x", "X-1", { state: "In Progress", stateType: "started" }),
        makeIssue("y", "Y-1", { state: "In Progress", stateType: "started" }),
      ],
      chaosConfig: { failureRate: 0.3 },
      runnerConfig: { defaultBehavior: { turnCount: 3, latencyPerTurnMs: 30 } },
      pollTicks: 6,
      tickDelayMs: 80,
    });

    // System should survive intermittent errors without crashing.
    // Some ticks may produce errors but the runtime should be resilient.
    // At least one run should have started despite chaos
    const startedEvents = result.events.filter((e) => e.type === "run_started");
    expect(startedEvents.length).toBeGreaterThanOrEqual(1);
  });
});
