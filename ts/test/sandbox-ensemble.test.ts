import { describe, expect, test } from "vitest";

import { makeIssue, runScenario } from "../sandbox/sandbox.js";

describe("sandbox ensemble resolution integration tests", () => {
  test("ensemble:2 label -> 2 slots started", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("e1", "E-1", {
          state: "In Progress",
          stateType: "started",
          labels: ["ensemble:2"],
        }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      runnerConfig: { defaultBehavior: { turnCount: 5, latencyPerTurnMs: 50 } },
      pollTicks: 3,
      waitForRuns: false,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("E-1"),
    );
    expect(starts).toHaveLength(2);
  });

  test("ensemble:3 label -> 3 concurrent workers for same issue", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("e2", "E-2", {
          state: "In Progress",
          stateType: "started",
          labels: ["ensemble:3"],
        }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      runnerConfig: { defaultBehavior: { turnCount: 5, latencyPerTurnMs: 50 } },
      pollTicks: 4,
      waitForRuns: false,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("E-2"),
    );
    expect(starts).toHaveLength(3);
    expect(starts.some((e) => e.message.includes("slot=0"))).toBe(true);
    expect(starts.some((e) => e.message.includes("slot=1"))).toBe(true);
    expect(starts.some((e) => e.message.includes("slot=2"))).toBe(true);
  });

  test("ensemble:1 is explicit single slot (same as default)", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("e3", "E-3", {
          state: "In Progress",
          stateType: "started",
          labels: ["ensemble:1"],
        }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10 } },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 1,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("E-3"),
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]!.message).toContain("slot=0");
  });

  test("no ensemble label -> uses default ensembleSize from settings", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("e4", "E-4", {
          state: "In Progress",
          stateType: "started",
          labels: [],
        }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10, ensembleSize: 2 } },
      runnerConfig: { defaultBehavior: { turnCount: 5, latencyPerTurnMs: 50 } },
      pollTicks: 3,
      waitForRuns: false,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("E-4"),
    );
    expect(starts).toHaveLength(2);
  });

  test("invalid ensemble label (ensemble:0) -> falls back to default", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("e5", "E-5", {
          state: "In Progress",
          stateType: "started",
          labels: ["ensemble:0"],
        }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10, ensembleSize: 1 } },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 1,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("E-5"),
    );
    // ensemble:0 is invalid, falls back to default ensembleSize=1
    expect(starts).toHaveLength(1);
  });

  test("invalid ensemble label (ensemble:abc) -> falls back to default", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("e6", "E-6", {
          state: "In Progress",
          stateType: "started",
          labels: ["ensemble:abc"],
        }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10, ensembleSize: 1 } },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 1,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("E-6"),
    );
    // ensemble:abc is non-numeric, falls back to default ensembleSize=1
    expect(starts).toHaveLength(1);
  });

  test("all ensemble slots complete independently", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("e7", "E-7", {
          state: "In Progress",
          stateType: "started",
          labels: ["ensemble:2"],
        }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 10, maxRetryBackoffMs: 50 } },
      runnerConfig: { defaultBehavior: { turnCount: 2, latencyPerTurnMs: 50 } },
      pollTicks: 4,
      tickDelayMs: 30,
      waitForRuns: false,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("E-7"),
    );
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts.some((e) => e.message.includes("slot=0"))).toBe(true);
    expect(starts.some((e) => e.message.includes("slot=1"))).toBe(true);
  });

  test("ensemble with cap limit: ensemble:3 with maxConcurrentAgents=2", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("e8", "E-8", {
          state: "In Progress",
          stateType: "started",
          labels: ["ensemble:3"],
        }),
      ],
      settingsOverrides: { agent: { maxConcurrentAgents: 2 } },
      runnerConfig: { defaultBehavior: { turnCount: 2, latencyPerTurnMs: 50 } },
      pollTicks: 1,
      waitForRuns: false,
    });

    // With maxConcurrentAgents=2, at most 2 slots should be running concurrently
    // even though ensemble:3 requests 3 slots
    let maxConcurrent = 0;
    for (const snapshot of result.snapshots) {
      const runningForIssue = snapshot.running.filter((r) => r.issueId === "e8");
      maxConcurrent = Math.max(maxConcurrent, runningForIssue.length);
    }
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
