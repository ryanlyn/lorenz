import type { SlotRegistry } from "./slot-registry.js";

// --- Domain types for the handle ---

export interface AgentUpdate {
  [key: string]: unknown;
}

export interface RunResult {
  success: boolean;
  [key: string]: unknown;
}

// --- RunningHandle (capability-scoped to one generation) ---

export interface IRunningHandle {
  readonly runId: string;
  readonly key: string;
  readonly slotIndex: number;
  readonly issueId: string;
  readonly controller: AbortController;
  applyUpdate(update: AgentUpdate): void;
  finish(result: RunResult): boolean;
  fail(error: Error): boolean;
  get isActive(): boolean;
  get signal(): AbortSignal;
}

export class RunningHandle implements IRunningHandle {
  readonly controller: AbortController;

  constructor(
    readonly runId: string,
    readonly key: string,
    readonly slotIndex: number,
    readonly issueId: string,
    private readonly registry: SlotRegistry,
  ) {
    this.controller = new AbortController();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isActive(): boolean {
    const state = this.registry.getState(this.key);
    if (state === null) return false;
    if (!("runId" in state)) return false;
    return state.runId === this.runId;
  }

  applyUpdate(update: AgentUpdate): void {
    void update;
    if (!this.isActive) return;
    this.registry.transition(this.key, { kind: "agent_update", runId: this.runId });
  }

  finish(_result: RunResult): boolean {
    if (!this.isActive) return false;
    const next = this.registry.transition(this.key, {
      kind: "run_finished",
      runId: this.runId,
    });
    return next !== null;
  }

  fail(error: Error): boolean {
    if (!this.isActive) return false;
    const next = this.registry.transition(this.key, {
      kind: "run_failed",
      runId: this.runId,
      error: error.message,
    });
    return next !== null;
  }
}
