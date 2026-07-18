import { beforeEach, test } from "vitest";
import type { ClockPort, TimerHandle } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";

import { RETRY_SCHEDULER_SYNC_DELAY_MS, RetryScheduler } from "../src/retry-scheduler.js";

function fakeClock(): ClockPort & {
  tick: number;
  advance(ms: number): void;
  pendingTimerCount(): number;
  timersCreatedCount(): number;
  lastTimerDelayMs(): number;
} {
  let tick = 0;
  const timers: { id: number; fireAt: number; cb: () => void }[] = [];
  let nextId = 1;
  let lastDelayMs = Number.NaN;
  return {
    get tick() {
      return tick;
    },
    now: () => new Date(tick),
    monotonicMs: () => tick,
    pendingTimerCount: () => timers.length,
    timersCreatedCount: () => nextId - 1,
    lastTimerDelayMs: () => lastDelayMs,
    setTimeout(cb, delayMs) {
      const id = nextId++;
      lastDelayMs = delayMs;
      timers.push({ id, fireAt: tick + delayMs, cb });
      return { _id: id, unref() {} } as unknown as TimerHandle;
    },
    clearTimeout(handle) {
      const id = (handle as unknown as { _id: number })._id;
      const idx = timers.findIndex((t) => t.id === id);
      if (idx !== -1) timers.splice(idx, 1);
    },
    advance(ms: number) {
      tick += ms;
      const due = timers.filter((t) => t.fireAt <= tick);
      for (const t of due) {
        timers.splice(timers.indexOf(t), 1);
        t.cb();
      }
    },
  };
}

let clock: ReturnType<typeof fakeClock>;

beforeEach(() => {
  clock = fakeClock();
});

test("RetryScheduler fires callback after monotonicDeadlineMs + RETRY_SCHEDULER_SYNC_DELAY_MS", () => {
  const scheduler = new RetryScheduler(clock);
  const calls: string[] = [];

  scheduler.sync(
    {
      issueId: "i1",
      issueIdentifier: "MT-1",
      attempt: 1,
      dueAtIso: new Date(clock.tick + 5000).toISOString(),
      monotonicDeadlineMs: clock.tick + 5000,
    },
    (retry) => calls.push(retry.issueId),
  );

  clock.advance(4999);
  assert.equal(calls.length, 0);

  clock.advance(1 + RETRY_SCHEDULER_SYNC_DELAY_MS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "i1");

  scheduler.stop();
});

test("RetryScheduler cancels pending retry on explicit cancel", () => {
  const scheduler = new RetryScheduler(clock);
  const calls: string[] = [];

  scheduler.sync(
    {
      issueId: "i2",
      issueIdentifier: "MT-2",
      attempt: 1,
      dueAtIso: new Date(clock.tick + 3000).toISOString(),
      monotonicDeadlineMs: clock.tick + 3000,
    },
    (retry) => calls.push(retry.issueId),
  );

  clock.advance(1000);
  scheduler.clear("i2");

  clock.advance(5000);
  assert.equal(calls.length, 0);

  scheduler.stop();
});

test("RetryScheduler resets timer when rescheduled before firing", () => {
  const scheduler = new RetryScheduler(clock);
  const calls: string[] = [];

  scheduler.sync(
    {
      issueId: "i3",
      issueIdentifier: "MT-3",
      attempt: 1,
      dueAtIso: new Date(clock.tick + 2000).toISOString(),
      monotonicDeadlineMs: clock.tick + 2000,
    },
    (retry) => calls.push(`${retry.issueId}-a1`),
  );

  clock.advance(1500);
  assert.equal(calls.length, 0);

  // Reschedule with a new delay (resets the timer)
  scheduler.sync(
    {
      issueId: "i3",
      issueIdentifier: "MT-3",
      attempt: 2,
      dueAtIso: new Date(clock.tick + 3000).toISOString(),
      monotonicDeadlineMs: clock.tick + 3000,
    },
    (retry) => calls.push(`${retry.issueId}-a2`),
  );

  // Original timer would have fired at 2000ms total, but it was cleared
  clock.advance(1500);
  assert.equal(calls.length, 0);

  // New timer fires 3000ms from reschedule point
  clock.advance(1500 + RETRY_SCHEDULER_SYNC_DELAY_MS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "i3-a2");

  scheduler.stop();
});

