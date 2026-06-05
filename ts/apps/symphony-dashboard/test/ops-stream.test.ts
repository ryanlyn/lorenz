import { expect, test, vi } from "vitest";

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
