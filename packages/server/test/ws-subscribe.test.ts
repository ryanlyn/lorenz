import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import type { DisplayEvent, TicketInfo, TraceWatcher } from "@lorenz/traceviz-server";

import type { RuntimeServerSource } from "../src/index.js";
import { createWsHandler } from "../src/ws.js";

describe("observability /ws trace subscriptions", () => {
  test("sends an initial events response and appended events with the client cursor", async () => {
    const firstEvent = eventFixture("turn_started", "2026-01-01T00:00:00.000Z");
    const secondEvent = eventFixture("message", "2026-01-01T00:00:01.000Z");
    const fake = createFakeWatcher([firstEvent]);
    const server = await startWsTestServer(fake.watcher);
    const ws = new WebSocket(server.url);
    const messages: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));

    try {
      await waitFor(() => messages.some((message) => message.type === "init"));

      ws.send(JSON.stringify({ type: "subscribe", issueId: "issue-1" }));
      await waitFor(() => messages.some((message) => message.type === "events"));

      expect(fake.subscribe).toHaveBeenCalledOnce();
      expect(messages.find((message) => message.type === "events")).toMatchObject({
        type: "events",
        issueId: "issue-1",
        events: [firstEvent],
      });

      fake.setEvents([firstEvent, secondEvent]);
      fake.emit();

      await waitFor(() => messages.some((message) => message.type === "events_append"));
      expect(messages.find((message) => message.type === "events_append")).toMatchObject({
        type: "events_append",
        issueId: "issue-1",
        events: [secondEvent],
        fromIndex: 1,
      });
      ws.close();
      await closed;
      await waitFor(() => fake.unsubscribe.mock.calls.length === 1);
    } finally {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
      await server.stop();
    }

    expect(fake.unsubscribe).toHaveBeenCalledOnce();
    expect(fake.unsubscribe).toHaveBeenCalledWith("issue-1");
  });

  test("sends a suffix replacement when a display event mutates without growing", async () => {
    const firstEvent = eventFixture("message", "2026-01-01T00:00:00.000Z", "a");
    const updatedEvent = eventFixture("message", "2026-01-01T00:00:00.000Z", "ab");
    const fake = createFakeWatcher([firstEvent]);
    const server = await startWsTestServer(fake.watcher);
    const ws = new WebSocket(server.url);
    const messages: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));

    try {
      await waitFor(() => messages.some((message) => message.type === "init"));

      ws.send(JSON.stringify({ type: "subscribe", issueId: "issue-1" }));
      await waitFor(() => messages.some((message) => message.type === "events"));

      fake.setEvents([updatedEvent]);
      fake.emit();

      await waitFor(() => messages.some((message) => message.type === "events_append"));
      expect(messages.find((message) => message.type === "events_append")).toMatchObject({
        type: "events_append",
        issueId: "issue-1",
        events: [updatedEvent],
        fromIndex: 0,
      });
      ws.close();
      await closed;
    } finally {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
      await server.stop();
    }
  });

  test("starts the delta at the first changed event when a mutation and append are batched", async () => {
    const firstEvent = eventFixture("message", "2026-01-01T00:00:00.000Z", "a");
    const updatedEvent = eventFixture("message", "2026-01-01T00:00:00.000Z", "ab");
    const appendedEvent = eventFixture("message", "2026-01-01T00:00:01.000Z", "next");
    const fake = createFakeWatcher([firstEvent]);
    const server = await startWsTestServer(fake.watcher);
    const ws = new WebSocket(server.url);
    const messages: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));

    try {
      await waitFor(() => messages.some((message) => message.type === "init"));

      ws.send(JSON.stringify({ type: "subscribe", issueId: "issue-1" }));
      await waitFor(() => messages.some((message) => message.type === "events"));

      fake.setEvents([updatedEvent, appendedEvent]);
      fake.emit();

      await waitFor(() => messages.some((message) => message.type === "events_append"));
      expect(messages.find((message) => message.type === "events_append")).toMatchObject({
        type: "events_append",
        issueId: "issue-1",
        events: [updatedEvent, appendedEvent],
        fromIndex: 0,
      });
      ws.close();
      await closed;
    } finally {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
      await server.stop();
    }
  });

  test("does not increment watcher refs for duplicate same-ticket subscribe messages", async () => {
    const fake = createFakeWatcher([eventFixture("turn_started", "2026-01-01T00:00:00.000Z")]);
    const server = await startWsTestServer(fake.watcher);
    const ws = new WebSocket(server.url);
    const messages: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));

    try {
      await waitFor(() => messages.some((message) => message.type === "init"));

      ws.send(JSON.stringify({ type: "subscribe", issueId: "issue-1" }));
      await waitFor(() => messages.filter((message) => message.type === "events").length === 1);

      ws.send(JSON.stringify({ type: "subscribe", issueId: "issue-1" }));
      await waitFor(() => messages.filter((message) => message.type === "events").length === 2);

      expect(fake.subscribe).toHaveBeenCalledOnce();
      expect(fake.unsubscribe).not.toHaveBeenCalled();
      ws.close();
      await closed;
      await waitFor(() => fake.unsubscribe.mock.calls.length === 1);
    } finally {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
      await server.stop();
    }

    expect(fake.unsubscribe).toHaveBeenCalledOnce();
    expect(fake.unsubscribe).toHaveBeenCalledWith("issue-1");
  });

  test("releases the watcher subscription on an unsubscribe message and stops deltas", async () => {
    const firstEvent = eventFixture("message", "2026-01-01T00:00:00.000Z", "a");
    const secondEvent = eventFixture("message", "2026-01-01T00:00:01.000Z", "b");
    const fake = createFakeWatcher([firstEvent]);
    const server = await startWsTestServer(fake.watcher);
    const ws = new WebSocket(server.url);
    const messages: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()));

    try {
      await waitFor(() => messages.some((message) => message.type === "init"));

      ws.send(JSON.stringify({ type: "subscribe", issueId: "issue-1" }));
      await waitFor(() => messages.some((message) => message.type === "events"));

      ws.send(JSON.stringify({ type: "unsubscribe", issueId: "issue-1" }));
      await waitFor(() => fake.unsubscribe.mock.calls.length === 1);

      // Watcher changes still broadcast ticket updates but no longer send
      // deltas to the unsubscribed client.
      fake.setEvents([firstEvent, secondEvent]);
      fake.emit();

      await waitFor(() => messages.some((message) => message.type === "update"));
      expect(messages.some((message) => message.type === "events_append")).toBe(false);

      ws.close();
      await closed;
    } finally {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
      await server.stop();
    }

    // Closing after an explicit unsubscribe must not release the ref twice.
    expect(fake.unsubscribe).toHaveBeenCalledOnce();
    expect(fake.unsubscribe).toHaveBeenCalledWith("issue-1");
  });
});

