// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi, type Mock } from "vitest";

import type { DisplayEvent } from "../src/features/traceviz/api/types";
import type { WsMessage } from "../src/shared/hooks/useWebSocket";
import { reconcileEventAppend, useTraceData } from "../src/features/traceviz/hooks/useTraceData";

type WsStatus = "connecting" | "connected" | "disconnected";

interface SentWsMessage {
  type: string;
  issueId: string;
}

/**
 * Reactive stand-in for the real useWebSocket hook. Status and message
 * changes notify subscribed components through useSyncExternalStore, so the
 * hook under test re-renders exactly like it would against the real socket.
 */
const wsControl = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    version: 0,
    status: "disconnected" as "connecting" | "connected" | "disconnected",
    lastMessage: null as unknown,
    sendMessage: undefined as unknown,
  };
  const notify = () => {
    state.version += 1;
    for (const listener of [...listeners]) listener();
  };
  return {
    listeners,
    state,
    setStatus(status: typeof state.status) {
      state.status = status;
      notify();
    },
    emit(message: unknown) {
      state.lastMessage = message;
      notify();
    },
  };
});

const apiControl = vi.hoisted(() => ({
  fetchTickets: (() => Promise.resolve([])) as () => Promise<unknown[]>,
  fetchEvents: ((_issueId: string) => Promise.resolve([])) as (
    issueId: string,
  ) => Promise<unknown[]>,
}));

vi.mock("../src/shared/hooks/useWebSocket", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useWebSocket: () => {
      useSyncExternalStore(
        (onStoreChange: () => void) => {
          wsControl.listeners.add(onStoreChange);
          return () => wsControl.listeners.delete(onStoreChange);
        },
        () => wsControl.state.version,
      );
      return {
        status: wsControl.state.status,
        lastMessage: wsControl.state.lastMessage,
        sendMessage: wsControl.state.sendMessage,
      };
    },
  };
});

vi.mock("../src/features/traceviz/api/client", () => ({
  fetchTickets: () => apiControl.fetchTickets(),
  fetchEvents: (issueId: string) => apiControl.fetchEvents(issueId),
}));

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 0 });
});

