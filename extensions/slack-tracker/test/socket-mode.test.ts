import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { SlackSocketMode, type SlackWebSocketLike } from "@lorenz/slack-tracker";

/** A controllable in-memory WebSocket that records sends and lets tests drive lifecycle events. */
class FakeSocket implements SlackWebSocketLike {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(payload?: unknown) => void>>();

  send(data: string): void {
    if (this.closed) throw new Error("send on closed socket");
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  addEventListener(type: string, listener: (payload?: { data: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, payload?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(payload);
  }

  receive(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }
}

function okOpen(url = "wss://example.test/link"): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, url }),
    }) as unknown as Response) as unknown as typeof fetch;
}

const silentLogger = { warn: () => {} };

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeSocketMode(overrides: {
  channels?: string[];
  onChange: () => void;
  fetchImpl?: typeof fetch;
  socketQueue: FakeSocket[];
  reconnectDelayMs?: (attempt: number) => number;
}): SlackSocketMode {
  let index = 0;
  return new SlackSocketMode({
    endpoint: "https://slack.com/api",
    appToken: "xapp-test",
    channels: overrides.channels ?? ["C1"],
    onChange: overrides.onChange,
    fetchImpl: overrides.fetchImpl ?? okOpen(),
    logger: silentLogger,
    ...(overrides.reconnectDelayMs ? { reconnectDelayMs: overrides.reconnectDelayMs } : {}),
    webSocketFactory: () => {
      const socket = overrides.socketQueue[index];
      index += 1;
      if (!socket) throw new Error("no fake socket queued");
      return socket;
    },
  });
}

test("an app_mention in a watched channel acks the envelope and nudges onChange", async () => {
  let nudges = 0;
  const socket = new FakeSocket();
  const sm = makeSocketMode({ onChange: () => (nudges += 1), socketQueue: [socket] });
  sm.start();
  await flush();

  socket.receive({ type: "hello" });
  socket.receive({
    type: "events_api",
    envelope_id: "env-1",
    payload: { event: { type: "app_mention", channel: "C1", ts: "1.1" } },
  });

  assert.equal(nudges, 1);
  // The envelope is acked (Slack redelivers otherwise); hello carries no envelope_id so the only
  // ack is for env-1.
  assert.deepEqual(socket.sent, [JSON.stringify({ envelope_id: "env-1" })]);
  sm.close();
});

test("events outside the watched channels are acked but do not nudge", async () => {
  let nudges = 0;
  const socket = new FakeSocket();
  const sm = makeSocketMode({
    channels: ["C1"],
    onChange: () => (nudges += 1),
    socketQueue: [socket],
  });
  sm.start();
  await flush();

  socket.receive({
    type: "events_api",
    envelope_id: "env-2",
    payload: { event: { type: "app_mention", channel: "C_OTHER", ts: "1.1" } },
  });

  assert.equal(nudges, 0);
  // Still acked so Slack does not redeliver an event we deliberately ignore.
  assert.deepEqual(socket.sent, [JSON.stringify({ envelope_id: "env-2" })]);
  sm.close();
});

test("reaction events resolve their channel from item.channel", async () => {
  let nudges = 0;
  const socket = new FakeSocket();
  const sm = makeSocketMode({ onChange: () => (nudges += 1), socketQueue: [socket] });
  sm.start();
  await flush();

  socket.receive({
    type: "events_api",
    envelope_id: "env-3",
    payload: { event: { type: "reaction_added", item: { channel: "C1", ts: "1.1" } } },
  });

  assert.equal(nudges, 1);
  sm.close();
});

test("a disconnect frame closes the socket and reconnects", async () => {
  let nudges = 0;
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sm = makeSocketMode({
    onChange: () => (nudges += 1),
    socketQueue: [first, second],
    reconnectDelayMs: () => 0,
  });
  sm.start();
  await flush();
  first.receive({ type: "hello" });

  first.receive({ type: "disconnect", reason: "refresh_requested" });
  assert.equal(first.closed, true);

  // Let the reconnect timer (delay 0) and the new connect()'s fetch settle.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await flush();

  second.receive({
    type: "events_api",
    envelope_id: "env-4",
    payload: { event: { type: "message", channel: "C1", ts: "2.1" } },
  });
  assert.equal(nudges, 1);
  sm.close();
});

test("close() stops reconnecting after the socket drops", async () => {
  let connects = 0;
  const first = new FakeSocket();
  const sm = new SlackSocketMode({
    endpoint: "https://slack.com/api",
    appToken: "xapp-test",
    channels: ["C1"],
    onChange: () => {},
    logger: silentLogger,
    reconnectDelayMs: () => 0,
    fetchImpl: okOpen(),
    webSocketFactory: () => {
      connects += 1;
      if (connects === 1) return first;
      throw new Error("must not reconnect after close()");
    },
  });
  sm.start();
  await flush();

  sm.close();
  // A close that originates from us must not schedule a reconnect.
  first.emit("close");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await flush();
  assert.equal(connects, 1);
});

test("a failed apps.connections.open schedules a reconnect rather than throwing", async () => {
  let attempts = 0;
  const second = new FakeSocket();
  const fetchImpl = (async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: "invalid_auth" }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, url: "wss://x" }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  let nudges = 0;
  const sm = makeSocketMode({
    onChange: () => (nudges += 1),
    socketQueue: [second],
    fetchImpl,
    reconnectDelayMs: () => 0,
  });
  sm.start();
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await flush();

  second.receive({
    type: "events_api",
    envelope_id: "env-5",
    payload: { event: { type: "app_mention", channel: "C1", ts: "3.1" } },
  });
  assert.ok(attempts >= 2);
  assert.equal(nudges, 1);
  sm.close();
});
