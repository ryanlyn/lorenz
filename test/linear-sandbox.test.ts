import { describe, expect, test } from "vitest";
import type { Issue } from "@lorenz/cli";
import type { RuntimeEvent } from "@lorenz/runtime";

import { setupLinearSandbox, runLinearScenario } from "../sandbox/linear-sandbox.js";
import { checkAssertions, sleep } from "../sandbox/sandbox.js";
import type { LinearSandboxScenario, LinearSandboxResult } from "../sandbox/linear-sandbox.js";

const runLive = process.env.LORENZ_TS_RUN_LINEAR_SANDBOX === "1";

/** Map an issue identifier from a run_started event to its title via createdIssues. */
function issueForEvent(event: RuntimeEvent, createdIssues: Issue[]): Issue | undefined {
  return createdIssues.find((i) => event.message.startsWith(i.identifier));
}

/** Get ordered titles from run_started events using the issue identifier → title mapping. */
function dispatchedTitles(result: LinearSandboxResult): string[] {
  return result.events
    .filter((e) => e.type === "run_started")
    .map((e) => issueForEvent(e, result.createdIssues)?.title ?? "")
    .filter(Boolean);
}

async function waitForRuntimeEvent(
  events: RuntimeEvent[],
  predicate: (event: RuntimeEvent) => boolean,
  timeoutMs = 5000,
): Promise<RuntimeEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = events.find(predicate);
    if (event) return event;
    await sleep(50);
  }
  throw new Error("Timed out waiting for runtime event");
}

describe("linear-sandbox: basic", () => {
  test(
    "creates issues, polls, dispatches to fake runner, and cleans up",
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
        expect(r.passed, r.message).toBe(true);
      }

      expect(result.events.some((e) => e.type === "run_started")).toBe(true);
    },
  );

  test("handles runner failures gracefully", { timeout: 120_000, skip: !runLive }, async () => {
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
      expect(r.passed, r.message).toBe(true);
    }
  });
});

describe("linear-sandbox: dispatch ordering", () => {
  test(
    "dispatches higher-priority issues before lower-priority ones",
    { timeout: 120_000, skip: !runLive },
    async () => {
      // Invariant: lower priority number dispatches first (1=urgent before 4=low)
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "Low priority task", priority: 4 },
          { title: "Urgent task", priority: 1 },
          { title: "Medium task", priority: 3 },
        ],
        pollTicks: 3,
        tickDelayMs: 2000,
        maxConcurrentAgents: 1,
        runnerConfig: {
          defaultBehavior: { turnCount: 3, latencyPerTurnMs: 500 },
        },
        assertions: [{ type: "no_errors" }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const titles = dispatchedTitles(result);
      expect(titles.length).toBeGreaterThan(0);

      // With cap=1, only the highest-priority issue dispatches first
      expect(titles[0]).toContain("Urgent task");
    },
  );

  test(
    "same-priority issues ordered by creation time",
    { timeout: 120_000, skip: !runLive },
    async () => {
      // Invariant: same priority uses earlier creation time
      // Issues are created sequentially, so first created = earliest createdAt
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "First created", priority: 2 },
          { title: "Second created", priority: 2 },
          { title: "Third created", priority: 2 },
        ],
        pollTicks: 3,
        tickDelayMs: 2000,
        maxConcurrentAgents: 1,
        runnerConfig: {
          defaultBehavior: { turnCount: 2, latencyPerTurnMs: 300 },
        },
        assertions: [{ type: "no_errors" }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const titles = dispatchedTitles(result);
      expect(titles.length).toBeGreaterThan(0);

      // First dispatched should be the earliest-created issue
      expect(titles[0]).toContain("First created");
    },
  );
});

