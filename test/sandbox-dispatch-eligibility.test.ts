import { describe, test, expect } from "vitest";

import { runScenario, makeIssue, checkAssertions } from "../sandbox/sandbox.js";

describe("Sandbox: Dispatch Eligibility", () => {
  // -------------------------------------------------------------------------
  // Issue with empty id is not dispatched
  // -------------------------------------------------------------------------
  test("issue with empty id is not dispatched", async () => {
    const result = await runScenario({
      issues: [makeIssue("valid-1", "VALID-1", { state: "Todo", stateType: "unstarted" })],
      pollTicks: 1,
      mutations: {
        0: (client) => {
          // Replace with an issue that has an empty id
          client.removeIssue("valid-1");
          client.addIssue({
            id: "",
            identifier: "EMPTY-ID",
            title: "Empty ID issue",
            state: "Todo",
            stateType: "unstarted" as const,
            labels: [],
            blockers: [],
            priority: 1,
            description: null,
            assignedToWorker: true,
          });
        },
      },
    });
    const startedForEmpty = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("EMPTY-ID"),
    );
    expect(startedForEmpty).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Issue with empty identifier is not dispatched
  // -------------------------------------------------------------------------
  test("issue with empty identifier is not dispatched", async () => {
    const result = await runScenario({
      issues: [makeIssue("valid-1", "VALID-1", { state: "Todo", stateType: "unstarted" })],
      pollTicks: 1,
      mutations: {
        0: (client) => {
          client.removeIssue("valid-1");
          client.addIssue({
            id: "empty-ident",
            identifier: "",
            title: "Empty identifier issue",
            state: "Todo",
            stateType: "unstarted" as const,
            labels: [],
            blockers: [],
            priority: 1,
            description: null,
            assignedToWorker: true,
          });
        },
      },
    });
    const startedForEmpty = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("empty-ident"),
    );
    expect(startedForEmpty).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Issue with empty title is not dispatched
  // -------------------------------------------------------------------------
  test("issue with empty title is not dispatched", async () => {
    const result = await runScenario({
      issues: [makeIssue("valid-1", "VALID-1", { state: "Todo", stateType: "unstarted" })],
      pollTicks: 1,
      mutations: {
        0: (client) => {
          client.removeIssue("valid-1");
          client.addIssue({
            id: "empty-title",
            identifier: "EMPTY-TITLE",
            title: "",
            state: "Todo",
            stateType: "unstarted" as const,
            labels: [],
            blockers: [],
            priority: 1,
            description: null,
            assignedToWorker: true,
          });
        },
      },
    });
    const startedForEmpty = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("EMPTY-TITLE"),
    );
    expect(startedForEmpty).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Issue with empty state is not dispatched
  // -------------------------------------------------------------------------
  test("issue with empty state is not dispatched", async () => {
    const result = await runScenario({
      issues: [makeIssue("valid-1", "VALID-1", { state: "Todo", stateType: "unstarted" })],
      pollTicks: 1,
      mutations: {
        0: (client) => {
          client.removeIssue("valid-1");
          client.addIssue({
            id: "empty-state",
            identifier: "EMPTY-STATE",
            title: "Empty state issue",
            state: "",
            stateType: "unstarted" as const,
            labels: [],
            blockers: [],
            priority: 1,
            description: null,
            assignedToWorker: true,
          });
        },
      },
    });
    const startedForEmpty = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("EMPTY-STATE"),
    );
    expect(startedForEmpty).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Terminal state issue is not dispatched
  // -------------------------------------------------------------------------
  test("terminal state issue is not dispatched", async () => {
    const result = await runScenario({
      issues: [makeIssue("done-1", "DONE-1", { state: "Done", stateType: "completed" })],
      pollTicks: 1,
    });
    expect(result.events.some((e) => e.type === "run_started")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Non-active state issue is not dispatched
  // -------------------------------------------------------------------------
  test("non-active state issue is not dispatched", async () => {
    const result = await runScenario({
      issues: [makeIssue("backlog-1", "BACKLOG-1", { state: "Backlog", stateType: "backlog" })],
      pollTicks: 1,
    });
    expect(result.events.some((e) => e.type === "run_started")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Issue with assignedToWorker=false is not dispatched
  // -------------------------------------------------------------------------
  test("issue with assignedToWorker=false is not dispatched", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("unassigned-1", "UNASSIGNED-1", { state: "Todo", stateType: "unstarted" }),
      ],
      pollTicks: 1,
      mutations: {
        0: (client) => {
          // Set assignedToWorker=false directly on the stored issue
          client.updateIssue("unassigned-1", { assignedToWorker: false });
        },
      },
    });
    expect(result.events.some((e) => e.type === "run_started")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Unstarted issue with non-terminal blocker is not dispatched
  // -------------------------------------------------------------------------
  test("unstarted issue with non-terminal blocker is not dispatched", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("blocked-1", "BLOCKED-1", {
          state: "Todo",
          stateType: "unstarted",
          blockers: [{ id: "dep-1", identifier: "DEP-1", state: "Todo", stateType: "unstarted" }],
        }),
      ],
      pollTicks: 1,
    });
    expect(result.events.some((e) => e.type === "run_started")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Unstarted issue with mix of terminal and non-terminal blockers
  // is not dispatched (any non-terminal blocker gates)
  // -------------------------------------------------------------------------
  test("unstarted issue with any non-terminal blocker is not dispatched", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("blocked-mix", "BLOCKED-MIX", {
          state: "Todo",
          stateType: "unstarted",
          blockers: [
            { id: "dep-done", identifier: "DEP-DONE", state: "Done", stateType: "completed" },
            { id: "dep-todo", identifier: "DEP-TODO", state: "Todo", stateType: "unstarted" },
          ],
        }),
      ],
      pollTicks: 1,
    });
    expect(result.events.some((e) => e.type === "run_started")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Started issue WITH blockers is still dispatched
  // (blockers only gate unstarted issues)
  // -------------------------------------------------------------------------
  test("started issue with blockers is still dispatched", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("started-blocked", "STARTED-BLOCKED", {
          state: "In Progress",
          stateType: "started",
          blockers: [{ id: "dep-1", identifier: "DEP-1", state: "Todo", stateType: "unstarted" }],
        }),
      ],
      pollTicks: 1,
    });
    expect(result.events.some((e) => e.type === "run_started")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Unstarted issue with all blockers resolved is eligible
  // -------------------------------------------------------------------------
  test("unstarted issue with all blockers resolved is dispatched", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("unblocked-1", "UNBLOCKED-1", {
          state: "Todo",
          stateType: "unstarted",
          blockers: [
            { id: "dep-done", identifier: "DEP-DONE", state: "Done", stateType: "completed" },
            {
              id: "dep-cancelled",
              identifier: "DEP-CANCELLED",
              state: "Cancelled",
              stateType: "completed",
            },
          ],
        }),
      ],
      settingsOverrides: {
        tracker: {
          kind: "memory",
          endpoint: "memory://test",
          activeStates: ["Todo", "In Progress"],
          terminalStates: ["Done", "Cancelled"],
          dispatch: { acceptUnrouted: true, onlyRoutes: null, routeLabelPrefix: "Lorenz:" },
        },
      },
      pollTicks: 1,
    });
    expect(result.events.some((e) => e.type === "run_started")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Global concurrency cap respected (cap=2, 5 issues)
  // -------------------------------------------------------------------------
  test("global concurrency cap is respected", async () => {
    const issues = Array.from({ length: 5 }, (_, i) =>
      makeIssue(`cap-${i}`, `CAP-${i}`, { state: "In Progress", stateType: "started" }),
    );

    const result = await runScenario({
      issues,
      settingsOverrides: {
        agent: { maxConcurrentAgents: 2 },
      },
      runnerConfig: {
        defaultBehavior: { turnCount: 3, latencyPerTurnMs: 50 },
      },
      pollTicks: 3,
      tickDelayMs: 100,
      waitForRuns: false,
    });

    const assertionResults = checkAssertions(result, [
      { type: "concurrency_cap", maxConcurrent: 2 },
    ]);
    expect(assertionResults[0]!.passed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Per-state cap respected via statusOverrides
  // -------------------------------------------------------------------------
  test("per-state concurrency cap is respected via statusOverrides", async () => {
    const issues = Array.from({ length: 4 }, (_, i) =>
      makeIssue(`state-cap-${i}`, `SCAP-${i}`, { state: "In Progress", stateType: "started" }),
    );

    const result = await runScenario({
      issues,
      settingsOverrides: {
        agent: { maxConcurrentAgents: 10 },
        statusOverrides: {
          "In Progress": { agent: { maxConcurrentAgents: 1 } },
        },
      },
      runnerConfig: {
        defaultBehavior: { turnCount: 3, latencyPerTurnMs: 50 },
      },
      pollTicks: 2,
      tickDelayMs: 100,
      waitForRuns: false,
    });

    const assertionResults = checkAssertions(result, [
      { type: "concurrency_cap", maxConcurrent: 1 },
    ]);
    expect(assertionResults[0]!.passed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // All ensemble slots claimed -> not dispatched again
  // -------------------------------------------------------------------------
  test("issue with all ensemble slots claimed is not dispatched again", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("ens-1", "ENS-1", {
          state: "In Progress",
          stateType: "started",
          labels: ["ensemble:2"],
        }),
      ],
      runnerConfig: {
        defaultBehavior: { turnCount: 5, latencyPerTurnMs: 50 },
      },
      pollTicks: 3,
      tickDelayMs: 100,
      waitForRuns: false,
    });

    // Should have started exactly 2 slots (ensemble:2)
    const startEvents = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("ENS-1"),
    );
    expect(startEvents).toHaveLength(2);
    // Verify slot 0 and slot 1 are claimed
    expect(startEvents.some((e) => e.message.includes("slot=0"))).toBe(true);
    expect(startEvents.some((e) => e.message.includes("slot=1"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Active state issue with all conditions met is dispatched
  // -------------------------------------------------------------------------
  test("active state issue with all conditions met is dispatched", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("eligible-1", "ELIGIBLE-1", {
          state: "Todo",
          stateType: "unstarted",
          blockers: [],
        }),
      ],
      pollTicks: 1,
    });
    expect(result.events.some((e) => e.type === "run_started")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Global concurrency cap at limit prevents dispatch
  // (cap=0 is invalid config; test cap=1 with 1 already running)
  // -------------------------------------------------------------------------
  test("global concurrency cap at limit prevents further dispatch", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("cap-fill", "CFILL-1", { state: "In Progress", stateType: "started" }),
        makeIssue("cap-block", "CBLOCK-1", { state: "In Progress", stateType: "started" }),
      ],
      settingsOverrides: {
        agent: { maxConcurrentAgents: 1 },
      },
      runnerConfig: {
        defaultBehavior: { turnCount: 3, latencyPerTurnMs: 100 },
      },
      pollTicks: 1,
      waitForRuns: false,
    });
    // Only one issue should get dispatched due to cap=1
    const startEvents = result.events.filter((e) => e.type === "run_started");
    expect(startEvents).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Originally a bug where state="Todo" triggered blocker check even with
  // stateType="started". Fixed: issueHasOpenBlockers now only checks stateType.
  test("stateType=started + state=Todo is NOT gated by blockers (fixed)", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("s184-bug", "S184-1", {
          state: "Todo",
          stateType: "started",
          blockers: [
            {
              id: "blocker-1",
              identifier: "BLOCKER-1",
              state: "In Progress",
              stateType: "started",
            },
          ],
        }),
      ],
      pollTicks: 1,
    });

    // This SHOULD dispatch because stateType="started" means blockers should
    // not gate. But due to the bug, state="Todo" triggers the blocker check.
    expect(
      result.events.some((e) => e.type === "run_started" && e.message.includes("S184-1")),
    ).toBe(true);
  });
});
