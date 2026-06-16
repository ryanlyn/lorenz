import type { Mutex } from "./types.js";

/**
 * Creates a promise-chain async mutex. Each `runExclusive` call appends its body
 * to a tail promise so bodies run strictly one at a time in call order. The tail
 * advances regardless of whether a body resolves or throws, so a failing body
 * never deadlocks the next caller. The caller still observes the body's own
 * resolution/rejection.
 */
export function createMutex(): Mutex {
  // `tail` is the promise the next body must wait on. It is intentionally
  // detached from each body's success/failure so a throwing body still releases.
  let tail: Promise<void> = Promise.resolve();

  return {
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(async () => fn());
      // Advance the chain once this body settles (resolve OR reject), swallowing
      // the result so the tail never carries a rejection forward to the next body.
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
