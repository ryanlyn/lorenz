// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useWebSocket } from "../src/shared/hooks/useWebSocket";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  });

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useWebSocket", () => {
  test("ignores ping messages and reconnects after the socket closes", async () => {
    const { result, unmount } = renderHook(() => useWebSocket());
    const first = FakeWebSocket.instances[0]!;

    expect(first.url).toBe("ws://localhost:3000/ws");
    expect(result.current.status).toBe("connecting");

    act(() => first.open());
    expect(result.current.status).toBe("connected");

    const init = { type: "init", tickets: [] } as const;
    act(() => first.receive(init));
    expect(result.current.lastMessage).toEqual(init);

    act(() => first.receive({ type: "ping" }));
    expect(result.current.lastMessage).toEqual(init);

    act(() => first.close());
    expect(result.current.status).toBe("disconnected");

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result.current.status).toBe("connecting");

    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    expect(result.current.status).toBe("connected");

    unmount();
    expect(second.close).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
