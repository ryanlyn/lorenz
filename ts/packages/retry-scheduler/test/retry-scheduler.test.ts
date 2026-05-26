import { afterEach, beforeEach, test, vi } from "vitest";

import { assert } from "../../../test/assert.js";

import { RetryScheduler } from "@symphony/retry-scheduler";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("RetryScheduler fires callback after delay elapses", () => {
  const scheduler = new RetryScheduler();
  const calls: string[] = [];

  scheduler.sync(
    {
      issueId: "i1",
      identifier: "MT-1",
      attempt: 1,
      dueAt: new Date(Date.now() + 5000).toISOString(),
    },
    (retry) => calls.push(retry.issueId),
  );

  vi.advanceTimersByTime(4999);
  assert.equal(calls.length, 0);

  vi.advanceTimersByTime(1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "i1");

  scheduler.stop();
});

test("RetryScheduler cancels pending retry on explicit cancel", () => {
  const scheduler = new RetryScheduler();
  const calls: string[] = [];

  scheduler.sync(
    {
      issueId: "i2",
      identifier: "MT-2",
      attempt: 1,
      dueAt: new Date(Date.now() + 3000).toISOString(),
    },
    (retry) => calls.push(retry.issueId),
  );

  vi.advanceTimersByTime(1000);
  scheduler.clear("i2");

  vi.advanceTimersByTime(5000);
  assert.equal(calls.length, 0);

  scheduler.stop();
});

test("RetryScheduler resets timer when rescheduled before firing", () => {
  const scheduler = new RetryScheduler();
  const calls: string[] = [];

  scheduler.sync(
    {
      issueId: "i3",
      identifier: "MT-3",
      attempt: 1,
      dueAt: new Date(Date.now() + 2000).toISOString(),
    },
    (retry) => calls.push(`${retry.issueId}-a1`),
  );

  vi.advanceTimersByTime(1500);
  assert.equal(calls.length, 0);

  // Reschedule with a new delay (resets the timer)
  scheduler.sync(
    {
      issueId: "i3",
      identifier: "MT-3",
      attempt: 2,
      dueAt: new Date(Date.now() + 3000).toISOString(),
    },
    (retry) => calls.push(`${retry.issueId}-a2`),
  );

  // Original timer would have fired at 2000ms total, but it was cleared
  vi.advanceTimersByTime(1500);
  assert.equal(calls.length, 0);

  // New timer fires 3000ms from reschedule point
  vi.advanceTimersByTime(1500);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "i3-a2");

  scheduler.stop();
});

test("RetryScheduler does not fire after destroy", () => {
  const scheduler = new RetryScheduler();
  const calls: string[] = [];

  scheduler.sync(
    {
      issueId: "i4",
      identifier: "MT-4",
      attempt: 1,
      dueAt: new Date(Date.now() + 2000).toISOString(),
    },
    (retry) => calls.push(retry.issueId),
  );

  scheduler.sync(
    {
      issueId: "i5",
      identifier: "MT-5",
      attempt: 1,
      dueAt: new Date(Date.now() + 4000).toISOString(),
    },
    (retry) => calls.push(retry.issueId),
  );

  vi.advanceTimersByTime(1000);
  scheduler.stop();

  vi.advanceTimersByTime(10000);
  assert.equal(calls.length, 0);
});
