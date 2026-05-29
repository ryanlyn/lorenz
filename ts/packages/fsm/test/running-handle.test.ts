import { describe, it, expect } from "vitest";

import { RunningHandle } from "../src/running-handle.js";
import { SlotRegistry } from "../src/slot-registry.js";
import type { RunningHandle as SlotHandle } from "../src/slot-machine.js";

describe("RunningHandle", () => {
  function setup(runId = "run-1", key = "slot-a", slotIndex = 0, issueId = "issue-1") {
    const registry = new SlotRegistry();
    registry.getOrCreate(key);
    const handle = new RunningHandle(runId, key, slotIndex, issueId, registry);
    return { registry, handle, runId, key };
  }

  function claimSlot(registry: SlotRegistry, key: string, runId: string) {
    const slotHandle: SlotHandle = { runId, controller: new AbortController() };
    registry.transition(key, {
      kind: "claim",
      runId,
      entry: { issueId: "issue-1" },
      handle: slotHandle,
    });
  }

  it("isActive returns true when slot runId matches", () => {
    const { registry, handle, key, runId } = setup();
    claimSlot(registry, key, runId);
    expect(handle.isActive).toBe(true);
  });

  it("isActive returns false when slot is idle (no runId)", () => {
    const { handle } = setup();
    expect(handle.isActive).toBe(false);
  });

  it("isActive returns false when slot has different runId", () => {
    const { registry, handle, key } = setup();
    claimSlot(registry, key, "different-run-id");
    expect(handle.isActive).toBe(false);
  });

  it("signal returns the controller AbortSignal", () => {
    const { handle } = setup();
    expect(handle.signal).toBe(handle.controller.signal);
    expect(handle.signal.aborted).toBe(false);
  });

  it("applyUpdate transitions claimed to running", () => {
    const { registry, handle, key, runId } = setup();
    claimSlot(registry, key, runId);
    handle.applyUpdate({ progress: 50 });
    const state = registry.getState(key);
    expect(state?.kind).toBe("running");
  });

  it("applyUpdate is a no-op when handle is stale", () => {
    const { registry, handle, key } = setup();
    claimSlot(registry, key, "different-run-id");
    handle.applyUpdate({ progress: 50 });
    const state = registry.getState(key);
    // Still claimed with the different run, not transitioned
    expect(state?.kind).toBe("claimed");
  });

  it("finish returns true and transitions when active", () => {
    const { registry, handle, key, runId } = setup();
    claimSlot(registry, key, runId);
    // Move to running first
    registry.transition(key, { kind: "agent_update", runId });
    const result = handle.finish({ success: true });
    expect(result).toBe(true);
    const state = registry.getState(key);
    expect(state?.kind).toBe("retrying");
  });

  it("finish returns false when handle is stale", () => {
    const { handle } = setup();
    // Slot is idle - no matching runId
    const result = handle.finish({ success: true });
    expect(result).toBe(false);
  });

  it("fail returns true and transitions when active", () => {
    const { registry, handle, key, runId } = setup();
    claimSlot(registry, key, runId);
    const result = handle.fail(new Error("crash"));
    expect(result).toBe(true);
    const state = registry.getState(key);
    expect(state?.kind).toBe("retrying");
  });

  it("fail returns false when handle is stale", () => {
    const { handle } = setup();
    const result = handle.fail(new Error("crash"));
    expect(result).toBe(false);
  });

  it("becomes inactive after a new generation claims the slot", () => {
    const { registry, handle, key, runId } = setup();
    claimSlot(registry, key, runId);
    expect(handle.isActive).toBe(true);

    // Move to retrying
    registry.transition(key, { kind: "run_failed", runId, error: "oops" });

    // New generation claims
    const newHandle: SlotHandle = { runId: "run-2", controller: new AbortController() };
    registry.transition(key, {
      kind: "claim",
      runId: "run-2",
      entry: {},
      handle: newHandle,
    });

    expect(handle.isActive).toBe(false);
    // Further mutations are no-ops
    handle.applyUpdate({});
    expect(handle.finish({ success: true })).toBe(false);
  });
});
