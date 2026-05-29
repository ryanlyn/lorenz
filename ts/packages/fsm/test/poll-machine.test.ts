import { describe, it, expect } from "vitest";

import { PollMachine } from "../src/poll-machine.js";

describe("PollMachine", () => {
  it("starts in idle state with null lastPollAt and lastError", () => {
    const pm = new PollMachine();
    expect(pm.state.kind).toBe("idle");
    if (pm.state.kind === "idle") {
      expect(pm.state.lastPollAt).toBeNull();
      expect(pm.state.lastError).toBeNull();
    }
  });

  it("transitions to polling when requestPoll is called", () => {
    const pm = new PollMachine();
    // Never-resolving executor so we stay in polling
    pm.requestPoll(() => new Promise(() => {}));
    expect(pm.state.kind).toBe("polling");
  });

  it("transitions back to idle after executor resolves", async () => {
    const pm = new PollMachine();
    const promise = pm.requestPoll(() => Promise.resolve());
    await promise;
    expect(pm.state.kind).toBe("idle");
    if (pm.state.kind === "idle") {
      expect(pm.state.lastPollAt).toBeInstanceOf(Date);
      expect(pm.state.lastError).toBeNull();
    }
  });

  it("records lastError on executor rejection", async () => {
    const pm = new PollMachine();
    const promise = pm.requestPoll(() => Promise.reject(new Error("net timeout")));
    await promise;
    expect(pm.state.kind).toBe("idle");
    if (pm.state.kind === "idle") {
      expect(pm.state.lastError).toBe("net timeout");
      expect(pm.state.lastPollAt).toBeInstanceOf(Date);
    }
  });

  it("coalesces concurrent requestPoll calls", async () => {
    const pm = new PollMachine();
    let executorCalls = 0;
    let resolveExec: () => void;
    const execPromise = new Promise<void>((r) => {
      resolveExec = r;
    });

    const p1 = pm.requestPoll(() => {
      executorCalls++;
      return execPromise;
    });

    // Second request while polling - should coalesce
    const p2 = pm.requestPoll(() => {
      executorCalls++;
      return Promise.resolve();
    });

    expect(pm.state.kind).toBe("polling");
    expect(executorCalls).toBe(1); // Only one executor call

    resolveExec!();
    await Promise.all([p1, p2]);

    expect(pm.state.kind).toBe("idle");
    expect(executorCalls).toBe(1); // Still only one
  });

  it("handles non-Error rejections gracefully", async () => {
    const pm = new PollMachine();
    const promise = pm.requestPoll(() => Promise.reject("string error"));
    await promise;
    expect(pm.state.kind).toBe("idle");
    if (pm.state.kind === "idle") {
      expect(pm.state.lastError).toBe("string error");
    }
  });
});
