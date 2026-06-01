import { describe, expect, test } from "vitest";

import { makeIssue, runScenario, checkAssertions } from "../sandbox/sandbox.js";
import type { ChaosLinearClient } from "../sandbox/sandbox.js";

const trackerBase = {
  kind: "memory" as const,
  endpoint: "memory://test",
  activeStates: ["Todo", "In Progress"],
  terminalStates: ["Done", "Cancelled"],
};

describe("sandbox routing integration tests", () => {
  test("route label matches allowlist: issue dispatched", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("r1", "R-1", {
          state: "In Progress",
          stateType: "started",
          labels: ["symphony:backend"],
        }),
      ],
      settingsOverrides: {
        tracker: {
          ...trackerBase,
          dispatch: {
            acceptUnrouted: false,
            onlyRoutes: ["backend"],
            routeLabelPrefix: "Symphony:",
          },
        },
      },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 1,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("R-1"),
    );
    expect(starts).toHaveLength(1);
  });

  test("route label NOT in allowlist: issue NOT dispatched", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("r2", "R-2", {
          state: "In Progress",
          stateType: "started",
          labels: ["symphony:frontend"],
        }),
      ],
      settingsOverrides: {
        tracker: {
          ...trackerBase,
          dispatch: {
            acceptUnrouted: false,
            onlyRoutes: ["backend"],
            routeLabelPrefix: "Symphony:",
          },
        },
      },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 1,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("R-2"),
    );
    expect(starts).toHaveLength(0);
  });

  test("no route label + acceptUnrouted=true: dispatched", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("r3", "R-3", {
          state: "In Progress",
          stateType: "started",
          labels: ["bug", "feature"],
        }),
      ],
      settingsOverrides: {
        tracker: {
          ...trackerBase,
          dispatch: {
            acceptUnrouted: true,
            onlyRoutes: ["backend"],
            routeLabelPrefix: "Symphony:",
          },
        },
      },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 1,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("R-3"),
    );
    expect(starts).toHaveLength(1);
  });

  test("no route label + acceptUnrouted=false: NOT dispatched", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("r4", "R-4", {
          state: "In Progress",
          stateType: "started",
          labels: ["bug"],
        }),
      ],
      settingsOverrides: {
        tracker: {
          ...trackerBase,
          dispatch: {
            acceptUnrouted: false,
            onlyRoutes: ["backend"],
            routeLabelPrefix: "Symphony:",
          },
        },
      },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 1,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("R-4"),
    );
    expect(starts).toHaveLength(0);
  });

  test("onlyRoutes=null: all routes accepted", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("r5", "R-5", {
          state: "In Progress",
          stateType: "started",
          labels: ["symphony:anything-random"],
        }),
      ],
      settingsOverrides: {
        tracker: {
          ...trackerBase,
          dispatch: { acceptUnrouted: false, onlyRoutes: null, routeLabelPrefix: "Symphony:" },
        },
      },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 1,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("R-5"),
    );
    expect(starts).toHaveLength(1);
  });

  test("onlyRoutes=[]: all routed issues rejected", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("r6", "R-6", {
          state: "In Progress",
          stateType: "started",
          labels: ["symphony:backend"],
        }),
      ],
      settingsOverrides: {
        tracker: {
          ...trackerBase,
          dispatch: { acceptUnrouted: true, onlyRoutes: [], routeLabelPrefix: "Symphony:" },
        },
      },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 1,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("R-6"),
    );
    expect(starts).toHaveLength(0);
  });

  test("multiple routes, one matches allowlist: dispatched", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("r7", "R-7", {
          state: "In Progress",
          stateType: "started",
          labels: ["symphony:frontend", "symphony:backend"],
        }),
      ],
      settingsOverrides: {
        tracker: {
          ...trackerBase,
          dispatch: {
            acceptUnrouted: false,
            onlyRoutes: ["backend"],
            routeLabelPrefix: "Symphony:",
          },
        },
      },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 1,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("R-7"),
    );
    expect(starts).toHaveLength(1);
  });

  test("case-insensitive route matching", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("r8", "R-8", {
          state: "In Progress",
          stateType: "started",
          labels: ["SYMPHONY:BACKEND"],
        }),
      ],
      settingsOverrides: {
        tracker: {
          ...trackerBase,
          dispatch: {
            acceptUnrouted: false,
            onlyRoutes: ["Backend"],
            routeLabelPrefix: "Symphony:",
          },
        },
      },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 1,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("R-8"),
    );
    expect(starts).toHaveLength(1);
  });

  test("assignedToWorker=false short-circuits routing", async () => {
    // normalizeIssue computes assignedToWorker from assignee/assigneeId,
    // so we must override it after creation to simulate a different worker assignment.
    const issue = makeIssue("r9", "R-9", {
      state: "In Progress",
      stateType: "started",
      labels: ["symphony:backend"],
    });
    (issue as { assignedToWorker: boolean }).assignedToWorker = false;

    const result = await runScenario({
      issues: [issue],
      settingsOverrides: {
        tracker: {
          ...trackerBase,
          dispatch: {
            acceptUnrouted: true,
            onlyRoutes: ["backend"],
            routeLabelPrefix: "Symphony:",
          },
        },
      },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 1,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("R-9"),
    );
    expect(starts).toHaveLength(0);
  });

  test("route with whitespace-only suffix: not dispatched (treated as invalid route)", async () => {
    const result = await runScenario({
      issues: [
        makeIssue("r10", "R-10", {
          state: "In Progress",
          stateType: "started",
          labels: ["symphony:   "],
        }),
      ],
      settingsOverrides: {
        tracker: {
          ...trackerBase,
          dispatch: { acceptUnrouted: true, onlyRoutes: null, routeLabelPrefix: "Symphony:" },
        },
      },
      runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 } },
      pollTicks: 1,
    });

    const starts = result.events.filter(
      (e) => e.type === "run_started" && e.message.includes("R-10"),
    );
    expect(starts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Route label change mid-run triggers worker stop via reconciliation.
// This exercises the runtime reconciliation path where routedToThisWorker()
// returns false after a label mutation, causing the orchestrator to stop
// the worker for that issue.
// ---------------------------------------------------------------------------
describe("sandbox routing: route label change mid-run triggers reconciliation stop", () => {
  test(
    "route label removed mid-run causes worker stop via reconciliation",
    { timeout: 10_000 },
    async () => {
      // Worker configured to only accept "team-alpha" route with acceptUnrouted=false.
      // Issue starts with matching label. Mid-run the label is removed, making the
      // issue unrouted. The next reconciliation tick detects routedToThisWorker()=false
      // and stops the worker.
      const result = await runScenario({
        issues: [
          makeIssue("routed-1", "ROUTE-1", {
            state: "In Progress",
            stateType: "started",
            labels: ["Symphony:team-alpha"],
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
              onlyRoutes: ["team-alpha"],
              routeLabelPrefix: "Symphony:",
            },
          },
        },
        runnerConfig: {
          defaultBehavior: { turnCount: 10, latencyPerTurnMs: 80 },
        },
        pollTicks: 4,
        tickDelayMs: 150,
        timedMutations: [
          {
            afterMs: 120,
            mutate: { type: "change_labels", issueId: "routed-1", labels: [] },
          },
        ],
      });

      // Reconciliation should detect unrouted state and stop the worker
      const assertions = checkAssertions(result, [
        { type: "not_running", issueId: "routed-1" },
        { type: "event_occurred", eventType: "run_reconciled", messageContains: "ROUTE-1" },
      ]);
      for (const a of assertions) {
        expect(a.passed, a.message).toBe(true);
      }
    },
  );

  test(
    "route label changed to different route mid-run causes worker stop",
    { timeout: 10_000 },
    async () => {
      // Worker only accepts "team-alpha". Issue initially has "team-alpha" label,
      // which is changed to "team-beta" mid-run. Since team-beta is not in
      // onlyRoutes, routedToThisWorker() returns false and reconciliation stops it.
      const result = await runScenario({
        issues: [
          makeIssue("routed-2", "ROUTE-2", {
            state: "In Progress",
            stateType: "started",
            labels: ["Symphony:team-alpha"],
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
              onlyRoutes: ["team-alpha"],
              routeLabelPrefix: "Symphony:",
            },
          },
        },
        runnerConfig: {
          defaultBehavior: { turnCount: 10, latencyPerTurnMs: 80 },
        },
        pollTicks: 4,
        tickDelayMs: 150,
        timedMutations: [
          {
            afterMs: 120,
            mutate: {
              type: "change_labels",
              issueId: "routed-2",
              labels: ["Symphony:team-beta"],
            },
          },
        ],
      });

      // Reconciliation should detect the route mismatch and stop the worker
      const assertions = checkAssertions(result, [
        { type: "not_running", issueId: "routed-2" },
        { type: "event_occurred", eventType: "run_reconciled", messageContains: "ROUTE-2" },
      ]);
      for (const a of assertions) {
        expect(a.passed, a.message).toBe(true);
      }
    },
  );

  test(
    "route label stays consistent: issue completes without reconciliation stop",
    { timeout: 10_000 },
    async () => {
      // Control test: if the route label never changes, the issue should
      // complete normally without a reconciliation stop event.
      const result = await runScenario({
        issues: [
          makeIssue("routed-3", "ROUTE-3", {
            state: "In Progress",
            stateType: "started",
            labels: ["Symphony:team-alpha"],
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
              onlyRoutes: ["team-alpha"],
              routeLabelPrefix: "Symphony:",
            },
          },
        },
        runnerConfig: {
          defaultBehavior: { turnCount: 2, latencyPerTurnMs: 10 },
        },
        pollTicks: 2,
        tickDelayMs: 50,
      });

      // Should complete normally -- no reconciliation stop for route mismatch
      const assertions = checkAssertions(result, [
        { type: "event_occurred", eventType: "run_started", messageContains: "ROUTE-3" },
        { type: "event_occurred", eventType: "run_completed", messageContains: "ROUTE-3" },
        { type: "event_not_occurred", eventType: "run_reconciled", messageContains: "ROUTE-3" },
      ]);
      for (const a of assertions) {
        expect(a.passed, a.message).toBe(true);
      }
    },
  );

  test(
    "unrouted issue not dispatched when acceptUnrouted=false with onlyRoutes set",
    { timeout: 10_000 },
    async () => {
      // Issue has no route label at all. Worker is configured with onlyRoutes
      // and acceptUnrouted=false, so it should never be dispatched.
      const result = await runScenario({
        issues: [
          makeIssue("unrouted-1", "UNRT-1", {
            state: "Todo",
            stateType: "unstarted",
            labels: [],
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
              onlyRoutes: ["team-alpha"],
              routeLabelPrefix: "Symphony:",
            },
          },
        },
        runnerConfig: {
          defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 },
        },
        pollTicks: 2,
        tickDelayMs: 50,
      });

      // Issue should never be dispatched
      const assertions = checkAssertions(result, [
        { type: "not_running", issueId: "unrouted-1" },
        { type: "event_not_occurred", eventType: "run_started", messageContains: "UNRT-1" },
      ]);
      for (const a of assertions) {
        expect(a.passed, a.message).toBe(true);
      }
    },
  );

  test(
    "route label added mid-run does not disrupt run when onlyRoutes=null (accept all)",
    { timeout: 10_000 },
    async () => {
      // Worker accepts unrouted (acceptUnrouted=true) and has onlyRoutes=null.
      // Issue starts with no route label and gets dispatched. Mid-run, a route
      // label for a different team is added. Since onlyRoutes is null (accept all),
      // the worker still owns it and reconciliation does not stop it.
      const result = await runScenario({
        issues: [
          makeIssue("noroutelabel-1", "NRL-1", {
            state: "In Progress",
            stateType: "started",
            labels: [],
          }),
        ],
        settingsOverrides: {
          tracker: {
            kind: "memory",
            endpoint: "memory://test",
            activeStates: ["Todo", "In Progress"],
            terminalStates: ["Done", "Cancelled"],
            dispatch: {
              acceptUnrouted: true,
              onlyRoutes: null,
              routeLabelPrefix: "Symphony:",
            },
          },
        },
        runnerConfig: {
          defaultBehavior: { turnCount: 3, latencyPerTurnMs: 50 },
        },
        pollTicks: 3,
        tickDelayMs: 100,
        timedMutations: [
          {
            afterMs: 80,
            mutate: {
              type: "change_labels",
              issueId: "noroutelabel-1",
              labels: ["Symphony:team-beta"],
            },
          },
        ],
      });

      // Should NOT be reconciled away because onlyRoutes=null means accept all routes
      const assertions = checkAssertions(result, [
        { type: "event_occurred", eventType: "run_started", messageContains: "NRL-1" },
        { type: "event_not_occurred", eventType: "run_reconciled", messageContains: "NRL-1" },
      ]);
      for (const a of assertions) {
        expect(a.passed, a.message).toBe(true);
      }
    },
  );

  test(
    "multiple issues: only the re-routed issue is stopped, others continue",
    { timeout: 10_000 },
    async () => {
      // Two issues routed to team-alpha. One has its label changed mid-run
      // via tick mutation. Only the re-routed issue should be stopped; the
      // other continues or completes normally.
      const result = await runScenario({
        issues: [
          makeIssue("multi-a", "MULTI-A", {
            state: "In Progress",
            stateType: "started",
            labels: ["Symphony:team-alpha"],
          }),
          makeIssue("multi-b", "MULTI-B", {
            state: "In Progress",
            stateType: "started",
            labels: ["Symphony:team-alpha"],
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
              onlyRoutes: ["team-alpha"],
              routeLabelPrefix: "Symphony:",
            },
          },
        },
        runnerConfig: {
          defaultBehavior: { turnCount: 10, latencyPerTurnMs: 80 },
        },
        pollTicks: 4,
        tickDelayMs: 150,
        mutations: {
          1: (client: ChaosLinearClient) => {
            // Re-route only multi-a to team-beta
            client.updateIssue("multi-a", { labels: ["Symphony:team-beta"] });
          },
        },
      });

      // multi-a should be stopped via reconciliation
      const assertionsA = checkAssertions(result, [
        { type: "not_running", issueId: "multi-a" },
        { type: "event_occurred", eventType: "run_reconciled", messageContains: "MULTI-A" },
      ]);
      for (const a of assertionsA) {
        expect(a.passed, a.message).toBe(true);
      }

      // multi-b should NOT have been reconciled away
      const multiBReconciled = result.events.some(
        (e) => e.type === "run_reconciled" && e.message.includes("MULTI-B"),
      );
      expect(multiBReconciled).toBe(false);
    },
  );
});
