import type { FlagsSnapshot } from "./types.js";

// Bare module-level holder, mirroring `defaultTrackerRegistry`. Typed reads go through `bindFlags`.
let current: FlagsSnapshot | undefined;

export function getDefaultFlags(): FlagsSnapshot {
  if (current === undefined) {
    // Fail loud rather than fall back to an all-defaults snapshot: a missing install is a wiring
    // bug, and a silent default would hide the exact "why isn't my flag taking effect" class this
    // package exists to prevent.
    throw new Error(
      "Lorenz flags have not been initialized. Call setDefaultFlags(resolveFlags(...)) at the " +
        "composition root before reading flags (tests can use withFlags / setFlagsForTesting).",
    );
  }
  return current;
}

export function setDefaultFlags(snapshot: FlagsSnapshot): void {
  current = snapshot;
}

export function hasDefaultFlags(): boolean {
  return current !== undefined;
}

export function clearDefaultFlags(): void {
  current = undefined;
}