test("RetryScheduler fires after RETRY_SCHEDULER_SYNC_DELAY_MS when monotonicDeadlineMs is in the past", () => {
  const scheduler = new RetryScheduler(clock);
  const calls: string[] = [];

  clock.advance(5000);

  scheduler.sync(
    {
      issueId: "i-past",
      issueIdentifier: "MT-PAST",
      attempt: 1,
      dueAtIso: new Date(0).toISOString(),
      monotonicDeadlineMs: 1000,
    },
    (retry) => calls.push(retry.issueId),
  );

  clock.advance(1 + RETRY_SCHEDULER_SYNC_DELAY_MS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "i-past");

  scheduler.stop();
});

test("RetryScheduler does not throw when sync is called with undefined retry", () => {
  const scheduler = new RetryScheduler(clock);
  const calls: string[] = [];

  scheduler.sync(undefined, (retry) => calls.push(retry.issueId));

  clock.advance(10000);
  assert.equal(calls.length, 0);

  scheduler.stop();
});

test("RetryScheduler does not fire after destroy", () => {
  const scheduler = new RetryScheduler(clock);
  const calls: string[] = [];

  scheduler.sync(
    {
      issueId: "i4",
      issueIdentifier: "MT-4",
      attempt: 1,
      dueAtIso: new Date(clock.tick + 2000).toISOString(),
      monotonicDeadlineMs: clock.tick + 2000,
    },
    (retry) => calls.push(retry.issueId),
  );

  scheduler.sync(
    {
      issueId: "i5",
      issueIdentifier: "MT-5",
      attempt: 1,
      dueAtIso: new Date(clock.tick + 4000).toISOString(),
      monotonicDeadlineMs: clock.tick + 4000,
    },
    (retry) => calls.push(retry.issueId),
  );

  clock.advance(1000);
  scheduler.stop();

  clock.advance(10000);
  assert.equal(calls.length, 0);
});

test("RetryScheduler does not re-arm when synced with an unchanged retry", () => {
  const scheduler = new RetryScheduler(clock);
  const calls: string[] = [];
  const retry = {
    issueId: "i6",
    issueIdentifier: "MT-6",
    attempt: 1,
    dueAtIso: new Date(clock.tick + 60_000).toISOString(),
    monotonicDeadlineMs: clock.tick + 60_000,
  };

  scheduler.sync(retry, (r) => calls.push(r.issueId));
  const armedOnce = clock.pendingTimerCount();
  assert.equal(armedOnce, 1);

  // Re-syncing the SAME retry every poll must be a no-op: the runtime does this
  // on every poll cycle, and re-creating a fresh unique-duration timer each
  // time leaks empty per-duration timer lists inside Node for the remaining
  // backoff window.
  clock.advance(1000);
  for (let i = 0; i < 100; i++) scheduler.sync({ ...retry }, (r) => calls.push(r.issueId));
  assert.equal(clock.pendingTimerCount(), 1);
  assert.equal(clock.timersCreatedCount(), 1);

  // The original timer still fires on schedule, exactly once.
  clock.advance(59_000 + RETRY_SCHEDULER_SYNC_DELAY_MS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "i6");

  scheduler.stop();
});

test("RetryScheduler rounds fractional deadlines up to whole-millisecond delays", () => {
  const scheduler = new RetryScheduler(clock);
  const calls: string[] = [];

  scheduler.sync(
    {
      issueId: "i7",
      issueIdentifier: "MT-7",
      attempt: 1,
      dueAtIso: new Date(clock.tick + 1000).toISOString(),
      // A fractional monotonic deadline (performance.now precision) must not
      // produce a fractional setTimeout duration: fractional durations each
      // mint their own entry in Node's per-duration timer table.
      monotonicDeadlineMs: clock.tick + 1000.4321,
    },
    (retry) => calls.push(retry.issueId),
  );

  assert.equal(clock.lastTimerDelayMs() % 1, 0);
  clock.advance(1001 + RETRY_SCHEDULER_SYNC_DELAY_MS);
  assert.equal(calls.length, 1);

  scheduler.stop();
});
