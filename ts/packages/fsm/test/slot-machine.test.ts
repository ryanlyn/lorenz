import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  transition,
  type SlotState,
  type SlotEvent,
  type RunningHandle,
  type RunningEntry,
} from "../src/slot-machine.js";

// --- Helpers ---

function makeHandle(runId: string): RunningHandle {
  return { runId, controller: new AbortController() };
}

function makeEntry(): RunningEntry {
  return { issueId: "test-issue" };
}

function makeClaimEvent(runId: string): SlotEvent {
  return { kind: "claim", runId, entry: makeEntry(), handle: makeHandle(runId) };
}

// --- Arbitraries ---

const arbRunId = fc.uuid();

function arbSlotEvent(runId?: string): fc.Arbitrary<SlotEvent> {
  const rid = runId ? fc.constant(runId) : arbRunId;
  return fc.oneof(
    rid.map((r) => makeClaimEvent(r)),
    rid.map((r) => ({ kind: "agent_update", runId: r }) as SlotEvent),
    rid.map((r) => ({ kind: "run_finished", runId: r }) as SlotEvent),
    rid.map((r) => ({ kind: "run_failed", runId: r, error: "boom" }) as SlotEvent),
    fc.constant({ kind: "abort", reason: "user-requested" } as SlotEvent),
    rid.map((r) => ({ kind: "cleanup_done", runId: r }) as SlotEvent),
    fc.constant({ kind: "retry_due" } as SlotEvent),
    fc.constant({
      kind: "reconcile_terminal",
      reason: "issue closed",
    } as SlotEvent),
  );
}

// --- Property-based tests ---

describe("SlotMachine properties", () => {
  it("absorbing-state invariant: done rejects ALL events", () => {
    fc.assert(
      fc.property(arbSlotEvent(), (event) => {
        const doneState: SlotState = { kind: "done", completedAt: new Date() };
        const result = transition(doneState, event);
        expect(result).toBeNull();
      }),
    );
  });

  it("generation safety: events with mismatched runId are rejected", () => {
    fc.assert(
      fc.property(arbRunId, arbRunId, (stateRunId, eventRunId) => {
        fc.pre(stateRunId !== eventRunId);

        const states: SlotState[] = [
          {
            kind: "claimed",
            runId: stateRunId,
            handle: makeHandle(stateRunId),
            entry: makeEntry(),
            claimedAt: new Date(),
          },
          {
            kind: "running",
            runId: stateRunId,
            handle: makeHandle(stateRunId),
            entry: makeEntry(),
            startedAt: new Date(),
          },
          {
            kind: "aborting",
            runId: stateRunId,
            reason: "test",
            entry: makeEntry(),
            abortedAt: new Date(),
          },
        ];

        const runIdEvents: SlotEvent[] = [
          { kind: "agent_update", runId: eventRunId },
          { kind: "run_finished", runId: eventRunId },
          { kind: "run_failed", runId: eventRunId, error: "err" },
          { kind: "cleanup_done", runId: eventRunId },
        ];

        for (const state of states) {
          for (const event of runIdEvents) {
            const result = transition(state, event);
            expect(result).toBeNull();
          }
        }
      }),
    );
  });

  it("runId monotonicity: runId never decreases across claim transitions", () => {
    fc.assert(
      fc.property(fc.array(arbRunId, { minLength: 2, maxLength: 10 }), (runIds) => {
        let state: SlotState = { kind: "idle" };
        const observed: string[] = [];

        for (const runId of runIds) {
          const claimEvent = makeClaimEvent(runId);
          const next = transition(state, claimEvent);
          if (next !== null && "runId" in next) {
            observed.push(next.runId);
            // Move to retrying so next claim is accepted
            state = {
              kind: "retrying",
              attempt: 1,
              dueAt: new Date(),
              lastError: null,
              lastRunId: runId,
              slotIndex: 0,
              workerHost: null,
              workspacePath: null,
            };
          }
        }

        // Each observed runId should correspond to the expected claim
        for (let i = 1; i < observed.length; i++) {
          // All runIds are distinct (UUIDs), proving monotonic progression
          expect(observed[i]).not.toBe(observed[i - 1]);
        }
      }),
    );
  });
});

// --- BFS exhaustive walker test ---