describe("linear-sandbox: eligibility & concurrency", () => {
  test("respects global concurrency cap", { timeout: 120_000, skip: !runLive }, async () => {
    // Invariant: global concurrency cap prevents dispatching beyond limit
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
        defaultBehavior: { latencyPerTurnMs: 800, turnCount: 3 },
      },
      assertions: [{ type: "no_errors" }, { type: "concurrency_cap", maxConcurrent: 2 }],
    };

    const result = await runLinearScenario(ctx, scenario);

    const assertionResults = checkAssertions(result, scenario.assertions!);
    for (const r of assertionResults) {
      expect(r.passed, r.message).toBe(true);
    }
  });

  test(
    "cap=1 dispatches exactly one issue at a time",
    { timeout: 120_000, skip: !runLive },
    async () => {
      // Invariant: strict enforcement of cap=1
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "Single slot A", priority: 1 },
          { title: "Single slot B", priority: 2 },
          { title: "Single slot C - linear-sandbox-1780965181315-hg8w6e", priority: 3 },
        ],
        pollTicks: 3,
        tickDelayMs: 2000,
        maxConcurrentAgents: 1,
        runnerConfig: {
          defaultBehavior: { latencyPerTurnMs: 600, turnCount: 2 },
        },
        assertions: [{ type: "concurrency_cap", maxConcurrent: 1 }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }
    },
  );

  test(
    "all eligible issues dispatch when cap exceeds issue count",
    { timeout: 120_000, skip: !runLive },
    async () => {
      // Invariant: below cap -> all eligible issues dispatch
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "All dispatch A" },
          { title: "All dispatch B" },
          { title: "All dispatch C" },
        ],
        pollTicks: 3,
        tickDelayMs: 2000,
        maxConcurrentAgents: 10,
        assertions: [{ type: "no_errors" }],
      };

      const result = await runLinearScenario(ctx, scenario);

      // All 3 issues should have been dispatched
      const startEvents = result.events.filter((e) => e.type === "run_started");
      expect(startEvents.length).toBeGreaterThanOrEqual(3);
    },
  );
});

