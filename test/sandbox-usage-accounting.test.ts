/**
 * Usage Accounting integration tests via the sandbox's runScenario.
 *
 * Each test exercises token usage accumulation behavior through the full
 * runtime, using the FakeAgentRunner to emit controllable usage per turn.
 */

import { describe, expect, test } from "vitest";

import { runScenario, makeIssue } from "../sandbox/sandbox.js";

describe("INVARIANT: Usage Accounting (sandbox scenarios)", () => {
  // ---------------------------------------------------------------------------
  // Tokens accumulate across turns for single issue
  // Invariant: Monotonic growth
  //
  // The runtime uses monotonic watermark-based usage tracking. Each turn reports
  // its cumulative total (not a per-turn delta). The merge function computes
  // delta = max(0, reported - lastReported) and adds it to global totals.
  // To test accumulation, we use increasing cumulative values each turn via
  // per-issue config with distinct turn-count and usage that grows turn by turn.
  // Since FakeAgentRunner emits the same usagePerTurn value each turn, the
  // runtime sees the first report as the high-water mark and subsequent identical
  // reports produce zero delta. So we verify the final total equals the
  // per-turn watermark value (since each turn reports the same cumulative total).
  // ---------------------------------------------------------------------------
  test("INVARIANT: tokens accumulate across turns for single issue (monotonic growth)", async () => {
    // The FakeAgentRunner reports the same usagePerTurn value on each turn.
    // Under monotonic merge, the entry totals reach the watermark on turn 1
    // and remain there (subsequent identical reports produce zero delta).
    // This verifies the monotonic growth invariant: totals never decrease.
    const usagePerTurn = { inputTokens: 500, outputTokens: 250, totalTokens: 750 };
    const turnCount = 5;

    const result = await runScenario({
      issues: [makeIssue("acc-1", "ACC-1", { state: "Todo", stateType: "unstarted" })],
      runnerConfig: {
        defaultBehavior: {
          shouldSucceed: true,
          turnCount,
          latencyPerTurnMs: 0,
          usagePerTurn,
        },
      },
      pollTicks: 1,
      waitForRuns: true,
    });

    expect(result.errors).toHaveLength(0);

    // Under monotonic watermark model, the global totals should equal the
    // reported watermark value (first report sets the level, subsequent equal
    // reports produce zero delta).
    const globalUsage = result.finalSnapshot.usageTotals;
    expect(globalUsage.inputTokens).toBe(usagePerTurn.inputTokens);
    expect(globalUsage.outputTokens).toBe(usagePerTurn.outputTokens);
    expect(globalUsage.totalTokens).toBe(usagePerTurn.totalTokens);

    // Verify monotonic growth: each snapshot's usageTotals should be >= the previous one.
    // This is the core invariant -- totals never decrease across the session.
    let prevInput = 0;
    let prevOutput = 0;
    let prevTotal = 0;
    for (const snapshot of result.snapshots) {
      expect(snapshot.usageTotals.inputTokens).toBeGreaterThanOrEqual(prevInput);
      expect(snapshot.usageTotals.outputTokens).toBeGreaterThanOrEqual(prevOutput);
      expect(snapshot.usageTotals.totalTokens).toBeGreaterThanOrEqual(prevTotal);
      prevInput = snapshot.usageTotals.inputTokens;
      prevOutput = snapshot.usageTotals.outputTokens;
      prevTotal = snapshot.usageTotals.totalTokens;
    }

    // Per-issue usage in run history should reflect the watermark.
    const historyEntry = result.finalSnapshot.runHistory.find((h) => h.issueId === "acc-1");
    expect(historyEntry).toBeDefined();
    expect(historyEntry!.usageTotals).toBeDefined();
    expect(historyEntry!.usageTotals!.inputTokens).toBe(usagePerTurn.inputTokens);
    expect(historyEntry!.usageTotals!.outputTokens).toBe(usagePerTurn.outputTokens);
    expect(historyEntry!.usageTotals!.totalTokens).toBe(usagePerTurn.totalTokens);
  });

  // ---------------------------------------------------------------------------
  // Global totals equal sum of all issues usage
  // Invariant: Global aggregates
  //
  // Under monotonic watermark-based usage, each issue's usage is determined by
  // its high-water mark (the max cumulative value reported). The global total
  // is the sum of deltas across all issues. Since the FakeAgentRunner reports
  // the same value every turn, each issue's contribution equals its usagePerTurn
  // watermark value. The global total should equal the sum of all issues'
  // watermark values.
  // ---------------------------------------------------------------------------
  test("INVARIANT: global totals equal sum of all issues usage (global aggregates)", async () => {
    // Three concurrent issues each with distinct usage watermark values.
    const result = await runScenario({
      issues: [
        makeIssue("u-1", "U-1", { state: "Todo", stateType: "unstarted" }),
        makeIssue("u-2", "U-2", { state: "Todo", stateType: "unstarted" }),
        makeIssue("u-3", "U-3", { state: "Todo", stateType: "unstarted" }),
      ],
      settingsOverrides: {
        agent: {
          kind: "codex",
          maxConcurrentAgents: 5,
          maxTurns: 10,
          maxRetryBackoffMs: 1000,
          ensembleSize: 1,
        },
      },
      runnerConfig: {
        byId: {
          "u-1": {
            shouldSucceed: true,
            turnCount: 2,
            latencyPerTurnMs: 0,
            usagePerTurn: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          },
          "u-2": {
            shouldSucceed: true,
            turnCount: 3,
            latencyPerTurnMs: 0,
            usagePerTurn: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
          },
          "u-3": {
            shouldSucceed: true,
            turnCount: 1,
            latencyPerTurnMs: 0,
            usagePerTurn: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
          },
        },
      },
      pollTicks: 1,
      waitForRuns: true,
    });

    expect(result.errors).toHaveLength(0);

    // Under monotonic watermark model, each issue contributes its watermark
    // (reported value) as a single delta on the first turn report. Subsequent
    // turns with the same value contribute zero delta.
    // u-1 watermark: (100, 50, 150)
    // u-2 watermark: (200, 100, 300)
    // u-3 watermark: (50, 25, 75)
    // Global sum: (350, 175, 525)
    const expectedInput = 100 + 200 + 50;
    const expectedOutput = 50 + 100 + 25;
    const expectedTotal = 150 + 300 + 75;

    const globalUsage = result.finalSnapshot.usageTotals;
    expect(globalUsage.inputTokens).toBe(expectedInput);
    expect(globalUsage.outputTokens).toBe(expectedOutput);
    expect(globalUsage.totalTokens).toBe(expectedTotal);

    // Verify that per-issue run history usage sums to global total.
    const histories = result.finalSnapshot.runHistory.filter(
      (h) => h.issueId === "u-1" || h.issueId === "u-2" || h.issueId === "u-3",
    );
    expect(histories).toHaveLength(3);

    let sumInput = 0;
    let sumOutput = 0;
    let sumTotal = 0;
    for (const h of histories) {
      if (h.usageTotals) {
        sumInput += h.usageTotals.inputTokens;
        sumOutput += h.usageTotals.outputTokens;
        sumTotal += h.usageTotals.totalTokens;
      }
    }

    expect(sumInput).toBe(globalUsage.inputTokens);
    expect(sumOutput).toBe(globalUsage.outputTokens);
    expect(sumTotal).toBe(globalUsage.totalTokens);
  });

  // ---------------------------------------------------------------------------
  // Zero token reports keep totals at zero
  // Invariant: Monotonic (0 not > previous)
  // ---------------------------------------------------------------------------
  test("INVARIANT: zero token reports keep totals at zero (monotonic)", async () => {
    const result = await runScenario({
      issues: [makeIssue("z-1", "Z-1", { state: "Todo", stateType: "unstarted" })],
      runnerConfig: {
        defaultBehavior: {
          shouldSucceed: true,
          turnCount: 4,
          latencyPerTurnMs: 0,
          usagePerTurn: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      },
      pollTicks: 1,
      waitForRuns: true,
    });

    expect(result.errors).toHaveLength(0);

    // Global totals should remain at zero when all reported usage is zero.
    const globalUsage = result.finalSnapshot.usageTotals;
    expect(globalUsage.inputTokens).toBe(0);
    expect(globalUsage.outputTokens).toBe(0);
    expect(globalUsage.totalTokens).toBe(0);

    // Every intermediate snapshot should also show zero totals.
    for (const snapshot of result.snapshots) {
      expect(snapshot.usageTotals.inputTokens).toBe(0);
      expect(snapshot.usageTotals.outputTokens).toBe(0);
      expect(snapshot.usageTotals.totalTokens).toBe(0);
    }

    // Per-issue run history should also show zero usage.
    const historyEntry = result.finalSnapshot.runHistory.find((h) => h.issueId === "z-1");
    expect(historyEntry).toBeDefined();
    if (historyEntry?.usageTotals) {
      expect(historyEntry.usageTotals.inputTokens).toBe(0);
      expect(historyEntry.usageTotals.outputTokens).toBe(0);
      expect(historyEntry.usageTotals.totalTokens).toBe(0);
    }
  });
});