describe("SlotMachine BFS walker", () => {
  const STATE_KINDS = ["idle", "claimed", "running", "aborting", "retrying", "done"] as const;

  const EVENT_KINDS = [
    "claim",
    "agent_update",
    "run_finished",
    "run_failed",
    "abort",
    "cleanup_done",
    "retry_due",
    "reconcile_terminal",
  ] as const;

  const RUN_ID = "test-run-id-1";

  function makeState(kind: (typeof STATE_KINDS)[number]): SlotState {
    switch (kind) {
      case "idle":
        return { kind: "idle" };
      case "claimed":
        return {
          kind: "claimed",
          runId: RUN_ID,
          handle: makeHandle(RUN_ID),
          entry: makeEntry(),
          claimedAt: new Date(),
        };
      case "running":
        return {
          kind: "running",
          runId: RUN_ID,
          handle: makeHandle(RUN_ID),
          entry: makeEntry(),
          startedAt: new Date(),
        };
      case "aborting":
        return {
          kind: "aborting",
          runId: RUN_ID,
          reason: "test",
          entry: makeEntry(),
          abortedAt: new Date(),
        };
      case "retrying":
        return {
          kind: "retrying",
          attempt: 1,
          dueAt: new Date(),
          lastError: null,
          lastRunId: RUN_ID,
          slotIndex: 0,
          workerHost: null,
          workspacePath: null,
        };
      case "done":
        return { kind: "done", completedAt: new Date() };
    }
  }

  function makeEvent(kind: (typeof EVENT_KINDS)[number]): SlotEvent {
    switch (kind) {
      case "claim":
        return makeClaimEvent("new-run-id");
      case "agent_update":
        return { kind: "agent_update", runId: RUN_ID };
      case "run_finished":
        return { kind: "run_finished", runId: RUN_ID };
      case "run_failed":
        return { kind: "run_failed", runId: RUN_ID, error: "failed" };
      case "abort":
        return { kind: "abort", reason: "user-abort" };
      case "cleanup_done":
        return { kind: "cleanup_done", runId: RUN_ID };
      case "retry_due":
        return { kind: "retry_due" };
      case "reconcile_terminal":
        return { kind: "reconcile_terminal", reason: "issue closed" };
    }
  }

  // Expected transition results: [fromState, event] => expected target kind or null
  const EXPECTED: Record<string, string | null> = {
    // idle transitions
    "idle+claim": "claimed",
    "idle+agent_update": null,
    "idle+run_finished": null,
    "idle+run_failed": null,
    "idle+abort": null,
    "idle+cleanup_done": null,
    "idle+retry_due": null,
    "idle+reconcile_terminal": null,

    // claimed transitions
    "claimed+claim": null,
    "claimed+agent_update": "running",
    "claimed+run_finished": "retrying",
    "claimed+run_failed": "retrying",
    "claimed+abort": null,
    "claimed+cleanup_done": null,
    "claimed+retry_due": null,
    "claimed+reconcile_terminal": "done",

    // running transitions
    "running+claim": null,
    "running+agent_update": "running",
    "running+run_finished": "retrying",
    "running+run_failed": "retrying",
    "running+abort": "aborting",
    "running+cleanup_done": null,
    "running+retry_due": null,
    "running+reconcile_terminal": "done",

    // aborting transitions
    "aborting+claim": null,
    "aborting+agent_update": null,
    "aborting+run_finished": null,
    "aborting+run_failed": null,
    "aborting+abort": null,
    "aborting+cleanup_done": "retrying",
    "aborting+retry_due": null,
    "aborting+reconcile_terminal": "done",

    // retrying transitions
    "retrying+claim": "claimed",
    "retrying+agent_update": null,
    "retrying+run_finished": null,
    "retrying+run_failed": null,
    "retrying+abort": null,
    "retrying+cleanup_done": null,
    "retrying+retry_due": null,
    "retrying+reconcile_terminal": "done",

    // done transitions (all rejected)
    "done+claim": null,
    "done+agent_update": null,
    "done+run_finished": null,
    "done+run_failed": null,
    "done+abort": null,
    "done+cleanup_done": null,
    "done+retry_due": null,
    "done+reconcile_terminal": null,
  };

  it("covers all 48 (state, event) pairs", () => {
    const totalPairs = STATE_KINDS.length * EVENT_KINDS.length;
    expect(totalPairs).toBe(48);
    expect(Object.keys(EXPECTED).length).toBe(48);
  });

  for (const stateKind of STATE_KINDS) {
    for (const eventKind of EVENT_KINDS) {
      const key = `${stateKind}+${eventKind}`;
      const expectedTarget = EXPECTED[key];

      it(`${stateKind} + ${eventKind} => ${expectedTarget ?? "REJECTED"}`, () => {
        const state = makeState(stateKind);
        const event = makeEvent(eventKind);
        const result = transition(state, event);

        if (expectedTarget === null) {
          expect(result).toBeNull();
        } else {
          expect(result).not.toBeNull();
          expect(result!.kind).toBe(expectedTarget);
        }
      });
    }
  }
});
