import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { SlotRegistry } from "../src/slot-registry.js";
import type { RunningHandle, SlotEvent } from "../src/slot-machine.js";

// --- Helpers ---

function makeHandle(runId: string): RunningHandle {
  return { runId, controller: new AbortController() };
}

function makeClaimEvent(runId: string): SlotEvent {
  return { kind: "claim", runId, entry: { issueId: "test" }, handle: makeHandle(runId) };
}

describe("SlotRegistry", () => {
  it("getOrCreate creates idle slot on first access", () => {
    const reg = new SlotRegistry();
    const state = reg.getOrCreate("slot-1");
    expect(state.kind).toBe("idle");
    expect(reg.size).toBe(1);
  });

  it("getOrCreate returns existing slot on subsequent access", () => {
    const reg = new SlotRegistry();
    reg.getOrCreate("slot-1");
    reg.transition("slot-1", makeClaimEvent("run-1"));
    const state = reg.getOrCreate("slot-1");
    expect(state.kind).toBe("claimed");
  });

  it("getState returns null for unknown key", () => {
    const reg = new SlotRegistry();
    expect(reg.getState("nonexistent")).toBeNull();
  });

  it("transition returns null for unknown key", () => {
    const reg = new SlotRegistry();
    expect(reg.transition("nonexistent", makeClaimEvent("r"))).toBeNull();
  });

  it("transition updates state on valid event", () => {
    const reg = new SlotRegistry();
    reg.getOrCreate("slot-1");
    const next = reg.transition("slot-1", makeClaimEvent("run-1"));
    expect(next?.kind).toBe("claimed");
    expect(reg.getState("slot-1")?.kind).toBe("claimed");
  });

  it("transition returns null on invalid event (does not mutate)", () => {
    const reg = new SlotRegistry();
    reg.getOrCreate("slot-1");
    // idle + abort is invalid
    const result = reg.transition("slot-1", { kind: "abort", reason: "test" });
    expect(result).toBeNull();
    expect(reg.getState("slot-1")?.kind).toBe("idle");
  });

  describe("derivedState", () => {
    it("empty registry returns zero counts", () => {
      const reg = new SlotRegistry();
      const ds = reg.derivedState();
      expect(ds.runningCount).toBe(0);
      expect(ds.claimedSet.size).toBe(0);
      expect(ds.retryList.length).toBe(0);
      expect(ds.completedSet.size).toBe(0);
    });

    it("correctly categorizes mixed slot states", () => {
      const reg = new SlotRegistry();

      // slot-a: running
      reg.getOrCreate("slot-a");
      reg.transition("slot-a", makeClaimEvent("run-a"));
      reg.transition("slot-a", { kind: "agent_update", runId: "run-a" });

      // slot-b: claimed
      reg.getOrCreate("slot-b");
      reg.transition("slot-b", makeClaimEvent("run-b"));

      // slot-c: retrying
      reg.getOrCreate("slot-c");
      reg.transition("slot-c", makeClaimEvent("run-c"));
      reg.transition("slot-c", { kind: "run_failed", runId: "run-c", error: "err" });

      // slot-d: done
      reg.getOrCreate("slot-d");
      reg.transition("slot-d", makeClaimEvent("run-d"));
      reg.transition("slot-d", { kind: "reconcile_terminal", reason: "closed" });

      // slot-e: idle
      reg.getOrCreate("slot-e");

      const ds = reg.derivedState();
      expect(ds.runningCount).toBe(1);
      expect(ds.claimedSet).toEqual(new Set(["slot-b"]));
      expect(ds.retryList).toHaveLength(1);
      expect(ds.retryList[0]!.key).toBe("slot-c");
      expect(ds.completedSet).toEqual(new Set(["slot-d"]));
    });
  });

  describe("keys()", () => {
    it("returns all registered keys", () => {
      const reg = new SlotRegistry();
      reg.getOrCreate("a");
      reg.getOrCreate("b");
      reg.getOrCreate("c");
      expect([...reg.keys()].sort()).toEqual(["a", "b", "c"]);
    });
  });

  describe("property-based: derivedState is consistent with slot states", () => {
    it("sum of categories equals total slots", () => {
      fc.assert(
        fc.property(
          fc.array(fc.uuid(), { minLength: 1, maxLength: 20 }),
          fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
          (keys, shouldClaim) => {
            const uniqueKeys = [...new Set(keys)];
            const reg = new SlotRegistry();

            for (let i = 0; i < uniqueKeys.length; i++) {
              const key = uniqueKeys[i]!;
              reg.getOrCreate(key);
              if (shouldClaim[i % shouldClaim.length]) {
                const runId = `run-${i}`;
                reg.transition(key, makeClaimEvent(runId));
              }
            }

            const ds = reg.derivedState();
            const idleCount =
              reg.size -
              ds.runningCount -
              ds.claimedSet.size -
              ds.retryList.length -
              ds.completedSet.size;
            expect(idleCount).toBeGreaterThanOrEqual(0);
            expect(
              ds.runningCount +
                ds.claimedSet.size +
                ds.retryList.length +
                ds.completedSet.size +
                idleCount,
            ).toBe(reg.size);
          },
        ),
      );
    });
  });
});
