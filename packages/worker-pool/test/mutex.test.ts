import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { createMutex } from "../src/mutex.js";

// A deferred promise we can resolve from the outside so the test controls when
// the first critical section finishes.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("runExclusive serializes two concurrent callers", async () => {
  const mutex = createMutex();
  const order: string[] = [];
  const gate = deferred<void>();

  // First caller enters and blocks inside the critical section until `gate` resolves.
  const first = mutex.runExclusive(async () => {
    order.push("first:start");
    await gate.promise;
    order.push("first:end");
    return "first";
  });

  // Second caller is dispatched while the first still holds the lock. It must
  // not enter its body until the first has fully released.
  const second = mutex.runExclusive(async () => {
    order.push("second:start");
    return "second";
  });

  // Let any microtasks flush. The second body must NOT have started yet.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);

  gate.resolve();

  const firstResult = await first;
  const secondResult = await second;

  assert.equal(firstResult, "first");
  assert.equal(secondResult, "second");
  // Strict ordering proves the second body ran only after the first released.
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
});

test("lock released after the body throws", async () => {
  const mutex = createMutex();
  const order: string[] = [];

  // The first critical section throws. The mutex must still release so the
  // next caller can acquire the lock.
  await assert.rejects(
    () =>
      mutex.runExclusive(async () => {
        order.push("first");
        throw new Error("boom");
      }),
    "boom",
  );

  const result = await mutex.runExclusive(async () => {
    order.push("second");
    return 42;
  });

  assert.equal(result, 42);
  assert.deepEqual(order, ["first", "second"]);
});

test("runExclusive returns the body's resolved value", async () => {
  const mutex = createMutex();
  const value = await mutex.runExclusive(async () => "value");
  assert.equal(value, "value");
});
