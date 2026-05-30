import { expect, test } from "vitest";

import { setupLinearSandbox, runLinearScenario } from "../sandbox/linear-sandbox.js";
import { checkAssertions } from "../sandbox/sandbox.js";
import type { LinearSandboxScenario } from "../sandbox/linear-sandbox.js";

const runLive = process.env.SYMPHONY_TS_RUN_LINEAR_SANDBOX === "1";

test(
  "linear-sandbox: creates issues, polls them, dispatches to fake runner, and cleans up",
  { timeout: 120_000, skip: !runLive },
  async () => {
    const ctx = await setupLinearSandbox();

    const scenario: LinearSandboxScenario = {
      issues: [{ title: "Sandbox test A" }, { title: "Sandbox test B" }],
      pollTicks: 3,
      tickDelayMs: 2000,
      maxConcurrentAgents: 5,
      assertions: [{ type: "no_errors" }, { type: "concurrency_cap", maxConcurrent: 5 }],
    };

    const result = await runLinearScenario(ctx, scenario);

    expect(result.createdIssueIds).toHaveLength(2);
    expect(result.createdIssues).toHaveLength(2);
    expect(result.ticksExecuted).toBe(3);

    const assertionResults = checkAssertions(result, scenario.assertions!);
    for (const r of assertionResults) {
      expect(r.passed).toBe(true);
    }

    expect(result.events.some((e) => e.type === "run_started")).toBe(true);
  },
);

test(
  "linear-sandbox: respects concurrency cap with many issues",
  { timeout: 120_000, skip: !runLive },
  async () => {
    const ctx = await setupLinearSandbox();

    const scenario: LinearSandboxScenario = {
      issues: [
        { title: "Concurrency A" },
        { title: "Concurrency B" },
        { title: "Concurrency C" },
        { title: "Concurrency D" },
        { title: "Concurrency E" },
      ],
      pollTicks: 3,
      tickDelayMs: 2000,
      maxConcurrentAgents: 2,
      runnerConfig: {
        defaultBehavior: { latencyPerTurnMs: 500, turnCount: 2 },
      },
      assertions: [{ type: "no_errors" }, { type: "concurrency_cap", maxConcurrent: 2 }],
    };

    const result = await runLinearScenario(ctx, scenario);

    const assertionResults = checkAssertions(result, scenario.assertions!);
    for (const r of assertionResults) {
      expect(r.passed).toBe(true);
    }
  },
);

test(
  "linear-sandbox: handles runner failures gracefully",
  { timeout: 120_000, skip: !runLive },
  async () => {
    const ctx = await setupLinearSandbox();

    const scenario: LinearSandboxScenario = {
      issues: [{ title: "Failure test issue" }],
      pollTicks: 3,
      tickDelayMs: 2000,
      maxConcurrentAgents: 5,
      runnerConfig: {
        defaultBehavior: { shouldSucceed: false, errorMessage: "simulated failure" },
      },
      assertions: [{ type: "event_occurred", eventType: "run_failed" }],
    };

    const result = await runLinearScenario(ctx, scenario);

    const assertionResults = checkAssertions(result, scenario.assertions!);
    for (const r of assertionResults) {
      expect(r.passed).toBe(true);
    }
  },
);
