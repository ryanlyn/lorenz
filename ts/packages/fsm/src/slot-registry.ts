import { transition, type SlotState, type SlotEvent } from "./slot-machine.js";

// --- Derived state interface ---

export interface DerivedState {
  runningCount: number;
  claimedSet: Set<string>;
  retryList: Array<{ key: string; state: SlotState & { kind: "retrying" } }>;
  completedSet: Set<string>;
}

// --- SlotRegistry (Map<slotKey, SlotState>) ---

export class SlotRegistry {
  private readonly slots: Map<string, SlotState> = new Map();

  getOrCreate(key: string): SlotState {
    const existing = this.slots.get(key);
    if (existing !== undefined) return existing;
    const initial: SlotState = { kind: "idle" };
    this.slots.set(key, initial);
    return initial;
  }

  getState(key: string): SlotState | null {
    return this.slots.get(key) ?? null;
  }

  /** Directly set a slot state (used for seeding in tests). */
  setState(key: string, state: SlotState): void {
    this.slots.set(key, state);
  }

  /** Remove a slot entirely from the registry. */
  delete(key: string): boolean {
    return this.slots.delete(key);
  }

  transition(key: string, event: SlotEvent): SlotState | null {
    const current = this.slots.get(key);
    if (current === undefined) return null;
    const next = transition(current, event);
    if (next === null) return null;
    this.slots.set(key, next);
    return next;
  }

  /** Iterate over all slot entries. */
  entries(): IterableIterator<[string, SlotState]> {
    return this.slots.entries();
  }

  derivedState(): DerivedState {
    let runningCount = 0;
    const claimedSet = new Set<string>();
    const retryList: Array<{ key: string; state: SlotState & { kind: "retrying" } }> = [];
    const completedSet = new Set<string>();

    for (const [key, state] of this.slots) {
      switch (state.kind) {
        case "running":
          runningCount++;
          break;
        case "claimed":
          claimedSet.add(key);
          break;
        case "retrying":
          retryList.push({ key, state });
          break;
        case "done":
          completedSet.add(key);
          break;
      }
    }

    return { runningCount, claimedSet, retryList, completedSet };
  }

  get size(): number {
    return this.slots.size;
  }

  keys(): IterableIterator<string> {
    return this.slots.keys();
  }
}
