/**
 * Fake Slack backend (HTTP Web API + Socket Mode WebSocket) for memory-leak
 * investigation of the real daemon. Serves:
 *   - auth.test / conversations.history / conversations.replies /
 *     apps.connections.open over HTTP
 *   - a Socket Mode WS endpoint that streams events_api envelopes at
 *     EVENTS_PER_SEC and recycles the connection (disconnect frame) every
 *     RECYCLE_MS, like Slack does.
 *
 * Usage: npx tsx sandbox/memleak-fake-slack.ts <port>
 */

import { createServer } from "node:http";
import { createRequire } from "node:module";

// ws is a transitive dependency (via @hono/node-ws); resolve it through the
// package that depends on it so this works regardless of store layout.
const require = createRequire(import.meta.url);
const nodeWsRequire = createRequire(require.resolve("@hono/node-ws"));
const { WebSocketServer } = nodeWsRequire("ws") as typeof import("ws");

const PORT = Number(process.argv[2] ?? 8899);
const EVENTS_PER_SEC = Number(process.env.EVENTS_PER_SEC ?? 20);
const RECYCLE_MS = Number(process.env.RECYCLE_MS ?? 60_000);
/** Bot mentions (per channel) left ACTIVE (Todo) so the daemon dispatches runs. */
const ACTIVE_MENTIONS = Number(process.env.ACTIVE_MENTIONS ?? 0);
const MESSAGES_PER_CHANNEL = 120;
const REPLIES_PER_THREAD = 25;

let tick = 0;
setInterval(() => {
  tick += 1;
}, 1000).unref();

function history(channel: string): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  for (let i = 0; i < MESSAGES_PER_CHANNEL; i++) {
    const ts = `170000${i.toString().padStart(4, "0")}.000100`;
    if (i % 10 === 0 && i / 10 < ACTIVE_MENTIONS) {
      messages.push({
        ts,
        text: `<@U_BOT> active task ${channel}:${i} #ops keep working`,
        user: "U_HUMAN",
        reactions: [],
      });
    } else if (i % 10 === 0) {
      messages.push({
        ts,
        text: `<@U_BOT> task ${channel}:${i} #ops please do the thing`,
        user: "U_HUMAN",
        reactions: [{ name: "white_check_mark", users: ["U_BOT"] }],
      });
    } else {
      messages.push({
        ts,
        text: `human chatter ${channel}:${i} with some longer text to look realistic`,
        user: "U_HUMAN",
        reply_count: REPLIES_PER_THREAD,
        latest_reply: `17000${tick.toString().padStart(5, "0")}.000900`,
      });
    }
  }
  return { ok: true, messages };
}

function replies(): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [{ ts: "1700000000.000100", text: "root" }];
  for (let i = 0; i < REPLIES_PER_THREAD; i++) {
    messages.push({
      ts: `1700000${i.toString().padStart(3, "0")}.000200`,
      text: `reply ${i} some discussion text that is moderately long to simulate real content`,
      user: "U_HUMAN",
    });
  }
  return { ok: true, messages };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = url.pathname.split("/").pop() ?? "";
  let body: Record<string, unknown>;
  if (method === "auth.test") body = { ok: true, url: "https://example.slack.com" };
  else if (method === "apps.connections.open")
    body = { ok: true, url: `ws://127.0.0.1:${PORT}/socket` };
  else if (method === "conversations.history")
    body = history(url.searchParams.get("channel") ?? "C1");
  else if (method === "conversations.replies") body = replies();
  else body = { ok: true };
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});

const wss = new WebSocketServer({ server, path: "/socket" });
wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "hello" }));
  let n = 0;
  const eventTimer = setInterval(
    () => {
      n += 1;
      socket.send(
        JSON.stringify({
          type: "events_api",
          envelope_id: `env-${Date.now()}-${n}`,
          payload: {
            event: {
              type: "message",
              channel: "C1",
              text: `busy channel message ${n} with some payload text`,
              user: "U_HUMAN",
              ts: `${Date.now() / 1000}`,
            },
          },
        }),
      );
    },
    Math.max(5, Math.round(1000 / EVENTS_PER_SEC)),
  );
  const recycleTimer = setTimeout(() => {
    socket.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
  }, RECYCLE_MS);
  socket.on("message", () => {}); // acks; ignored
  socket.on("close", () => {
    clearInterval(eventTimer);
    clearTimeout(recycleTimer);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake slack listening on http://127.0.0.1:${PORT}/api (ws /socket)`);
});
