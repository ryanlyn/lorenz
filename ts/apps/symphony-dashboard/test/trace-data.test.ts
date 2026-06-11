import { afterEach, describe, expect, test, vi } from "vitest";

import type { DisplayEvent } from "../src/features/traceviz/api/types";
import type { WsMessage } from "../src/shared/hooks/useWebSocket";

type WsStatus = "connecting" | "connected" | "disconnected";
type StateSetter<T> = (value: T | ((current: T) => T)) => void;
type EffectCleanup = () => void;
type EffectCallback = () => void | EffectCleanup;

let activeRenderer: HookRenderer<unknown> | null = null;

afterEach(() => {
  activeRenderer?.cleanup();
  activeRenderer = null;
  vi.doUnmock("react");
  vi.doUnmock("../src/shared/hooks/useWebSocket");
  vi.doUnmock("../src/features/traceviz/api/client");
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("reconcileEventAppend", () => {
  test("replaces the local event suffix from the server cursor", async () => {
    const { reconcileEventAppend } = await setupTraceDataTest();
    const first = eventFixture("first");
    const second = eventFixture("second");
    const updatedSecond = eventFixture("updated second");
    const third = eventFixture("third");

    expect(reconcileEventAppend([first, second], [third], 2)).toEqual({
      events: [first, second, third],
      needsRefresh: false,
    });
    expect(reconcileEventAppend([first, second], [updatedSecond, third], 1)).toEqual({
      events: [first, updatedSecond, third],
      needsRefresh: false,
    });
    expect(reconcileEventAppend([first, second], [], 1)).toEqual({
      events: [first],
      needsRefresh: false,
    });
    expect(reconcileEventAppend([first, second], [third], 3)).toEqual({
      events: [first, second],
      needsRefresh: true,
    });
  });
});

describe("useTraceData", () => {
  test("sends subscribe only after the socket connects and re-subscribes after reconnect", async () => {
    const { renderer, ws, fetchEvents } = await setupTraceDataTest({ status: "connecting" });
    fetchEvents.mockResolvedValue([eventFixture("initial")]);

    let traceData = renderer.render();
    traceData.setSelectedTicketId("issue-1");
    renderer.render();

    expect(ws.sendMessage).not.toHaveBeenCalled();

    ws.status = "connected";
    traceData = renderer.render();

    expect(traceData.selectedTicketId).toBe("issue-1");
    expect(ws.sendMessage).toHaveBeenCalledOnce();
    expect(ws.sendMessage).toHaveBeenLastCalledWith({ type: "subscribe", issueId: "issue-1" });

    ws.status = "disconnected";
    renderer.render();
    ws.status = "connected";
    renderer.render();

    expect(ws.sendMessage).toHaveBeenCalledTimes(2);
    expect(ws.sendMessage).toHaveBeenLastCalledWith({ type: "subscribe", issueId: "issue-1" });
  });

  test("does not let an older REST snapshot overwrite newer WebSocket events", async () => {
    const first = eventFixture("first");
    const second = eventFixture("second");
    const staleRest = deferred<DisplayEvent[]>();
    const { renderer, ws, fetchEvents } = await setupTraceDataTest({ status: "connected" });
    fetchEvents.mockReturnValueOnce(staleRest.promise);

    let traceData = renderer.render();
    traceData.setSelectedTicketId("issue-1");
    renderer.render();

    ws.lastMessage = { type: "events", issueId: "issue-1", events: [first, second] };
    renderer.render();
    traceData = renderer.render();

    expect(traceData.events).toEqual([first, second]);

    staleRest.resolve([first]);
    await flushAsync();
    traceData = renderer.render();

    expect(traceData.events).toEqual([first, second]);
  });

  test("refreshes when a full WebSocket response is behind local events", async () => {
    const first = eventFixture("first");
    const second = eventFixture("second");
    const third = eventFixture("third");
    const { renderer, ws, fetchEvents } = await setupTraceDataTest({ status: "connected" });
    fetchEvents
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([first, second, third]);

    let traceData = renderer.render();
    traceData.setSelectedTicketId("issue-1");
    renderer.render();
    await flushAsync();
    traceData = renderer.render();

    expect(traceData.events).toEqual([first, second]);

    ws.lastMessage = { type: "events", issueId: "issue-1", events: [first] };
    renderer.render();
    await flushAsync();
    traceData = renderer.render();

    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(traceData.events).toEqual([first, second, third]);
  });

  test("applies suffix replacements from WebSocket deltas", async () => {
    const first = eventFixture("first");
    const updatedFirst = eventFixture("updated first");
    const third = eventFixture("third");
    const { renderer, ws, fetchEvents } = await setupTraceDataTest({ status: "connected" });
    fetchEvents.mockResolvedValueOnce([first]);

    let traceData = renderer.render();
    traceData.setSelectedTicketId("issue-1");
    renderer.render();
    await flushAsync();
    traceData = renderer.render();

    expect(traceData.events).toEqual([first]);

    ws.lastMessage = {
      type: "events_append",
      issueId: "issue-1",
      events: [updatedFirst, third],
      fromIndex: 0,
    };
    renderer.render();
    traceData = renderer.render();

    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(traceData.events).toEqual([updatedFirst, third]);
  });

  test("refreshes from REST when a delta cursor is beyond local events", async () => {
    const first = eventFixture("first");
    const second = eventFixture("second");
    const third = eventFixture("third");
    const { renderer, ws, fetchEvents } = await setupTraceDataTest({ status: "connected" });
    fetchEvents.mockResolvedValueOnce([first]).mockResolvedValueOnce([first, second, third]);

    let traceData = renderer.render();
    traceData.setSelectedTicketId("issue-1");
    renderer.render();
    await flushAsync();
    traceData = renderer.render();

    expect(traceData.events).toEqual([first]);

    ws.lastMessage = { type: "events_append", issueId: "issue-1", events: [third], fromIndex: 2 };
    renderer.render();
    await flushAsync();
    traceData = renderer.render();

    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(traceData.events).toEqual([first, second, third]);
  });

  test("defers append handling while browsing and catches up when follow mode resumes", async () => {
    const first = eventFixture("first");
    const second = eventFixture("second");
    const { renderer, ws, windowMock, fetchEvents } = await setupTraceDataTest({
      status: "connected",
    });
    fetchEvents.mockResolvedValueOnce([first]).mockResolvedValueOnce([first, second]);

    let traceData = renderer.render();
    traceData.setSelectedTicketId("issue-1");
    renderer.render();
    await flushAsync();
    traceData = renderer.render();

    expect(traceData.events).toEqual([first]);

    windowMock.scrollY = 100;
    windowMock.dispatchScroll();
    traceData = renderer.render();

    expect(traceData.following).toBe(false);

    ws.lastMessage = { type: "events_append", issueId: "issue-1", events: [second], fromIndex: 1 };
    renderer.render();
    traceData = renderer.render();

    expect(traceData.events).toEqual([first]);
    expect(traceData.hasNewUpdates).toBe(true);

    windowMock.scrollY = 0;
    windowMock.dispatchScroll();
    renderer.render();
    await flushAsync();
    traceData = renderer.render();

    expect(traceData.following).toBe(true);
    expect(traceData.hasNewUpdates).toBe(false);
    expect(traceData.events).toEqual([first, second]);
  });

  test("keeps an empty WebSocket events response in the missing trace state", async () => {
    const { renderer, ws, fetchEvents } = await setupTraceDataTest({ status: "connected" });
    fetchEvents.mockResolvedValueOnce([]);

    let traceData = renderer.render();
    traceData.setSelectedTicketId("issue-1");
    renderer.render();
    await flushAsync();
    traceData = renderer.render();

    expect(traceData.traceExists).toBe(false);

    ws.lastMessage = { type: "events", issueId: "issue-1", events: [] };
    renderer.render();
    traceData = renderer.render();

    expect(traceData.events).toEqual([]);
    expect(traceData.traceExists).toBe(false);
  });
});

async function setupTraceDataTest(initialWs?: {
  status?: WsStatus;
  lastMessage?: WsMessage | null;
}) {
  vi.resetModules();

  const ws = {
    status: initialWs?.status ?? "disconnected",
    lastMessage: initialWs?.lastMessage ?? null,
    sendMessage: vi.fn(),
  };
  const fetchTickets = vi.fn().mockResolvedValue([]);
  const fetchEvents = vi.fn().mockResolvedValue([]);
  const windowMock = createWindowMock();

  vi.stubGlobal("window", windowMock);
  vi.doMock("react", () => ({
    useCallback: <T>(callback: T, deps?: readonly unknown[]) =>
      currentRenderer().useCallback(callback, deps),
    useEffect: (effect: EffectCallback, deps?: readonly unknown[]) =>
      currentRenderer().useEffect(effect, deps),
    useRef: <T>(initial: T) => currentRenderer().useRef(initial),
    useState: <T>(initial: T) => currentRenderer().useState(initial),
  }));
  vi.doMock("../src/shared/hooks/useWebSocket", () => ({
    useWebSocket: () => ws,
  }));
  vi.doMock("../src/features/traceviz/api/client", () => ({
    fetchTickets,
    fetchEvents,
  }));

  const { reconcileEventAppend, useTraceData } =
    await import("../src/features/traceviz/hooks/useTraceData");
  const renderer = new HookRenderer(() => useTraceData());
  activeRenderer = renderer;

  return { renderer, ws, fetchTickets, fetchEvents, windowMock, reconcileEventAppend };
}

class HookRenderer<TReturn> {
  private hookIndex = 0;
  private states: unknown[] = [];
  private refs: Array<{ current: unknown } | undefined> = [];
  private callbacks: Array<{ value: unknown; deps: readonly unknown[] | undefined } | undefined> =
    [];
  private effects: Array<
    | { callback: EffectCallback; deps: readonly unknown[] | undefined; cleanup?: EffectCleanup }
    | undefined
  > = [];
  private pendingEffectIndexes = new Set<number>();

  constructor(private readonly hook: () => TReturn) {}

  render(): TReturn {
    this.hookIndex = 0;
    const result = this.hook();
    this.flushEffects();
    return result;
  }

  cleanup(): void {
    for (const effect of this.effects) {
      effect?.cleanup?.();
    }
    this.effects = [];
    this.pendingEffectIndexes.clear();
  }

  useState<T>(initial: T): readonly [T, StateSetter<T>] {
    const index = this.hookIndex++;
    if (!(index in this.states)) this.states[index] = initial;

    const setState: StateSetter<T> = (value) => {
      const current = this.states[index] as T;
      this.states[index] =
        typeof value === "function" ? (value as (current: T) => T)(current) : value;
    };

    return [this.states[index] as T, setState] as const;
  }

  useRef<T>(initial: T): { current: T } {
    const index = this.hookIndex++;
    if (!this.refs[index]) this.refs[index] = { current: initial };
    return this.refs[index] as { current: T };
  }

  useCallback<T>(callback: T, deps?: readonly unknown[]): T {
    const index = this.hookIndex++;
    const previous = this.callbacks[index];
    if (previous && !depsChanged(previous.deps, deps)) return previous.value as T;
    this.callbacks[index] = { value: callback, deps };
    return callback;
  }

  useEffect(callback: EffectCallback, deps?: readonly unknown[]): void {
    const index = this.hookIndex++;
    const previous = this.effects[index];
    if (previous && !depsChanged(previous.deps, deps)) return;
    this.effects[index] = { callback, deps, cleanup: previous?.cleanup };
    this.pendingEffectIndexes.add(index);
  }

  private flushEffects(): void {
    const indexes = Array.from(this.pendingEffectIndexes);
    this.pendingEffectIndexes.clear();

    for (const index of indexes) {
      const effect = this.effects[index];
      if (!effect) continue;

      effect.cleanup?.();
      const cleanup = effect.callback();
      if (cleanup) effect.cleanup = cleanup;
      else delete effect.cleanup;
    }
  }
}

function currentRenderer(): HookRenderer<unknown> {
  if (!activeRenderer) throw new Error("React hook called outside test renderer");
  return activeRenderer;
}

function createWindowMock(): {
  scrollY: number;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  scrollTo: ReturnType<typeof vi.fn>;
  dispatchScroll(): void;
} {
  const listeners = new Set<() => void>();
  return {
    scrollY: 0,
    addEventListener: vi.fn((event: string, listener: unknown) => {
      if (event === "scroll" && typeof listener === "function") {
        listeners.add(listener as () => void);
      }
    }),
    removeEventListener: vi.fn((event: string, listener: unknown) => {
      if (event === "scroll" && typeof listener === "function") {
        listeners.delete(listener as () => void);
      }
    }),
    scrollTo: vi.fn(),
    dispatchScroll() {
      for (const listener of listeners) listener();
    },
  };
}

function eventFixture(text: string): DisplayEvent {
  return {
    kind: "message",
    text,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function depsChanged(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (!previous || !next) return true;
  if (previous.length !== next.length) return true;
  return next.some((value, index) => !Object.is(value, previous[index]));
}
