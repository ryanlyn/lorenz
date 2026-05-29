import { transition, type SlotState, type SlotEvent } from "./slot-machine.js";

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
    // Side effect: abort the controller when leaving `running` state
    if (current.kind === "running" && next.kind !== "running") {
      current.handle.controller.abort();
    }
    this.slots.set(key, next);
    return next;
  }

  /** Iterate over all slot entries. */
  entries(): IterableIterator<[string, SlotState]> {
    return this.slots.entries();
  }

  get size(): number {
    return this.slots.size;
  }

  keys(): IterableIterator<string> {
    return this.slots.keys();
  }
}
