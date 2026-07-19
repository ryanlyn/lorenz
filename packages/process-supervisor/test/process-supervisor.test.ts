import { afterEach, expect, test, vi } from "vitest";

import {
  directChildTerminationAdapter,
  processGroupTerminationAdapter,
  superviseChild,
  type ChildTerminationAdapter,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("normal completion removes cancellation and timeout resources", async () => {
  vi.useFakeTimers();
  const completion = deferred<string>();
  const controller = new AbortController();
  const addListener = vi.spyOn(controller.signal, "addEventListener");
  const removeListener = vi.spyOn(controller.signal, "removeEventListener");
  const termination = fakeTermination();

  const supervised = superviseChild({
    completion: completion.promise,
    termination,
    timeout: { afterMs: 100, error: () => new Error("timeout") },
    cancellation: { signal: controller.signal, error: () => new Error("canceled") },
  });
  completion.resolve("done");

  await expect(supervised).resolves.toBe("done");
  expect(termination.terminate).not.toHaveBeenCalled();
  expect(addListener).toHaveBeenCalledOnce();
  expect(removeListener).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("completion failure removes cancellation and timeout resources", async () => {
  vi.useFakeTimers();
  const completion = deferred<never>();
  const controller = new AbortController();
  const removeListener = vi.spyOn(controller.signal, "removeEventListener");
  const termination = fakeTermination();

  const supervised = superviseChild({
    completion: completion.promise,
    termination,
    timeout: { afterMs: 100, error: () => new Error("timeout") },
    cancellation: { signal: controller.signal, error: () => new Error("canceled") },
  });
  completion.reject(new Error("child failed"));

  await expect(supervised).rejects.toThrow("child failed");
  expect(termination.terminate).not.toHaveBeenCalled();
  expect(removeListener).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("timeout sends SIGTERM and clears the fallback when the child exits early", async () => {
  vi.useFakeTimers();
  const completion = deferred<void>();
  const controller = new AbortController();
  const removeListener = vi.spyOn(controller.signal, "removeEventListener");
  const termination = fakeTermination();

  const supervised = superviseChild({
    completion: completion.promise,
    termination,
    timeout: { afterMs: 25, error: () => new Error("timeout") },
    cancellation: { signal: controller.signal, error: () => new Error("canceled") },
    forceKillAfterMs: 100,
  });
  const rejected = expect(supervised).rejects.toThrow("timeout");
  await vi.advanceTimersByTimeAsync(25);
  await rejected;

  expect(termination.terminate).toHaveBeenCalledTimes(1);
  expect(termination.terminate).toHaveBeenLastCalledWith("SIGTERM");
  expect(removeListener).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);

  completion.resolve();
  await Promise.resolve();

  expect(vi.getTimerCount()).toBe(0);
  expect(termination.terminate).toHaveBeenCalledTimes(1);
});

test("cancellation sends bounded SIGTERM and SIGKILL exactly once", async () => {
  vi.useFakeTimers();
  const completion = deferred<void>();
  const controller = new AbortController();
  const termination = fakeTermination();

  const supervised = superviseChild({
    completion: completion.promise,
    termination,
    timeout: { afterMs: 25, error: () => new Error("timeout") },
    cancellation: { signal: controller.signal, error: () => new Error("canceled") },
    forceKillAfterMs: 100,
  });
  const rejected = expect(supervised).rejects.toThrow("canceled");
  controller.abort();
  await rejected;
  controller.abort();
  await vi.advanceTimersByTimeAsync(100);

  expect(termination.terminate).toHaveBeenNthCalledWith(1, "SIGTERM");
  expect(termination.terminate).toHaveBeenNthCalledWith(2, "SIGKILL");
  expect(termination.terminate).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("already-aborted cancellation terminates a child spawned during the abort race", async () => {
  vi.useFakeTimers();
  const completion = deferred<void>();
  const controller = new AbortController();
  controller.abort();
  const removeListener = vi.spyOn(controller.signal, "removeEventListener");
  const termination = fakeTermination();

  const supervised = superviseChild({
    completion: completion.promise,
    termination,
    cancellation: { signal: controller.signal, error: () => new Error("canceled") },
    forceKillAfterMs: 100,
  });

  await expect(supervised).rejects.toThrow("canceled");
  expect(termination.terminate).toHaveBeenCalledOnce();
  expect(termination.terminate).toHaveBeenLastCalledWith("SIGTERM");
  expect(removeListener).toHaveBeenCalledOnce();

  completion.resolve();
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});

test("child completion wins a same-deadline cleanup race", async () => {
  vi.useFakeTimers();
  const completion = new Promise<string>((resolve) => {
    // eslint-disable-next-line no-restricted-syntax -- fake timers drive both same-deadline callbacks deterministically below.
    setTimeout(() => resolve("done"), 50);
  });
  const termination = fakeTermination();

  const supervised = superviseChild({
    completion,
    termination,
    timeout: { afterMs: 50, error: () => new Error("timeout") },
  });
  await vi.advanceTimersByTimeAsync(50);

  await expect(supervised).resolves.toBe("done");
  expect(termination.terminate).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("process-group adapter signals the negative leader pid", () => {
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const termination = processGroupTerminationAdapter(42);

  termination.terminate("SIGTERM");
  termination.terminate("SIGKILL");

  expect(kill).toHaveBeenNthCalledWith(1, -42, "SIGTERM");
  expect(kill).toHaveBeenNthCalledWith(2, -42, "SIGKILL");
});

test("direct-child force fallback closes inherited pipes", () => {
  const child = {
    kill: vi.fn(() => true),
    stdin: { destroy: vi.fn() },
    stdout: { destroy: vi.fn() },
    stderr: { destroy: vi.fn() },
  };
  const termination = directChildTerminationAdapter(child);

  termination.terminate("SIGTERM");
  expect(child.kill).toHaveBeenLastCalledWith("SIGTERM");
  expect(child.stdin.destroy).not.toHaveBeenCalled();
  expect(child.stdout.destroy).not.toHaveBeenCalled();
  expect(child.stderr.destroy).not.toHaveBeenCalled();

  termination.terminate("SIGKILL");
  expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
  expect(child.stdin.destroy).toHaveBeenCalledOnce();
  expect(child.stdout.destroy).toHaveBeenCalledOnce();
  expect(child.stderr.destroy).toHaveBeenCalledOnce();
});

function fakeTermination(): ChildTerminationAdapter & {
  terminate: ReturnType<typeof vi.fn<(signal: NodeJS.Signals) => void>>;
} {
  return { terminate: vi.fn<(signal: NodeJS.Signals) => void>() };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
