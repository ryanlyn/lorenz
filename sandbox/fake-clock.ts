import type { ClockPort, TimerHandle } from "@lorenz/domain";

/**
 * A controllable {@link ClockPort} for sandbox scenarios.
 *
 * The runtime, orchestrator, retry scheduler, fake runner, and harness all
 * route their timing through a single injected clock. Injecting this fake lets
 * scenarios drive retry/backoff/latency timers in *virtual* time instead of
 * sleeping on the wall clock, so timing-sensitive integration tests run
 * deterministically and near-instantly.
 *
 * This is NOT `vi.useFakeTimers()`: the global `setTimeout`/microtask queue
 * stays real, which is what lets {@link FakeClock.advance} flush the real
 * promise chains that timer callbacks kick off (dispatch, run completion,
 * re-poll) before deciding what fires next.
 */
export interface FakeClock extends ClockPort {
  /** Current virtual time in milliseconds. */
  readonly nowMs: number;
  /** True if any timer is still pending. */
  hasPending(): boolean;
  /**
   * Advance virtual time by `ms`, firing every timer that comes due within the
   * window in deadline order. Real microtasks/macrotasks are flushed after each
   * firing so cascading async work (a fired retry → re-poll → dispatch → run)
   * settles before the next timer is considered.
   */
  advance(ms: number): Promise<void>;
  /**
   * Advance virtual time to the earliest pending timer and fire it (flushing
   * async work afterwards). Returns false if no timer is pending. Used to pump
   * time forward while awaiting an in-progress poll.
   */
  fireNext(): Promise<boolean>;
}

interface FakeTimer {
  id: number;
  fireAt: number;
  cb: () => void;
}

/** Flush the real microtask + macrotask queue so promise chains settle. */
function flushRealQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function createFakeClock(startMs = 1_700_000_000_000): FakeClock {
  let current = startMs;
  let nextId = 1;
  const timers = new Map<number, FakeTimer>();

  function earliest(uptoMs: number): FakeTimer | undefined {
    let best: FakeTimer | undefined;
    for (const t of timers.values()) {
      if (t.fireAt > uptoMs) continue;
      if (!best || t.fireAt < best.fireAt || (t.fireAt === best.fireAt && t.id < best.id)) {
        best = t;
      }
    }
    return best;
  }

  async function fire(timer: FakeTimer): Promise<void> {
    current = Math.max(current, timer.fireAt);
    timers.delete(timer.id);
    timer.cb();
    await flushRealQueue();
  }

  return {
    get nowMs() {
      return current;
    },
    now: () => new Date(current),
    monotonicMs: () => current,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { id, fireAt: current + Math.max(0, delayMs), cb: callback });
      return { _id: id, unref() {} } as unknown as TimerHandle;
    },
    clearTimeout(handle) {
      const id = (handle as unknown as { _id?: number } | undefined)?._id;
      if (id != null) timers.delete(id);
    },
    hasPending() {
      return timers.size > 0;
    },
    async advance(ms) {
      const target = current + Math.max(0, ms);
      for (let guard = 0; guard < 1_000_000; guard++) {
        const due = earliest(target);
        if (!due) break;
        await fire(due);
      }
      current = Math.max(current, target);
    },
    async fireNext() {
      const due = earliest(Number.POSITIVE_INFINITY);
      if (!due) return false;
      await fire(due);
      return true;
    },
  };
}
