import { afterEach, test, vi } from "vitest";
import { assert } from "@lorenz/test-utils";
import type { RuntimeSnapshot } from "@lorenz/runtime-events";

import {
  HEADLESS_SNAPSHOT_INTERVAL_MS,
  subscribeHeadlessSnapshotWriter,
  type HeadlessSnapshotSink,
} from "@lorenz/cli";

function fakeSnapshot(marker: string): RuntimeSnapshot {
  return { poll: { lastError: marker } } as unknown as RuntimeSnapshot;
}

interface FakeSink extends HeadlessSnapshotSink {
  chunks: string[];
  /** Value the next write() calls return (false simulates a full pipe). */
  writable: boolean;
  drain(): void;
}

function fakeSink(): FakeSink {
  let onDrain: (() => void) | null = null;
  const sink: FakeSink = {
    chunks: [],
    writable: true,
    write(chunk: string) {
      sink.chunks.push(chunk);
      return sink.writable;
    },
    once(_event: "drain", listener: () => void) {
      onDrain = listener;
      return sink;
    },
    drain() {
      const listener = onDrain;
      onDrain = null;
      listener?.();
    },
  };
  return sink;
}

function fakeRuntime(): {
  subscribe: (listener: (snapshot: RuntimeSnapshot) => void) => () => void;
  emit: (snapshot: RuntimeSnapshot) => void;
} {
  const listeners: Array<(snapshot: RuntimeSnapshot) => void> = [];
  return {
    subscribe(listener) {
      listeners.push(listener);
      return () => {};
    },
    emit(snapshot) {
      for (const listener of listeners) listener(snapshot);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test("headless writer coalesces an emit burst into the latest snapshot per interval", () => {
  vi.useFakeTimers();
  const runtime = fakeRuntime();
  const sink = fakeSink();
  subscribeHeadlessSnapshotWriter(runtime, sink);

  // A burst of emits (e.g. one per streamed agent update) inside one interval
  // must produce ONE immediate write, then ONE write of the latest snapshot
  // when the cooldown elapses - never a write per emit.
  for (let i = 0; i < 500; i++) runtime.emit(fakeSnapshot(`burst-${i}`));
  assert.equal(sink.chunks.length, 1);
  assert.match(sink.chunks[0]!, "burst-0");

  vi.advanceTimersByTime(HEADLESS_SNAPSHOT_INTERVAL_MS);
  assert.equal(sink.chunks.length, 2);
  assert.match(sink.chunks[1]!, "burst-499");

  // Nothing pending: the cooldown expiring again writes nothing.
  vi.advanceTimersByTime(HEADLESS_SNAPSHOT_INTERVAL_MS * 5);
  assert.equal(sink.chunks.length, 2);
});

test("headless writer holds at most one pending snapshot under backpressure", () => {
  vi.useFakeTimers();
  const runtime = fakeRuntime();
  const sink = fakeSink();
  subscribeHeadlessSnapshotWriter(runtime, sink);

  // The pipe reports it is full: the writer must stop writing (not queue
  // unbounded chunks in the heap) until the sink drains.
  sink.writable = false;
  runtime.emit(fakeSnapshot("first"));
  assert.equal(sink.chunks.length, 1);
  for (let i = 0; i < 1000; i++) runtime.emit(fakeSnapshot(`queued-${i}`));
  vi.advanceTimersByTime(HEADLESS_SNAPSHOT_INTERVAL_MS * 10);
  assert.equal(sink.chunks.length, 1);

  // On drain, exactly the LATEST snapshot is written.
  sink.writable = true;
  sink.drain();
  assert.equal(sink.chunks.length, 2);
  assert.match(sink.chunks[1]!, "queued-999");
});
