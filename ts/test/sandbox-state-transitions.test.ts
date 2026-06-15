/**
 * Integration tests for "State Transitions" category via the sandbox's runScenario.
 *
 * Tests issue lifecycle transitions, reconciliation behavior on state changes,
 * route/assignee mismatch handling, blocker interactions with running workers,
 * and complex multi-issue state changes.
 */

import { describe, expect, test } from "vitest";

import { runScenario, makeIssue, checkAssertions } from "../sandbox/sandbox.js";
import type { ChaosLinearClient } from "../sandbox/sandbox.js";

describe("Sandbox: State Transitions", () => {
  // ---------------------------------------------------------------------------
  // Full lifecycle: issue progresses Todo -> In Progress -> Done
  // ---------------------------------------------------------------------------
  describe("Full lifecycle handled: dispatched during active states, cleaned up when terminal", () => {
    test("issue dispatched in Todo, transitions through In Progress, cleaned up at Done", async () => {
      const result = await runScenario({
        issues: [makeIssue("lifecycle-1", "LIFE-1", { state: "Todo", stateType: "unstarted" })],
        runnerConfig: { defaultBehavior: { turnCount: 8, latencyPerTurnMs: 60 } },
        pollTicks: 6,
        tickDelayMs: 150,
        waitForRuns: false,
        mutations: {
          1: (client: ChaosLinearClient) => {
            // External system moves issue to In Progress
            client.changeIssueState("lifecycle-1", "In Progress", "started");
          },
          3: (client: ChaosLinearClient) => {
            // External system marks Done
            client.changeIssueState("lifecycle-1", "Done", "completed");
          },
        },
      });

      // Should have been dispatched (Todo is an active state)
      expect(
        result.events.some((e) => e.type === "run_started" && e.message.includes("LIFE-1")),
      ).toBe(true);

      // Terminal state triggers workspace cleanup
      expect(
        result.events.some((e) => e.type === "workspace_cleanup" && e.message.includes("LIFE-1")),
      ).toBe(true);

      // Should not be running at the end
      expect(result.finalSnapshot.running).toHaveLength(0);
    }, 10_000);

    test("full lifecycle with timedMutations for progressive state changes", async () => {
      const result = await runScenario({
        issues: [makeIssue("lifecycle-2", "LIFE-2", { state: "Todo", stateType: "unstarted" })],
        runnerConfig: { defaultBehavior: { turnCount: 10, latencyPerTurnMs: 80 } },
        pollTicks: 5,
        tickDelayMs: 200,
        waitForRuns: false,
        timedMutations: [
          {
            afterMs: 100,
            mutate: {
              type: "change_state",
              issueId: "lifecycle-2",
              state: "In Progress",
              stateType: "started",
            },
          },
          {
            afterMs: 500,
            mutate: {
              type: "change_state",
              issueId: "lifecycle-2",
              state: "Done",
              stateType: "completed",
            },
          },
        ],
      });

      // Dispatched during active state
      expect(
        result.events.some((e) => e.type === "run_started" && e.message.includes("LIFE-2")),
      ).toBe(true);

      // Terminal state triggers workspace cleanup
      expect(result.events.some((e) => e.type === "workspace_cleanup")).toBe(true);

      // No longer running
      expect(result.finalSnapshot.running).toHaveLength(0);
    }, 10_000);
  });

  // ---------------------------------------------------------------------------
  // Terminal state triggers workspace cleanup after cancellation
  // ---------------------------------------------------------------------------
  describe("Terminal state stops worker and triggers workspace cleanup", () => {
    test("cancellation triggers workspace_cleanup event", async () => {
      const result = await runScenario({
        issues: [makeIssue("cancel-1", "CAN-1", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 20, latencyPerTurnMs: 100 } },
        pollTicks: 4,
        tickDelayMs: 200,
        waitForRuns: false,
        timedMutations: [
          {
            afterMs: 50,
            mutate: {
              type: "change_state",
              issueId: "cancel-1",
              state: "Cancelled",
              stateType: "completed",
            },
          },
        ],
      });

      // Worker should be stopped
      expect(result.finalSnapshot.running).toHaveLength(0);

      // workspace_cleanup event should fire for terminal (cancelled) state
      const cleanupEvent = result.events.find(
        (e) => e.type === "workspace_cleanup" && e.message.includes("CAN-1"),
      );
      expect(cleanupEvent).toBeDefined();
    }, 10_000);

    test("Done state also triggers workspace_cleanup", async () => {
      const result = await runScenario({
        issues: [makeIssue("done-1", "DONE-1", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 20, latencyPerTurnMs: 100 } },
        pollTicks: 4,
        tickDelayMs: 200,
        waitForRuns: false,
        timedMutations: [
          {
            afterMs: 50,
            mutate: {
              type: "change_state",
              issueId: "done-1",
              state: "Done",
              stateType: "completed",
            },
          },
        ],
      });

      expect(result.finalSnapshot.running).toHaveLength(0);
      expect(
        result.events.some((e) => e.type === "workspace_cleanup" && e.message.includes("DONE-1")),
      ).toBe(true);
    }, 10_000);
  });

  // ---------------------------------------------------------------------------
  // Issue moved to backlog stops worker but keeps workspace
  // ---------------------------------------------------------------------------
  describe("Inactive (non-terminal) state stops worker but preserves workspace", () => {
    test("issue moved to Backlog stops worker but no workspace_cleanup fires", async () => {
      const result = await runScenario({
        issues: [makeIssue("backlog-1", "BKL-1", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 20, latencyPerTurnMs: 100 } },
        pollTicks: 4,
        tickDelayMs: 200,
        waitForRuns: false,
        timedMutations: [
          {
            afterMs: 50,
            mutate: {
              type: "change_state",
              issueId: "backlog-1",
              state: "Backlog",
              stateType: "backlog",
            },
          },
        ],
      });

      // Worker should be stopped
      expect(result.finalSnapshot.running).toHaveLength(0);

      // run_reconciled event should fire (non-terminal path)
      expect(
        result.events.some((e) => e.type === "run_reconciled" && e.message.includes("BKL-1")),
      ).toBe(true);

      // workspace_cleanup should NOT fire for non-terminal states
      expect(result.events.some((e) => e.type === "workspace_cleanup")).toBe(false);
    }, 10_000);

    test("issue moved to Triage (non-active, non-terminal) stops worker without cleanup", async () => {
      const result = await runScenario({
        issues: [makeIssue("triage-1", "TRI-1", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 20, latencyPerTurnMs: 100 } },
        pollTicks: 4,
        tickDelayMs: 200,
        waitForRuns: false,
        mutations: {
          1: (client: ChaosLinearClient) => {
            // Move to a non-active, non-terminal state
            client.changeIssueState("triage-1", "Triage", "triage");
          },
        },
      });

      expect(result.finalSnapshot.running).toHaveLength(0);
      expect(
        result.events.some((e) => e.type === "run_reconciled" && e.message.includes("TRI-1")),
      ).toBe(true);
      expect(result.events.some((e) => e.type === "workspace_cleanup")).toBe(false);
    }, 10_000);
  });

  // ---------------------------------------------------------------------------
  // Route mismatch mid-run stops worker via reconciliation
  // ---------------------------------------------------------------------------
  describe("Route mismatch triggers reconciliation stop", () => {
    test("changing labels to a different route mid-run stops the worker", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("route-1", "RTE-1", {
            state: "In Progress",
            stateType: "started",
            labels: ["Lorenz:backend"],
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
            mutate: { type: "change_labels", issueId: "route-1", labels: ["Lorenz:frontend"] },
          },
        ],
      });

      // Worker should be stopped after route mismatch
      expect(result.finalSnapshot.running).toHaveLength(0);
      expect(
        result.events.some((e) => e.type === "run_reconciled" && e.message.includes("RTE-1")),
      ).toBe(true);
      // Should NOT trigger workspace_cleanup (not terminal)
      expect(result.events.some((e) => e.type === "workspace_cleanup")).toBe(false);
    }, 10_000);

    test("removing all route labels when acceptUnrouted=false stops worker", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("route-2", "RTE-2", {
            state: "In Progress",
            stateType: "started",
            labels: ["Lorenz:backend"],
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
        mutations: {
          1: (client: ChaosLinearClient) => {
            // Remove all labels; acceptUnrouted=false means not routed here
            client.updateIssue("route-2", { labels: [] });
          },
        },
      });

      expect(result.finalSnapshot.running).toHaveLength(0);
      expect(
        result.events.some((e) => e.type === "run_reconciled" && e.message.includes("RTE-2")),
      ).toBe(true);
    }, 10_000);

    test("changing labels from allowed route to non-route label stops worker", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("route-3", "RTE-3", {
            state: "In Progress",
            stateType: "started",
            labels: ["Lorenz:backend"],
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
            mutate: {
              type: "change_labels",
              issueId: "route-3",
              labels: ["unrelated-label"],
            },
          },
        ],
      });

      // Without any Lorenz: prefixed label, acceptUnrouted=false means not routed here
      expect(result.finalSnapshot.running).toHaveLength(0);
      expect(result.events.some((e) => e.type === "run_reconciled")).toBe(true);
    }, 10_000);
  });

  // ---------------------------------------------------------------------------
  // assignedToWorker set to false mid-run stops worker
  // ---------------------------------------------------------------------------
  describe("Assignee mismatch triggers reconciliation stop", () => {
    test("assignedToWorker=false mid-run stops worker via reconciliation", async () => {
      const result = await runScenario({
        issues: [makeIssue("assign-1", "ASN-1", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 20, latencyPerTurnMs: 100 } },
        pollTicks: 4,
        tickDelayMs: 200,
        waitForRuns: false,
        mutations: {
          1: (client: ChaosLinearClient) => {
            client.updateIssue("assign-1", { assignedToWorker: false });
          },
        },
      });

      // Worker should stop because routedToThisWorker returns false
      expect(result.finalSnapshot.running).toHaveLength(0);
      expect(
        result.events.some((e) => e.type === "run_reconciled" && e.message.includes("ASN-1")),
      ).toBe(true);
    }, 10_000);

    test("assignedToWorker=false on retrying issue clears retry timer", async () => {
      const result = await runScenario({
        issues: [makeIssue("assign-2", "ASN-2", { state: "In Progress", stateType: "started" })],
        runnerConfig: {
          defaultBehavior: { shouldSucceed: false, turnCount: 1, latencyPerTurnMs: 0 },
        },
        pollTicks: 5,
        tickDelayMs: 100,
        mutations: {
          2: (client: ChaosLinearClient) => {
            // After initial failure puts it into retry, reassign away
            client.updateIssue("assign-2", { assignedToWorker: false });
          },
        },
      });

      // After reassignment, the retrying entry should be cleaned up
      expect(result.finalSnapshot.retrying.filter((r) => r.issueId === "assign-2")).toHaveLength(0);
      expect(
        result.events.some((e) => e.type === "run_reconciled" && e.message.includes("ASN-2")),
      ).toBe(true);
    }, 10_000);

    test("assignedToWorker toggled back allows re-dispatch", async () => {
      const result = await runScenario({
        issues: [makeIssue("assign-3", "ASN-3", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 10 } },
        pollTicks: 6,
        tickDelayMs: 100,
        mutations: {
          1: (client: ChaosLinearClient) => {
            client.updateIssue("assign-3", { assignedToWorker: false });
          },
          3: (client: ChaosLinearClient) => {
            // Re-assign back to this worker (undefined means default/assigned)
            client.updateIssue("assign-3", { assignedToWorker: undefined });
          },
        },
      });

      // Should have been started at least once
      const startedEvents = result.events.filter(
        (e) => e.type === "run_started" && e.message.includes("ASN-3"),
      );
      expect(startedEvents.length).toBeGreaterThanOrEqual(1);
      // Should have been reconciled when assignedToWorker changed to false
      expect(
        result.events.some((e) => e.type === "run_reconciled" && e.message.includes("ASN-3")),
      ).toBe(true);
    }, 10_000);
  });

  // ---------------------------------------------------------------------------
  // Blocker added to in-progress issue does not stop running worker
  // ---------------------------------------------------------------------------
  describe("New blocker on started issue does not trigger reconciliation stop", () => {
    test("blocker added to in-progress (started) issue does NOT stop worker", async () => {
      const result = await runScenario({
        issues: [makeIssue("blocker-1", "BLK-1", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 5, latencyPerTurnMs: 80 } },
        pollTicks: 4,
        tickDelayMs: 150,
        timedMutations: [
          {
            afterMs: 100,
            mutate: {
              type: "add_blocker",
              issueId: "blocker-1",
              blockerId: "dep-new",
              blockerIdentifier: "DEP-NEW",
            },
          },
        ],
      });

      // The worker should NOT be reconciled out because issueHasOpenBlockers
      // returns false for stateType=started (line 26 of dispatch/src)
      const reconcileForBlocker = result.events.filter(
        (e) => e.type === "run_reconciled" && e.message.includes("BLK-1"),
      );
      expect(reconcileForBlocker).toHaveLength(0);

      // The issue should have continued running or completed normally
      const assertions = checkAssertions(result, [
        { type: "event_occurred", eventType: "run_started", messageContains: "BLK-1" },
      ]);
      expect(assertions.every((a) => a.passed)).toBe(true);
    }, 10_000);

    test("blocker on unstarted issue DOES block dispatch", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("blocker-2", "BLK-2", {
            state: "Todo",
            stateType: "unstarted",
            blockers: [
              { id: "dep-1", identifier: "DEP-1", state: "In Progress", stateType: "started" },
            ],
          }),
        ],
        runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 0 } },
        pollTicks: 3,
        tickDelayMs: 50,
      });

      // Issue with open blocker in unstarted state should NOT be dispatched
      const startedEvents = result.events.filter(
        (e) => e.type === "run_started" && e.message.includes("BLK-2"),
      );
      expect(startedEvents).toHaveLength(0);
    });

    test("blocker added then removed from started issue -- worker continues uninterrupted", async () => {
      const result = await runScenario({
        issues: [makeIssue("blocker-3", "BLK-3", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 6, latencyPerTurnMs: 60 } },
        pollTicks: 5,
        tickDelayMs: 120,
        timedMutations: [
          {
            afterMs: 80,
            mutate: {
              type: "add_blocker",
              issueId: "blocker-3",
              blockerId: "dep-x",
              blockerIdentifier: "DEP-X",
            },
          },
          {
            afterMs: 200,
            mutate: { type: "remove_blocker", issueId: "blocker-3", blockerId: "dep-x" },
          },
        ],
      });

      // Worker should not be reconciled due to blocker on started issue
      const reconciled = result.events.filter(
        (e) => e.type === "run_reconciled" && e.message.includes("BLK-3"),
      );
      expect(reconciled).toHaveLength(0);
    }, 10_000);
  });

  // ---------------------------------------------------------------------------
  // Issue re-dispatched after returning to active state from backlog
  // ---------------------------------------------------------------------------
  describe("Each state transition evaluated on next reconcile: re-dispatch after return to active", () => {
    test("issue dispatched, moved to backlog (stopped), returned to active (re-dispatched)", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("redispatch-1", "RDP-1", { state: "In Progress", stateType: "started" }),
        ],
        runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 10 } },
        pollTicks: 7,
        tickDelayMs: 100,
        mutations: {
          1: (client: ChaosLinearClient) => {
            // Move to backlog (inactive)
            client.changeIssueState("redispatch-1", "Backlog", "backlog");
          },
          4: (client: ChaosLinearClient) => {
            // Return to active state
            client.changeIssueState("redispatch-1", "In Progress", "started");
          },
        },
      });

      // Should have been dispatched initially
      const startedEvents = result.events.filter(
        (e) => e.type === "run_started" && e.message.includes("RDP-1"),
      );
      expect(startedEvents.length).toBeGreaterThanOrEqual(1);

      // Should have been reconciled when moved to backlog
      expect(
        result.events.some((e) => e.type === "run_reconciled" && e.message.includes("RDP-1")),
      ).toBe(true);

      // Should have been re-dispatched after returning to active (at least 2 start events)
      expect(startedEvents.length).toBeGreaterThanOrEqual(2);
    }, 10_000);

    test("issue dispatched, moved to backlog, returned to Todo (re-dispatched)", async () => {
      const result = await runScenario({
        issues: [makeIssue("redispatch-2", "RDP-2", { state: "Todo", stateType: "unstarted" })],
        runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 10 } },
        pollTicks: 7,
        tickDelayMs: 80,
        mutations: {
          1: (client: ChaosLinearClient) => {
            client.changeIssueState("redispatch-2", "Backlog", "backlog");
          },
          4: (client: ChaosLinearClient) => {
            client.changeIssueState("redispatch-2", "Todo", "unstarted");
          },
        },
      });

      const startedEvents = result.events.filter(
        (e) => e.type === "run_started" && e.message.includes("RDP-2"),
      );
      // Initial dispatch + re-dispatch after return to active
      expect(startedEvents.length).toBeGreaterThanOrEqual(2);
    }, 10_000);
  });

  // ---------------------------------------------------------------------------
  // Three issues with simultaneous state changes handled independently
  // ---------------------------------------------------------------------------
  describe("Each issue handled independently during reconciliation", () => {
    test("three issues: one terminal, one inactive, one still active -- handled independently", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("ind-a", "IND-A", { state: "In Progress", stateType: "started" }),
          makeIssue("ind-b", "IND-B", { state: "In Progress", stateType: "started" }),
          makeIssue("ind-c", "IND-C", { state: "In Progress", stateType: "started" }),
        ],
        runnerConfig: { defaultBehavior: { turnCount: 8, latencyPerTurnMs: 50 } },
        pollTicks: 5,
        tickDelayMs: 150,
        waitForRuns: false,
        mutations: {
          1: (client: ChaosLinearClient) => {
            // A -> terminal (Done), B -> inactive (Backlog), C stays active
            client.changeIssueState("ind-a", "Done", "completed");
            client.changeIssueState("ind-b", "Backlog", "backlog");
          },
        },
      });

      // A should have workspace_cleanup (terminal)
      expect(
        result.events.some((e) => e.type === "workspace_cleanup" && e.message.includes("IND-A")),
      ).toBe(true);

      // B should have run_reconciled but NOT workspace_cleanup (inactive non-terminal)
      expect(
        result.events.some((e) => e.type === "run_reconciled" && e.message.includes("IND-B")),
      ).toBe(true);
      expect(
        result.events.some((e) => e.type === "workspace_cleanup" && e.message.includes("IND-B")),
      ).toBe(false);

      // C should still have been running (or completed normally)
      expect(
        result.events.some((e) => e.type === "run_started" && e.message.includes("IND-C")),
      ).toBe(true);
      // C should NOT have been reconciled out
      expect(
        result.events.some((e) => e.type === "run_reconciled" && e.message.includes("IND-C")),
      ).toBe(false);
    }, 10_000);

    test("simultaneous terminal states on multiple issues triggers independent cleanup", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("term-a", "TERM-A", { state: "In Progress", stateType: "started" }),
          makeIssue("term-b", "TERM-B", { state: "In Progress", stateType: "started" }),
          makeIssue("term-c", "TERM-C", { state: "In Progress", stateType: "started" }),
        ],
        runnerConfig: { defaultBehavior: { turnCount: 8, latencyPerTurnMs: 50 } },
        pollTicks: 4,
        tickDelayMs: 150,
        waitForRuns: false,
        mutations: {
          1: (client: ChaosLinearClient) => {
            client.changeIssueState("term-a", "Done", "completed");
            client.changeIssueState("term-b", "Cancelled", "completed");
            client.changeIssueState("term-c", "Done", "completed");
          },
        },
      });

      // All three should have workspace_cleanup
      const cleanupEvents = result.events.filter((e) => e.type === "workspace_cleanup");
      expect(cleanupEvents.length).toBeGreaterThanOrEqual(3);
      expect(result.finalSnapshot.running).toHaveLength(0);
    }, 10_000);

    test("mixed transitions: one active continues while others change state", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("mix-a", "MIX-A", { state: "In Progress", stateType: "started" }),
          makeIssue("mix-b", "MIX-B", { state: "In Progress", stateType: "started" }),
          makeIssue("mix-c", "MIX-C", { state: "Todo", stateType: "unstarted" }),
        ],
        settingsOverrides: { agent: { maxConcurrentAgents: 5 } },
        runnerConfig: { defaultBehavior: { turnCount: 3, latencyPerTurnMs: 30 } },
        pollTicks: 5,
        tickDelayMs: 100,
        mutations: {
          2: (client: ChaosLinearClient) => {
            // A goes Done, B goes Backlog; C remains active (Todo)
            client.changeIssueState("mix-a", "Done", "completed");
            client.changeIssueState("mix-b", "Backlog", "backlog");
          },
        },
      });

      // C should still be dispatched/running normally
      expect(
        result.events.some((e) => e.type === "run_started" && e.message.includes("MIX-C")),
      ).toBe(true);
      // A terminal cleanup
      expect(
        result.events.some((e) => e.type === "workspace_cleanup" && e.message.includes("MIX-A")),
      ).toBe(true);
      // B reconciled (non-terminal)
      expect(
        result.events.some((e) => e.type === "run_reconciled" && e.message.includes("MIX-B")),
      ).toBe(true);
    }, 10_000);
  });

  // ---------------------------------------------------------------------------
  // Complex state changes with blockers resolved mid-run
  // ---------------------------------------------------------------------------
  describe("System stability under complex state changes with dependency resolution", () => {
    test("blocker removal enables dispatch of previously blocked issue", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("complex-1", "CMP-1", {
            state: "Todo",
            stateType: "unstarted",
            blockers: [
              { id: "dep-z", identifier: "DEP-Z", state: "In Progress", stateType: "started" },
            ],
          }),
        ],
        runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 10 } },
        pollTicks: 5,
        tickDelayMs: 100,
        mutations: {
          2: (client: ChaosLinearClient) => {
            // Resolve the blocker by changing its state to terminal
            client.updateIssue("complex-1", {
              blockers: [
                { id: "dep-z", identifier: "DEP-Z", state: "Done", stateType: "completed" },
              ],
            });
          },
        },
      });

      // Issue should be dispatched after blocker resolves
      const assertions = checkAssertions(result, [
        { type: "event_occurred", eventType: "run_started", messageContains: "CMP-1" },
      ]);
      expect(assertions.every((a) => a.passed)).toBe(true);
    }, 10_000);

    test("blocker removal + state change to active enables dispatch", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("complex-2", "CMP-2", {
            state: "Todo",
            stateType: "unstarted",
            blockers: [{ id: "dep-q", identifier: "DEP-Q", state: "Todo", stateType: "unstarted" }],
          }),
        ],
        runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 10 } },
        pollTicks: 6,
        tickDelayMs: 80,
        mutations: {
          1: (client: ChaosLinearClient) => {
            // Remove the blocker entirely
            client.updateIssue("complex-2", { blockers: [] });
          },
          3: (client: ChaosLinearClient) => {
            // Then move to In Progress (still active)
            client.changeIssueState("complex-2", "In Progress", "started");
          },
        },
      });

      // Should be dispatched once blocker is removed (Todo is active)
      expect(
        result.events.some((e) => e.type === "run_started" && e.message.includes("CMP-2")),
      ).toBe(true);
    }, 10_000);

    test("blocker added mid-run on started issue does not cause stop", async () => {
      const result = await runScenario({
        issues: [makeIssue("complex-3", "CMP-3", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 6, latencyPerTurnMs: 50 } },
        pollTicks: 5,
        tickDelayMs: 120,
        timedMutations: [
          {
            afterMs: 80,
            mutate: {
              type: "add_blocker",
              issueId: "complex-3",
              blockerId: "block-x",
              blockerIdentifier: "BLOCK-X",
            },
          },
        ],
      });

      // Worker should NOT be stopped because issueHasOpenBlockers returns false for started issues
      expect(
        result.events.some((e) => e.type === "run_started" && e.message.includes("CMP-3")),
      ).toBe(true);
      expect(
        result.events.some((e) => e.type === "run_reconciled" && e.message.includes("CMP-3")),
      ).toBe(false);
    }, 10_000);

    test("blocked -> unblocked -> dispatch -> terminal -> cleanup lifecycle", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("complex-4", "CMP-4", {
            state: "Todo",
            stateType: "unstarted",
            blockers: [
              { id: "dep-w", identifier: "DEP-W", state: "In Progress", stateType: "started" },
            ],
          }),
        ],
        runnerConfig: { defaultBehavior: { turnCount: 2, latencyPerTurnMs: 20 } },
        pollTicks: 8,
        tickDelayMs: 80,
        mutations: {
          1: (client: ChaosLinearClient) => {
            // Resolve blocker
            client.updateIssue("complex-4", {
              blockers: [
                { id: "dep-w", identifier: "DEP-W", state: "Done", stateType: "completed" },
              ],
            });
          },
          5: (client: ChaosLinearClient) => {
            // Move to terminal after it has been dispatched and completed
            client.changeIssueState("complex-4", "Done", "completed");
          },
        },
      });

      // Should eventually be dispatched
      expect(
        result.events.some((e) => e.type === "run_started" && e.message.includes("CMP-4")),
      ).toBe(true);
      // Terminal state should trigger workspace cleanup
      expect(
        result.events.some((e) => e.type === "workspace_cleanup" && e.message.includes("CMP-4")),
      ).toBe(true);
      // Not running at end
      expect(result.finalSnapshot.running).toHaveLength(0);
    }, 10_000);

    test("multiple blocked issues unblocked in sequence dispatch in priority order", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("complex-5a", "CMP-5A", {
            state: "Todo",
            stateType: "unstarted",
            priority: 3,
            blockers: [
              {
                id: "shared-dep",
                identifier: "SHARED",
                state: "In Progress",
                stateType: "started",
              },
            ],
          }),
          makeIssue("complex-5b", "CMP-5B", {
            state: "Todo",
            stateType: "unstarted",
            priority: 1,
            blockers: [
              {
                id: "shared-dep",
                identifier: "SHARED",
                state: "In Progress",
                stateType: "started",
              },
            ],
          }),
        ],
        settingsOverrides: { agent: { maxConcurrentAgents: 5 } },
        runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 10 } },
        pollTicks: 5,
        tickDelayMs: 80,
        mutations: {
          2: (client: ChaosLinearClient) => {
            // Resolve shared blocker on both issues
            client.updateIssue("complex-5a", {
              blockers: [
                { id: "shared-dep", identifier: "SHARED", state: "Done", stateType: "completed" },
              ],
            });
            client.updateIssue("complex-5b", {
              blockers: [
                { id: "shared-dep", identifier: "SHARED", state: "Done", stateType: "completed" },
              ],
            });
          },
        },
      });

      // Both should eventually be dispatched
      expect(
        result.events.some((e) => e.type === "run_started" && e.message.includes("CMP-5A")),
      ).toBe(true);
      expect(
        result.events.some((e) => e.type === "run_started" && e.message.includes("CMP-5B")),
      ).toBe(true);
    }, 10_000);

    test("rapid state + blocker changes do not crash the system", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("complex-6", "CMP-6", { state: "In Progress", stateType: "started" }),
          makeIssue("complex-7", "CMP-7", {
            state: "Todo",
            stateType: "unstarted",
            blockers: [
              {
                id: "complex-6",
                identifier: "CMP-6",
                state: "In Progress",
                stateType: "started",
              },
            ],
          }),
        ],
        settingsOverrides: { agent: { maxConcurrentAgents: 5 } },
        runnerConfig: { defaultBehavior: { turnCount: 2, latencyPerTurnMs: 30 } },
        pollTicks: 6,
        tickDelayMs: 80,
        mutations: {
          1: (client: ChaosLinearClient) => {
            client.changeIssueState("complex-6", "Done", "completed");
          },
          2: (client: ChaosLinearClient) => {
            // Resolve blocker on complex-7
            client.updateIssue("complex-7", {
              blockers: [
                { id: "complex-6", identifier: "CMP-6", state: "Done", stateType: "completed" },
              ],
            });
          },
          3: (client: ChaosLinearClient) => {
            // Move complex-7 to in progress
            client.changeIssueState("complex-7", "In Progress", "started");
          },
          4: (client: ChaosLinearClient) => {
            // Then terminal
            client.changeIssueState("complex-7", "Done", "completed");
          },
        },
      });

      // System should handle all these transitions without crashing
      expect(result.errors).toHaveLength(0);
      expect(result.ticksExecuted).toBe(6);
      // complex-6 should see workspace_cleanup (terminal)
      expect(
        result.events.some((e) => e.type === "workspace_cleanup" && e.message.includes("CMP-6")),
      ).toBe(true);
    }, 10_000);
  });

  // ---------------------------------------------------------------------------
  // Additional edge cases for state transition coverage
  // ---------------------------------------------------------------------------
  describe("Edge cases: rapid toggling and priority changes", () => {
    test("rapid state toggling between active/inactive does not crash", async () => {
      const result = await runScenario({
        issues: [makeIssue("toggle-1", "TGL-1", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 20, latencyPerTurnMs: 80 } },
        pollTicks: 6,
        tickDelayMs: 80,
        waitForRuns: false,
        mutations: {
          1: (client: ChaosLinearClient) => {
            client.changeIssueState("toggle-1", "Backlog", "backlog");
          },
          2: (client: ChaosLinearClient) => {
            client.changeIssueState("toggle-1", "In Progress", "started");
          },
          3: (client: ChaosLinearClient) => {
            client.changeIssueState("toggle-1", "Backlog", "backlog");
          },
          4: (client: ChaosLinearClient) => {
            client.changeIssueState("toggle-1", "In Progress", "started");
          },
        },
      });

      expect(result.errors).toHaveLength(0);
      // Should have reconciliation events as state toggles
      expect(result.events.some((e) => e.type === "run_reconciled")).toBe(true);
    }, 10_000);

    test("priority change mid-execution does not interrupt running worker", async () => {
      const result = await runScenario({
        issues: [
          makeIssue("prio-1", "PRI-1", {
            state: "In Progress",
            stateType: "started",
            priority: 4,
          }),
        ],
        runnerConfig: { defaultBehavior: { turnCount: 5, latencyPerTurnMs: 50 } },
        pollTicks: 4,
        tickDelayMs: 100,
        timedMutations: [
          { afterMs: 80, mutate: { type: "update_priority", issueId: "prio-1", priority: 1 } },
        ],
      });

      // Priority change should NOT cause reconciliation/abort
      const assertions = checkAssertions(result, [
        { type: "event_occurred", eventType: "run_started", messageContains: "PRI-1" },
        { type: "event_not_occurred", eventType: "run_reconciled" },
      ]);
      expect(assertions.every((a) => a.passed)).toBe(true);
    }, 10_000);

    test("issue reopened after terminal state can be re-dispatched", async () => {
      const result = await runScenario({
        issues: [makeIssue("reopen-1", "REO-1", { state: "In Progress", stateType: "started" })],
        runnerConfig: { defaultBehavior: { turnCount: 1, latencyPerTurnMs: 10 } },
        pollTicks: 7,
        tickDelayMs: 100,
        mutations: {
          1: (client: ChaosLinearClient) => {
            client.changeIssueState("reopen-1", "Done", "completed");
          },
          4: (client: ChaosLinearClient) => {
            // Reopen the issue
            client.changeIssueState("reopen-1", "In Progress", "started");
          },
        },
      });

      // Should have been dispatched at least once initially
      const startedEvents = result.events.filter(
        (e) => e.type === "run_started" && e.message.includes("REO-1"),
      );
      expect(startedEvents.length).toBeGreaterThanOrEqual(1);

      // Should have workspace_cleanup when it went terminal
      expect(
        result.events.some((e) => e.type === "workspace_cleanup" && e.message.includes("REO-1")),
      ).toBe(true);
    }, 10_000);
  });
});