describe("reconcileEventAppend", () => {
  test("replaces the local event suffix from the server cursor", () => {
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
    const { sendMessage, fetchEvents } = setupTraceDataTest({ status: "connecting" });
    fetchEvents.mockResolvedValue([eventFixture("initial")]);

    const { result } = renderHook(() => useTraceData());
    act(() => {
      result.current.setSelectedTicketId("issue-1");
    });
    await act(flushAsync);

    expect(sentMessages(sendMessage, "subscribe")).toHaveLength(0);

    act(() => {
      wsControl.setStatus("connected");
    });

    expect(result.current.selectedTicketId).toBe("issue-1");
    expect(sentMessages(sendMessage, "subscribe")).toEqual([
      { type: "subscribe", issueId: "issue-1" },
    ]);

    act(() => {
      wsControl.setStatus("disconnected");
    });
    act(() => {
      wsControl.setStatus("connected");
    });

    expect(sentMessages(sendMessage, "subscribe")).toEqual([
      { type: "subscribe", issueId: "issue-1" },
      { type: "subscribe", issueId: "issue-1" },
    ]);
  });

  test("does not let an older REST snapshot overwrite newer WebSocket events", async () => {
    const first = eventFixture("first");
    const second = eventFixture("second");
    const { fetchEvents } = setupTraceDataTest({ status: "connecting" });
    const staleRest = deferred<DisplayEvent[]>();
    fetchEvents.mockReturnValueOnce(staleRest.promise);

    const { result } = renderHook(() => useTraceData());
    act(() => {
      result.current.setSelectedTicketId("issue-1");
    });

    // Disconnected selection falls back to REST...
    expect(fetchEvents).toHaveBeenCalledTimes(1);

    // ...but the socket recovers first and delivers the subscribe snapshot.
    act(() => {
      wsControl.setStatus("connected");
    });
    act(() => {
      wsControl.emit({
        type: "events",
        issueId: "issue-1",
        events: [first, second],
      } satisfies WsMessage);
    });

    expect(result.current.events).toEqual([first, second]);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      staleRest.resolve([first]);
      await flushAsync();
    });

    expect(result.current.events).toEqual([first, second]);
  });

  test("ignores a full snapshot behind local events until a delta reconciles", async () => {
    const first = eventFixture("first");
    const second = eventFixture("second");
    const third = eventFixture("third");
    const updatedSecond = eventFixture("updated second");
    const { fetchEvents } = setupTraceDataTest({ status: "connected" });

    const { result } = renderHook(() => useTraceData());
    act(() => {
      result.current.setSelectedTicketId("issue-1");
    });
    act(() => {
      wsControl.emit({
        type: "events",
        issueId: "issue-1",
        events: [first, second, third],
      } satisfies WsMessage);
    });
    await act(flushAsync);

    expect(result.current.events).toEqual([first, second, third]);

    // A snapshot behind local events (trace shrank or a REST fallback raced
    // ahead) is not applied as a visible regression.
    act(() => {
      wsControl.emit({ type: "events", issueId: "issue-1", events: [first] } satisfies WsMessage);
    });

    expect(result.current.events).toEqual([first, second, third]);

    // The next delta carries the server's authoritative suffix.
    act(() => {
      wsControl.emit({
        type: "events_append",
        issueId: "issue-1",
        events: [updatedSecond],
        fromIndex: 1,
      } satisfies WsMessage);
    });

    expect(result.current.events).toEqual([first, updatedSecond]);
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  test("applies suffix replacements from WebSocket deltas", async () => {
    const first = eventFixture("first");
    const updatedFirst = eventFixture("updated first");
    const third = eventFixture("third");
    const { fetchEvents } = setupTraceDataTest({ status: "connected" });

    const { result } = renderHook(() => useTraceData());
    act(() => {
      result.current.setSelectedTicketId("issue-1");
    });
    act(() => {
      wsControl.emit({ type: "events", issueId: "issue-1", events: [first] } satisfies WsMessage);
    });
    await act(flushAsync);

    expect(result.current.events).toEqual([first]);

    act(() => {
      wsControl.emit({
        type: "events_append",
        issueId: "issue-1",
        events: [updatedFirst, third],
        fromIndex: 0,
      } satisfies WsMessage);
    });

    expect(result.current.events).toEqual([updatedFirst, third]);
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  test("re-subscribes when a delta cursor is beyond local events", async () => {
    const first = eventFixture("first");
    const second = eventFixture("second");
    const third = eventFixture("third");
    const { sendMessage, fetchEvents } = setupTraceDataTest({ status: "connected" });

    const { result } = renderHook(() => useTraceData());
    act(() => {
      result.current.setSelectedTicketId("issue-1");
    });
    act(() => {
      wsControl.emit({ type: "events", issueId: "issue-1", events: [first] } satisfies WsMessage);
    });
    await act(flushAsync);

    expect(sentMessages(sendMessage, "subscribe")).toHaveLength(1);

    act(() => {
      wsControl.emit({
        type: "events_append",
        issueId: "issue-1",
        events: [third],
        fromIndex: 2,
      } satisfies WsMessage);
    });

    // The cursor does not fit local events: the hook requests a fresh
    // snapshot on the socket instead of racing a REST request against the
    // delta stream.
    expect(sentMessages(sendMessage, "subscribe")).toHaveLength(2);
    expect(result.current.events).toEqual([first]);

    act(() => {
      wsControl.emit({
        type: "events",
        issueId: "issue-1",
        events: [first, second, third],
      } satisfies WsMessage);
    });

    expect(result.current.events).toEqual([first, second, third]);
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  test("defers append handling while browsing and catches up when follow mode resumes", async () => {
    const first = eventFixture("first");
    const second = eventFixture("second");
    const { sendMessage, fetchEvents } = setupTraceDataTest({ status: "connected" });

    const { result } = renderHook(() => useTraceData());
    act(() => {
      result.current.setSelectedTicketId("issue-1");
    });
    act(() => {
      wsControl.emit({ type: "events", issueId: "issue-1", events: [first] } satisfies WsMessage);
    });
    await act(flushAsync);

    expect(result.current.events).toEqual([first]);

    act(() => {
      setWindowScrollY(100);
    });

    act(() => {
      wsControl.emit({
        type: "events_append",
        issueId: "issue-1",
        events: [second],
        fromIndex: 1,
      } satisfies WsMessage);
    });

    expect(result.current.events).toEqual([first]);
    expect(result.current.hasNewUpdates).toBe(true);

    // Scrolling back to top requests a fresh snapshot on the socket...
    act(() => {
      setWindowScrollY(0);
    });

    expect(result.current.hasNewUpdates).toBe(false);
    expect(sentMessages(sendMessage, "subscribe")).toHaveLength(2);

    // ...and the server's answer brings the trace current.
    act(() => {
      wsControl.emit({
        type: "events",
        issueId: "issue-1",
        events: [first, second],
      } satisfies WsMessage);
    });

    expect(result.current.events).toEqual([first, second]);
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  test("unsubscribes when the selection changes or the hook unmounts", async () => {
    const first = eventFixture("first");
    const { sendMessage } = setupTraceDataTest({ status: "connected" });

    const { result, unmount } = renderHook(() => useTraceData());
    act(() => {
      result.current.setSelectedTicketId("issue-1");
    });
    act(() => {
      wsControl.emit({ type: "events", issueId: "issue-1", events: [first] } satisfies WsMessage);
    });
    await act(flushAsync);

    expect(sentMessages(sendMessage, "subscribe")).toEqual([
      { type: "subscribe", issueId: "issue-1" },
    ]);

    act(() => {
      result.current.setSelectedTicketId(null);
    });

    expect(sentMessages(sendMessage, "unsubscribe")).toEqual([
      { type: "unsubscribe", issueId: "issue-1" },
    ]);
    expect(result.current.events).toEqual([]);

    act(() => {
      result.current.setSelectedTicketId("issue-2");
    });

    expect(sentMessages(sendMessage, "subscribe")).toEqual([
      { type: "subscribe", issueId: "issue-1" },
      { type: "subscribe", issueId: "issue-2" },
    ]);

    unmount();

    expect(sentMessages(sendMessage, "unsubscribe")).toEqual([
      { type: "unsubscribe", issueId: "issue-1" },
      { type: "unsubscribe", issueId: "issue-2" },
    ]);
  });

  test("does not flag new updates for an identical snapshot after a reconnect while browsing", async () => {
    const first = eventFixture("first");
    const second = eventFixture("second");
    const third = eventFixture("third");
    const { sendMessage } = setupTraceDataTest({ status: "connected" });

    const { result } = renderHook(() => useTraceData());
    act(() => {
      result.current.setSelectedTicketId("issue-1");
    });
    act(() => {
      wsControl.emit({
        type: "events",
        issueId: "issue-1",
        events: [first, second],
      } satisfies WsMessage);
    });
    await act(flushAsync);

    act(() => {
      setWindowScrollY(100);
    });

    // Reconnect: the subscribe effect re-subscribes and the server answers
    // with a snapshot identical to what the client already shows.
    act(() => {
      wsControl.setStatus("disconnected");
    });
    act(() => {
      wsControl.setStatus("connected");
    });

    expect(sentMessages(sendMessage, "subscribe")).toHaveLength(2);

    act(() => {
      wsControl.emit({
        type: "events",
        issueId: "issue-1",
        events: [eventFixture("first"), eventFixture("second")],
      } satisfies WsMessage);
    });

    expect(result.current.hasNewUpdates).toBe(false);

    // A snapshot that actually differs keeps deferring and shows the pill.
    act(() => {
      wsControl.emit({
        type: "events",
        issueId: "issue-1",
        events: [first, second, third],
      } satisfies WsMessage);
    });

    expect(result.current.events).toEqual([first, second]);
    expect(result.current.hasNewUpdates).toBe(true);
  });

  test("recovers a mutated event skipped while browsing even when a delta races the catch-up", async () => {
    const a = eventFixture("a");
    const b = eventFixture("b");
    const bUpdated = eventFixture("b updated");
    const c = eventFixture("c");
    const cUpdated = eventFixture("c updated");
    const { sendMessage, fetchEvents } = setupTraceDataTest({ status: "connected" });
    fetchEvents.mockResolvedValueOnce([a, b, c]);

    const { result } = renderHook(() => useTraceData());
    act(() => {
      result.current.setSelectedTicketId("issue-1");
    });
    // The server answers the initial subscribe with the same snapshot a REST
    // load would return.
    act(() => {
      wsControl.emit({ type: "events", issueId: "issue-1", events: [a, b, c] } satisfies WsMessage);
    });
    await waitFor(() => expect(result.current.events).toEqual([a, b, c]));
    const initialSubscribes = sentMessages(sendMessage, "subscribe").length;

    // Browse away. The server-side trace mutates in place to [a, bUpdated, c]
    // and the delta is deferred client-side.
    act(() => {
      setWindowScrollY(100);
    });
    act(() => {
      wsControl.emit({
        type: "events_append",
        issueId: "issue-1",
        events: [bUpdated, c],
        fromIndex: 1,
      } satisfies WsMessage);
    });

    expect(result.current.events).toEqual([a, b, c]);
    expect(result.current.hasNewUpdates).toBe(true);

    // Any catch-up REST read is slow: it stays in flight while more deltas stream in.
    const catchUpRest = deferred<DisplayEvent[]>();
    fetchEvents.mockReturnValueOnce(catchUpRest.promise);

    act(() => {
      setWindowScrollY(0);
    });

    // Before the catch-up lands, the trailing event mutates again. The server
    // diffs against what it already sent, so the cursor sits past the
    // mutation the client never applied.
    act(() => {
      wsControl.emit({
        type: "events_append",
        issueId: "issue-1",
        events: [cUpdated],
        fromIndex: 2,
      } satisfies WsMessage);
    });

    // The server answers any re-subscribe with its current snapshot, and the
    // REST read resolves with the same data.
    const serverSnapshot = [a, bUpdated, cUpdated];
    if (sentMessages(sendMessage, "subscribe").length > initialSubscribes) {
      act(() => {
        wsControl.emit({
          type: "events",
          issueId: "issue-1",
          events: serverSnapshot,
        } satisfies WsMessage);
      });
    }
    await act(async () => {
      catchUpRest.resolve(serverSnapshot);
      await flushAsync();
    });

    expect(result.current.events).toEqual(serverSnapshot);
  });

  test("keeps an empty WebSocket events response in the missing trace state", async () => {
    const { fetchEvents } = setupTraceDataTest({ status: "connected" });

    const { result } = renderHook(() => useTraceData());
    act(() => {
      result.current.setSelectedTicketId("issue-1");
    });
    act(() => {
      wsControl.emit({ type: "events", issueId: "issue-1", events: [] } satisfies WsMessage);
    });
    await act(flushAsync);

    expect(result.current.traceExists).toBe(false);
    expect(result.current.loading).toBe(false);

    act(() => {
      wsControl.emit({ type: "events", issueId: "issue-1", events: [] } satisfies WsMessage);
    });

    expect(result.current.events).toEqual([]);
    expect(result.current.traceExists).toBe(false);
    expect(fetchEvents).not.toHaveBeenCalled();
  });
});

function setupTraceDataTest(options?: { status?: WsStatus }): {
  sendMessage: Mock<(message: SentWsMessage) => void>;
  fetchTickets: Mock<() => Promise<unknown[]>>;
  fetchEvents: Mock<(issueId: string) => Promise<DisplayEvent[]>>;
} {
  const sendMessage = vi.fn<(message: SentWsMessage) => void>();
  const fetchTickets = vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
  const fetchEvents = vi.fn<(issueId: string) => Promise<DisplayEvent[]>>().mockResolvedValue([]);

  wsControl.listeners.clear();
  wsControl.state.version = 0;
  wsControl.state.status = options?.status ?? "disconnected";
  wsControl.state.lastMessage = null;
  wsControl.state.sendMessage = sendMessage;
  apiControl.fetchTickets = fetchTickets;
  apiControl.fetchEvents = fetchEvents;

  return { sendMessage, fetchTickets, fetchEvents };
}

function sentMessages(
  sendMessage: Mock<(message: SentWsMessage) => void>,
  type: "subscribe" | "unsubscribe",
): SentWsMessage[] {
  return sendMessage.mock.calls.map(([message]) => message).filter((m) => m.type === type);
}

function setWindowScrollY(y: number): void {
  Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: y });
  window.dispatchEvent(new Event("scroll"));
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