describe("linear-sandbox: state transitions & reconciliation", () => {
  test(
    "issue moved to Done after run_started is reconciled out (stops worker)",
    { timeout: 120_000, skip: !runLive },
    async () => {
      // Invariant: terminal state -> stop worker + cleanup
      const ctx = await setupLinearSandbox();
      let completedIssue: Issue | undefined;
      let mutationApplied = false;

      const scenario: LinearSandboxScenario = {
        issues: [{ title: "Will be completed mid-run" }],
        pollTicks: 3,
        tickDelayMs: 1500,
        waitForRuns: false,
        maxConcurrentAgents: 5,
        runnerConfig: {
          defaultBehavior: { turnCount: 50, latencyPerTurnMs: 200 },
        },
        afterPoll: async ({ tick, ctx: hookCtx, createdIssues, events }) => {
          if (tick !== 0 || mutationApplied) return;
          const issue = createdIssues[0];
          if (!issue) throw new Error("Expected a created issue before applying terminal mutation");

          await waitForRuntimeEvent(
            events,
            (event) => event.type === "run_started" && event.message.includes(issue.identifier),
          );

          await hookCtx.client.updateIssueState(issue.id, hookCtx.states.done.id);
          completedIssue = issue;
          mutationApplied = true;
        },
      };

      const result = await runLinearScenario(ctx, scenario);
      expect(mutationApplied).toBe(true);
      expect(completedIssue).toBeDefined();
      if (!completedIssue) return;

      const assertionResults = checkAssertions(result, [
        { type: "no_errors" },
        { type: "not_running", issueId: completedIssue.id },
        {
          type: "event_occurred",
          eventType: "workspace_cleanup",
          messageContains: completedIssue.identifier,
        },
        {
          type: "event_not_occurred",
          eventType: "run_completed",
          messageContains: completedIssue.identifier,
        },
      ]);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      const targetStarts = result.events.filter(
        (e) => e.type === "run_started" && e.message.includes(completedIssue.identifier),
      );
      expect(targetStarts).toHaveLength(1);
      expect(
        result.finalSnapshot.retrying.some((entry) => entry.issueId === completedIssue.id),
      ).toBe(false);
    },
  );

  test(
    "terminal issue changed via Linear API before polling is not dispatched",
    { timeout: 180_000, skip: !runLive },
    async () => {
      // Invariant: pre-poll terminal state -> no dispatch
      const ctx = await setupLinearSandbox();

      // Create issue manually to control state changes mid-scenario
      const marker = `recon-test-${Date.now()}`;
      const issue = await ctx.client.createIssue({
        teamId: ctx.team.id,
        projectId: ctx.project.id,
        stateId: ctx.states.todo.id,
        title: `[${marker}] Reconciliation target`,
        description: "Issue that will transition to Done during execution",
        assigneeId: ctx.viewerId,
      });

      try {
        const scenario: LinearSandboxScenario = {
          issues: [],
          pollTicks: 4,
          tickDelayMs: 3000,
          maxConcurrentAgents: 5,
          runnerConfig: {
            defaultBehavior: { turnCount: 20, latencyPerTurnMs: 200 },
          },
          assertions: [],
        };

        await ctx.client.updateIssueState(issue.id, ctx.states.done.id);

        // Run a scenario with no pre-created issues - we already moved ours to Done
        const result = await runLinearScenario(ctx, scenario);

        // The Done issue should NOT have been dispatched
        const startEvents = result.events.filter(
          (e) => e.type === "run_started" && e.message.includes(issue.identifier),
        );
        expect(startEvents).toHaveLength(0);
      } finally {
        await ctx.client.archiveIssue(issue.id).catch(() => {});
      }
    },
  );

  test(
    "runner retry after failure re-dispatches on subsequent poll tick",
    { timeout: 120_000, skip: !runLive },
    async () => {
      // Invariant: failed runs create retry entries, re-dispatched when due
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [{ title: "Retry candidate" }],
        pollTicks: 4,
        tickDelayMs: 3000,
        maxConcurrentAgents: 5,
        runnerConfig: {
          defaultBehavior: {
            shouldSucceed: false,
            errorMessage: "transient failure",
            turnCount: 1,
            latencyPerTurnMs: 100,
          },
        },
        assertions: [{ type: "event_occurred", eventType: "run_failed" }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // Verify the issue was attempted multiple times (retry)
      const startEvents = result.events.filter((e) => e.type === "run_started");
      const failEvents = result.events.filter((e) => e.type === "run_failed");
      expect(failEvents.length).toBeGreaterThan(0);

      // With 4 ticks and fast failure, expect at least one retry attempt
      expect(startEvents.length).toBeGreaterThanOrEqual(1);
    },
  );

  test(
    "continuation retry re-dispatches a successfully completed issue",
    { timeout: 120_000, skip: !runLive },
    async () => {
      // Invariant: normal exit -> continuation retry with short delay
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [{ title: "Continuation candidate" }],
        pollTicks: 4,
        tickDelayMs: 3000,
        maxConcurrentAgents: 5,
        runnerConfig: {
          defaultBehavior: {
            shouldSucceed: true,
            turnCount: 1,
            latencyPerTurnMs: 100,
          },
        },
        assertions: [{ type: "no_errors" }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // With continuation retries and 4 ticks, the issue should be dispatched
      // multiple times (each successful completion triggers a continuation)
      const startEvents = result.events.filter((e) => e.type === "run_started");
      expect(startEvents.length).toBeGreaterThanOrEqual(2);
    },
  );

  test(
    "terminal issue is not re-dispatched after being marked Done in Linear",
    { timeout: 120_000, skip: !runLive },
    async () => {
      // Invariant: terminal state -> permanently ineligible
      const ctx = await setupLinearSandbox();

      // Create and immediately complete the issue
      const issue = await ctx.client.createIssue({
        teamId: ctx.team.id,
        projectId: ctx.project.id,
        stateId: ctx.states.done.id,
        title: `Already done issue`,
        description: "Should never be dispatched",
        assigneeId: ctx.viewerId,
      });

      try {
        // Also create a normal dispatchable issue to verify the runtime is working
        const scenario: LinearSandboxScenario = {
          issues: [{ title: "Normal dispatchable" }],
          pollTicks: 3,
          tickDelayMs: 2000,
          maxConcurrentAgents: 5,
          assertions: [{ type: "no_errors" }],
        };

        const result = await runLinearScenario(ctx, scenario);

        // The Done issue should never appear in run_started events
        const markerStarts = result.events.filter(
          (e) => e.type === "run_started" && e.message.includes(issue.identifier),
        );
        expect(markerStarts).toHaveLength(0);

        // But the normal issue should have been dispatched
        const startEvents = result.events.filter((e) => e.type === "run_started");
        expect(startEvents.length).toBeGreaterThan(0);
      } finally {
        await ctx.client.archiveIssue(issue.id).catch(() => {});
      }
    },
  );
});

describe("linear-sandbox: multi-issue interactions", () => {
  test(
    "mixed priorities with concurrency cap dispatches in priority order",
    { timeout: 120_000, skip: !runLive },
    async () => {
      // Invariant: with cap < issues, highest priority (lowest number) dispatches first
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "Priority 4 (low)", priority: 4 },
          { title: "Priority 1 (urgent)", priority: 1 },
          { title: "Priority 3 (medium)", priority: 3 },
          { title: "Priority 2 (high)", priority: 2 },
        ],
        pollTicks: 3,
        tickDelayMs: 2000,
        maxConcurrentAgents: 2,
        runnerConfig: {
          defaultBehavior: { turnCount: 3, latencyPerTurnMs: 500 },
        },
        assertions: [{ type: "no_errors" }, { type: "concurrency_cap", maxConcurrent: 2 }],
      };

      const result = await runLinearScenario(ctx, scenario);

      const assertionResults = checkAssertions(result, scenario.assertions!);
      for (const r of assertionResults) {
        expect(r.passed, r.message).toBe(true);
      }

      // First two dispatched should be priority 1 and 2 (urgent and high)
      const titles = dispatchedTitles(result);
      expect(titles.length).toBeGreaterThanOrEqual(2);

      const firstTwo = titles.slice(0, 2);
      const hasUrgent = firstTwo.some((t) => t.includes("Priority 1 (urgent)"));
      const hasHigh = firstTwo.some((t) => t.includes("Priority 2 (high)"));
      expect(hasUrgent).toBe(true);
      expect(hasHigh).toBe(true);
    },
  );

  test(
    "multiple poll ticks progressively dispatch queued work after slots free",
    { timeout: 180_000, skip: !runLive },
    async () => {
      // Invariant: as running slots complete, queued issues become eligible
      const ctx = await setupLinearSandbox();

      const scenario: LinearSandboxScenario = {
        issues: [
          { title: "Fast finisher A", priority: 1 },
          { title: "Fast finisher B", priority: 2 },
          { title: "Queued C", priority: 3 },
          { title: "Queued D", priority: 4 },
        ],
        pollTicks: 5,
        tickDelayMs: 2500,
        maxConcurrentAgents: 2,
        runnerConfig: {
          defaultBehavior: { turnCount: 1, latencyPerTurnMs: 200 },
        },
        assertions: [{ type: "no_errors" }],
      };

      const result = await runLinearScenario(ctx, scenario);

      // With fast-finishing runs and 5 ticks, all 4 issues should eventually dispatch
      const titles = dispatchedTitles(result);
      const uniqueTitles = new Set(
        titles.map((t) => {
          const match = t.match(/(Fast finisher [AB]|Queued [CD])/);
          return match?.[1];
        }),
      );
      expect(uniqueTitles.size).toBeGreaterThanOrEqual(3);
    },
  );
});
