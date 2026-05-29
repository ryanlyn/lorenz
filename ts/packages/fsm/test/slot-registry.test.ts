import { describe, it, expect } from "vitest";

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

  describe("keys()", () => {
    it("returns all registered keys", () => {
      const reg = new SlotRegistry();
      reg.getOrCreate("a");
      reg.getOrCreate("b");
      reg.getOrCreate("c");
      expect([...reg.keys()].sort()).toEqual(["a", "b", "c"]);
    });
  });
});
