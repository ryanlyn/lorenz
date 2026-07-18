import { EventEmitter } from "node:events";

import { assert } from "@lorenz/test-utils";
import { afterEach, test, vi } from "vitest";
import type WebSocket from "ws";

import { BOT_ID, CHANNEL_ID, GUILD_ID } from "./helpers.js";

import { DiscordGatewayChangeStream } from "@lorenz/discord-tracker";

afterEach(() => vi.useRealTimers());

test("Gateway identifies with minimal message intents and filters wake-ups by channel", () => {
  vi.useFakeTimers();
  const socket = new FakeWebSocket();
  const changes = vi.fn();
  const stream = new DiscordGatewayChangeStream({
    token: "token",
    guildId: GUILD_ID,
    botUserId: BOT_ID,
    channels: new Set([CHANNEL_ID]),
    trackedThreadIds: new Set(["723456789012345678"]),
    onChange: changes,
    createWebSocket: () => socket as unknown as WebSocket,
    random: () => 0.5,
  });
  stream.start();

  socket.receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  const identify = JSON.parse(socket.sent[0] ?? "{}") as { op?: number; d?: { intents?: number } };
  assert.equal(identify.op, 2);
  assert.equal(identify.d?.intents, (1 << 0) | (1 << 9) | (1 << 10) | (1 << 15));

  socket.receive({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 1,
    d: { guild_id: GUILD_ID, channel_id: CHANNEL_ID, mentions: [{ id: BOT_ID }] },
  });
  socket.receive({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 2,
    d: { guild_id: GUILD_ID, channel_id: CHANNEL_ID, mention_roles: ["role-id"] },
  });
  socket.receive({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 3,
    d: { guild_id: GUILD_ID, channel_id: "723456789012345678" },
  });
  socket.receive({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 4,
    d: { guild_id: GUILD_ID, channel_id: "999999999999999999" },
  });
  socket.receive({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 5,
    d: { guild_id: "999999999999999999", channel_id: CHANNEL_ID },
  });

  assert.equal(changes.mock.calls.length, 3);
  stream.close();
});

test("Gateway resumes with the last sequence after a reconnectable close", () => {
  vi.useFakeTimers();
  const sockets: FakeWebSocket[] = [];
  const stream = new DiscordGatewayChangeStream({
    token: "token",
    guildId: GUILD_ID,
    botUserId: BOT_ID,
    channels: new Set([CHANNEL_ID]),
    trackedThreadIds: new Set(),
    onChange: () => {},
    createWebSocket: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    random: () => 0.5,
  });
  stream.start();
  sockets[0]!.receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  sockets[0]!.receive({
    op: 0,
    t: "READY",
    s: 42,
    d: {
      session_id: "session",
      resume_gateway_url: "wss://resume.discord.test",
    },
  });
  sockets[0]!.serverClose(1006);

  vi.advanceTimersByTime(2000);
  assert.equal(sockets.length, 2);
  sockets[1]!.receive({ op: 10, d: { heartbeat_interval: 45_000 } });
  const resume = JSON.parse(sockets[1]!.sent[0] ?? "{}") as {
    op?: number;
    d?: { session_id?: string; seq?: number };
  };
  assert.equal(resume.op, 6);
  assert.deepEqual(resume.d, { token: "token", session_id: "session", seq: 42 });
  stream.close();
});

test("Gateway stops reconnecting after fatal authentication or intent close codes", () => {
  vi.useFakeTimers();
  const sockets: FakeWebSocket[] = [];
  const warnings: string[] = [];
  const stream = new DiscordGatewayChangeStream({
    token: "token",
    guildId: GUILD_ID,
    botUserId: BOT_ID,
    channels: new Set([CHANNEL_ID]),
    trackedThreadIds: new Set(),
    onChange: () => {},
    logger: { warn: (message) => warnings.push(message) },
    createWebSocket: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  stream.start();
  sockets[0]!.serverClose(4014);
  vi.advanceTimersByTime(60_000);

  assert.equal(sockets.length, 1);
  assert.match(warnings[0] ?? "", /fatal code 4014/);
  stream.close();
});

class FakeWebSocket extends EventEmitter {
  readyState = 1;
  readonly sent: string[] = [];

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
  }

  receive(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.emit("close", code, Buffer.alloc(0));
  }
}