function createFakeWatcher(initialEvents: DisplayEvent[]): {
  watcher: TraceWatcher;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  setEvents(events: DisplayEvent[]): void;
  emit(): void;
} {
  const ticket: TicketInfo = {
    issueId: "issue-1",
    identifier: "TEST-1",
    status: "running",
    turnCount: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  let events = initialEvents;
  let callback: ((issueId: string, ticket: TicketInfo) => void) | null = null;
  const subscribe = vi.fn();
  const unsubscribe = vi.fn();
  const watcher = {
    start: vi.fn((next: (issueId: string, ticket: TicketInfo) => void) => {
      callback = next;
    }),
    stop: vi.fn(),
    getTickets: vi.fn(() => [ticket]),
    subscribe,
    unsubscribe,
    getEventsForTicket: vi.fn((issueId: string) => (issueId === ticket.issueId ? events : [])),
  } as unknown as TraceWatcher;

  return {
    watcher,
    subscribe,
    unsubscribe,
    setEvents(nextEvents: DisplayEvent[]) {
      events = nextEvents;
    },
    emit() {
      callback?.(ticket.issueId, ticket);
    },
  };
}

async function startWsTestServer(watcher: TraceWatcher): Promise<{
  url: string;
  stop(): Promise<void>;
}> {
  const app = new Hono();
  const wsSetup = createWsHandler(app, unavailableRuntime(), watcher);
  let server!: ServerType;

  await new Promise<void>((resolve, reject) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve();
    });
    server.once("error", reject);
  });
  wsSetup.injectWebSocket(server);

  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Expected test server to listen on a TCP port");
  }

  return {
    url: `ws://127.0.0.1:${address.port}/ws`,
    async stop() {
      wsSetup.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

function unavailableRuntime(): RuntimeServerSource {
  return {
    snapshot() {
      throw new Error("snapshot_unavailable");
    },
    subscribe() {
      return () => {};
    },
    requestRefresh() {
      return { queued: false };
    },
  };
}

function eventFixture(
  kind: "turn_started" | "message",
  timestamp: string,
  text = "hello",
): DisplayEvent {
  if (kind === "turn_started") return { kind, turnIndex: 0, timestamp };
  return { kind, text, timestamp };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
