import { afterEach, expect, test, vi } from "vitest";

import type { OpsState } from "../src/features/ops/api/types";
import { wireOpsStream } from "../src/features/ops/hooks/useOpsStream";

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  closed = false;

  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: MessageEvent<string>) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: string): void {
    const event = { data } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.unstubAllGlobals();
});

test("wireOpsStream updates dashboard state from named state events", () => {
  const stream = new FakeEventSource();
  const setConnected = vi.fn();
  const setState = vi.fn();
  const scheduleReconnect = vi.fn();
  const payload: OpsState = {
    running: [
      {
        issue_id: "issue-1",
        issue_identifier: "MONO-314",
        agent_kind: "codex",
        worker_host: "local",
        turn_count: 3,
        tokens: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        session_id: "thread-1",
        last_event: "agent_message_chunk",
      },
    ],
    retrying: [],
    blocked: [],
    counts: { running: 1, retrying: 0, blocked: 0 },
    usage_totals: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };

  wireOpsStream(stream, { setConnected, setState, scheduleReconnect });

  stream.onopen?.();
  expect(setConnected).toHaveBeenCalledWith(true);

  stream.emit("state", JSON.stringify(payload));
  expect(setState).toHaveBeenCalledWith(payload);

  stream.onerror?.();
  expect(setConnected).toHaveBeenCalledWith(false);
  expect(stream.closed).toBe(true);
  expect(scheduleReconnect).toHaveBeenCalledOnce();
});

test("useOpsStream initial fetch failure does not emit an unhandled rejection", async () => {
  const unhandledReasons: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledReasons.push(reason);
  };
  const cleanupEffects: Array<() => void> = [];
  const stateUpdates: unknown[] = [];
  let stateHookIndex = 0;

  process.on("unhandledRejection", onUnhandledRejection);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.doMock("react", () => ({
    useCallback: (callback: () => void) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (cleanup) cleanupEffects.push(cleanup);
    },
    useRef: <T>(initial: T) => ({ current: initial }),
    useState: <T>(initial: T) => {
      const hookIndex = stateHookIndex;
      stateHookIndex += 1;
      const setter = vi.fn((value: T) => {
        if (hookIndex === 0) stateUpdates.push(value);
      });
      return [initial, setter] as const;
    },
  }));

  try {
    const { useOpsStream } = await import("../src/features/ops/hooks/useOpsStream");
    useOpsStream();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unhandledReasons).toEqual([]);
    expect(stateUpdates).toEqual([]);
  } finally {
    for (const cleanup of cleanupEffects) cleanup();
    process.off("unhandledRejection", onUnhandledRejection);
  }
});
