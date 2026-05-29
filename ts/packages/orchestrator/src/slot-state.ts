import type { AgentUpdate, RetryEntry, RunningEntry } from "@symphony/domain";

/**
 * Discriminated union for the lifecycle of a single issue slot.
 * Each slot transitions through these phases -- no separate boolean flags or
 * parallel data structures needed.
 */
export type SlotState =
  | { phase: "idle" }
  | { phase: "running"; entry: RunningEntry }
  | { phase: "retrying"; retry: RetryEntry }
  | { phase: "completed" };

/**
 * Events that cause slot state transitions.
 */
export type SlotEvent =
  | { type: "CLAIM"; entry: RunningEntry }
  | { type: "UPDATE"; update: AgentUpdate }
  | { type: "FINISH_NORMAL"; retryEntry: RetryEntry }
  | { type: "FINISH_ABNORMAL" }
  | { type: "CLEANUP" };

/**
 * Applies an agent update to a running entry (mutates in place for performance,
 * matching the existing orchestrator behavior).
 */
function applyUpdateToEntry(entry: RunningEntry, update: AgentUpdate, now: Date): void {
  entry.lastAgentEvent = update.type;
  entry.lastAgentMessage = update.message;
  entry.lastAgentTimestamp = update.timestamp ?? now;
  if (update.sessionId !== undefined) entry.sessionId = update.sessionId;
  if (update.resumeId !== undefined) entry.resumeId = update.resumeId;
  if (update.executorPid !== undefined) entry.executorPid = update.executorPid;
  if (update.workspacePath !== undefined) entry.workspacePath = update.workspacePath;
  if (update.type === "turn_completed") entry.turnCount += 1;
}

/**
 * Pure transition function for a single slot's lifecycle.
 * Given the current state and an event, returns the next state.
 *
 * Note: UPDATE events mutate the RunningEntry in place (for efficiency with
 * large entry objects) but still return the same state reference. This is
 * consistent with the existing orchestrator behavior.
 */
export function transitionSlot(state: SlotState, event: SlotEvent, now?: Date): SlotState {
  switch (state.phase) {
    case "idle":
      if (event.type === "CLAIM") return { phase: "running", entry: event.entry };
      if (event.type === "CLEANUP") return { phase: "completed" };
      return state; // invalid event in this state -- no-op

    case "running":
      if (event.type === "UPDATE") {
        applyUpdateToEntry(state.entry, event.update, now ?? new Date());
        return state;
      }
      if (event.type === "FINISH_NORMAL") return { phase: "retrying", retry: event.retryEntry };
      if (event.type === "FINISH_ABNORMAL") return { phase: "idle" };
      if (event.type === "CLEANUP") return { phase: "completed" };
      return state;

    case "retrying":
      if (event.type === "CLEANUP") return { phase: "completed" };
      if (event.type === "CLAIM") return { phase: "running", entry: event.entry };
      return state;

    case "completed":
      return state; // terminal, absorbs all events
  }
}

/**
 * Initial state for a fresh slot.
 */
export function initialSlotState(): SlotState {
  return { phase: "idle" };
}
