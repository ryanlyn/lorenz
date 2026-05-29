import { match, P } from "ts-pattern";

// --- Simplified local types (no dependency on domain packages) ---

export interface RunningHandle {
  runId: string;
  controller: AbortController;
}

export type RunningEntry = Record<string, unknown>;

// --- SlotState discriminated union ---

export type SlotState =
  | { kind: "idle" }
  | {
      kind: "claimed";
      runId: string;
      handle: RunningHandle;
      entry: RunningEntry;
      claimedAt: Date;
    }
  | {
      kind: "running";
      runId: string;
      handle: RunningHandle;
      entry: RunningEntry;
      startedAt: Date;
    }
  | {
      kind: "aborting";
      runId: string;
      reason: string;
      entry: RunningEntry;
      abortedAt: Date;
    }
  | {
      kind: "retrying";
      attempt: number;
      dueAt: Date;
      lastError: string | null;
      lastRunId: string;
      slotIndex: number;
      workerHost: string | null;
      workspacePath: string | null;
    }
  | { kind: "done"; completedAt: Date };

// --- SlotEvent discriminated union ---

export type SlotEvent =
  | {
      kind: "claim";
      runId: string;
      entry: RunningEntry;
      handle: RunningHandle;
    }
  | { kind: "agent_update"; runId: string }
  | { kind: "run_finished"; runId: string }
  | { kind: "run_failed"; runId: string; error: string }
  | { kind: "abort"; reason: string }
  | { kind: "cleanup_done"; runId: string }
  | { kind: "retry_due" }
  | { kind: "reconcile_terminal"; reason: string };

// --- Generation-safety guard ---

function hasRunId(event: SlotEvent): event is SlotEvent & { runId: string } {
  return "runId" in event && event.kind !== "claim";
}

function runIdMatches(state: SlotState, event: SlotEvent): boolean {
  if (!hasRunId(event)) return true;
  if (!("runId" in state)) return true;
  return state.runId === event.runId;
}

// --- Pure transition function ---

export function transition(state: SlotState, event: SlotEvent): SlotState | null {
  // Terminal state rejects all events
  if (state.kind === "done") return null;

  // Generation-safety: reject events with mismatched runId
  if (!runIdMatches(state, event)) return null;

  return (
    match([state, event] as const)
      // idle + claim => claimed
      .with([{ kind: "idle" }, { kind: "claim" }], ([, ev]) => ({
        kind: "claimed" as const,
        runId: ev.runId,
        handle: ev.handle,
        entry: ev.entry,
        claimedAt: new Date(),
      }))

      // claimed + agent_update => running (first update)
      .with([{ kind: "claimed" }, { kind: "agent_update" }], ([s]) => ({
        kind: "running" as const,
        runId: s.runId,
        handle: s.handle,
        entry: s.entry,
        startedAt: new Date(),
      }))

      // claimed + run_finished => retrying (finished before first agent_update)
      .with([{ kind: "claimed" }, { kind: "run_finished" }], ([s]) => ({
        kind: "retrying" as const,
        attempt: 1,
        dueAt: new Date(),
        lastError: null,
        lastRunId: s.runId,
        slotIndex: 0,
        workerHost: null,
        workspacePath: null,
      }))

      // claimed + run_failed => retrying
      .with([{ kind: "claimed" }, { kind: "run_failed" }], ([s, ev]) => ({
        kind: "retrying" as const,
        attempt: 1,
        dueAt: new Date(),
        lastError: ev.error,
        lastRunId: s.runId,
        slotIndex: 0,
        workerHost: null,
        workspacePath: null,
      }))

      // claimed + reconcile_terminal => done
      .with([{ kind: "claimed" }, { kind: "reconcile_terminal" }], () => ({
        kind: "done" as const,
        completedAt: new Date(),
      }))

      // running + agent_update => running (self-loop)
      .with([{ kind: "running" }, { kind: "agent_update" }], ([s]) => s)

      // running + run_finished => retrying
      .with([{ kind: "running" }, { kind: "run_finished" }], ([s]) => ({
        kind: "retrying" as const,
        attempt: 1,
        dueAt: new Date(),
        lastError: null,
        lastRunId: s.runId,
        slotIndex: 0,
        workerHost: null,
        workspacePath: null,
      }))

      // running + run_failed => retrying
      .with([{ kind: "running" }, { kind: "run_failed" }], ([s, ev]) => ({
        kind: "retrying" as const,
        attempt: 1,
        dueAt: new Date(),
        lastError: ev.error,
        lastRunId: s.runId,
        slotIndex: 0,
        workerHost: null,
        workspacePath: null,
      }))

      // running + abort => aborting
      .with([{ kind: "running" }, { kind: "abort" }], ([s, ev]) => {
        s.handle.controller.abort();
        return {
          kind: "aborting" as const,
          runId: s.runId,
          reason: ev.reason,
          entry: s.entry,
          abortedAt: new Date(),
        };
      })

      // running + reconcile_terminal => done (aborts controller)
      .with([{ kind: "running" }, { kind: "reconcile_terminal" }], ([s]) => {
        s.handle.controller.abort();
        return {
          kind: "done" as const,
          completedAt: new Date(),
        };
      })

      // aborting + cleanup_done => retrying
      .with([{ kind: "aborting" }, { kind: "cleanup_done" }], ([s]) => ({
        kind: "retrying" as const,
        attempt: 1,
        dueAt: new Date(),
        lastError: s.reason,
        lastRunId: s.runId,
        slotIndex: 0,
        workerHost: null,
        workspacePath: null,
      }))

      // aborting + reconcile_terminal => done
      .with([{ kind: "aborting" }, { kind: "reconcile_terminal" }], () => ({
        kind: "done" as const,
        completedAt: new Date(),
      }))

      // retrying + claim => claimed (new runId)
      .with([{ kind: "retrying" }, { kind: "claim" }], ([, ev]) => ({
        kind: "claimed" as const,
        runId: ev.runId,
        handle: ev.handle,
        entry: ev.entry,
        claimedAt: new Date(),
      }))

      // retrying + reconcile_terminal => done
      .with([{ kind: "retrying" }, { kind: "reconcile_terminal" }], () => ({
        kind: "done" as const,
        completedAt: new Date(),
      }))

      // All other combinations are invalid
      .with(P._, () => null)
      .exhaustive()
  );
}
