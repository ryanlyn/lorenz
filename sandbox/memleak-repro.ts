/**
 * Memory-leak reproduction harness for the long-running slack-tracker daemon.
 *
 * Drives the REAL LorenzRuntime + SlackTrackerClient + SlackWebTransport with a
 * fake Slack Web API (fetchImpl) and repeatedly polls, simulating days of
 * daemon uptime in seconds. Between measurement batches it forces GC and
 * prints heapUsed, so unbounded growth (a leak) shows up as a monotonically
 * increasing RSS/heap line instead of a flat one.
 *
 * Usage:
 *   node --expose-gc --import tsx sandbox/memleak-repro.ts [pollCount]
 */

import { createServer, type Server } from "node:http";

import { parseConfig } from "@lorenz/config";
import type { Settings, WorkflowDefinition } from "@lorenz/domain";
import { LorenzRuntime } from "@lorenz/runtime";

import { createFakeClock } from "./fake-clock.js";
import { createFakeAgentRunner } from "./fake-runner.js";
import {
  SlackTrackerClient,
  SlackWebTransport,
  slackTrackerProvider,
} from "../extensions/slack-tracker/src/index.js";
import { TrackerRegistry } from "@lorenz/tracker-sdk";

const trackers = new TrackerRegistry();
trackers.register(slackTrackerProvider);

const CHANNELS = ["C1", "C2", "C3"];
const MESSAGES_PER_CHANNEL = 120;
const REPLIES_PER_THREAD = 25;

function buildSettings(endpoint?: string): Settings {
  return parseConfig(
    {
      tracker: {
        kind: "slack",
        channels: CHANNELS,
        bot_user_id: "U_BOT",
        active_states: ["Todo", "In Progress"],
        ...(endpoint ? { endpoint } : {}),
      },
      polling: { interval_ms: 60_000 },
      logging: { log_file: "/tmp/lorenz-memleak-repro.log" },
    },
    { SLACK_BOT_TOKEN: "xoxb-test" },
    {},
    trackers,
  );
}

/** Fake Slack Web API. Threads keep "changing" (latest_reply advances every
 * poll) so the scan looks like an active workspace. */
class FakeSlack {
  tick = 0;
  /** In "dispatch" mode a slice of mentions stays ACTIVE (Todo) so the runtime
   * dispatches runs; in "idle" mode every mention is terminal. */
  activeMentions = 0;

  history(channel: string): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [];
    for (let i = 0; i < MESSAGES_PER_CHANNEL; i++) {
      const ts = `170000${i.toString().padStart(4, "0")}.000100`;
      if (i % 10 === 0 && i / 10 < this.activeMentions) {
        // An ACTIVE bot mention (no reactions -> Todo): dispatched every poll.
        messages.push({
          ts,
          text: `<@U_BOT> active task ${channel}:${i} #ops keep working`,
          user: "U_HUMAN",
          reactions: [],
        });
      } else if (i % 10 === 0) {
        // A bot mention already marked Done (terminal): scanned every poll but
        // never dispatched.
        messages.push({
          ts,
          text: `<@U_BOT> task ${channel}:${i} #ops please do the thing`,
          user: "U_HUMAN",
          reactions: [{ name: "white_check_mark", users: ["U_BOT"] }],
        });
      } else {
        // A busy human thread: reply_count>0 and latest_reply advances every
        // poll, so the thread-state cache misses and conversations.replies is
        // re-fetched, like a real active channel.
        messages.push({
          ts,
          text: `human chatter ${channel}:${i} with some longer text to look realistic`,
          user: "U_HUMAN",
          reply_count: REPLIES_PER_THREAD,
          latest_reply: `17000${this.tick.toString().padStart(5, "0")}.000900`,
        });
      }
    }
    return { ok: true, messages };
  }

  replies(): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [
      { ts: "1700000000.000100", text: "root" },
    ];
    for (let i = 0; i < REPLIES_PER_THREAD; i++) {
      messages.push({
        ts: `1700000${i.toString().padStart(3, "0")}.000200`,
        text: `reply ${i} some discussion text that is moderately long to simulate real content`,
        user: "U_HUMAN",
      });
    }
    return { ok: true, messages };
  }

  fetch: typeof fetch = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = url.pathname.split("/").pop() ?? "";
    let body: Record<string, unknown>;
    if (method === "auth.test") {
      body = { ok: true, url: "https://example.slack.com" };
    } else if (method === "conversations.history") {
      body = this.history(url.searchParams.get("channel") ?? "C1");
    } else if (method === "conversations.replies") {
      body = this.replies();
    } else {
      body = { ok: true };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Serve the fake Slack API over real HTTP so the transport exercises the real
 * undici fetch stack (keep-alive pools, AbortSignal.timeout wiring). */
async function startFakeSlackServer(fake: FakeSlack): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = url.pathname.split("/").pop() ?? "";
    let body: Record<string, unknown>;
    if (method === "auth.test") body = { ok: true, url: "https://example.slack.com" };
    else if (method === "conversations.history")
      body = fake.history(url.searchParams.get("channel") ?? "C1");
    else if (method === "conversations.replies") body = fake.replies();
    else body = { ok: true };
    // Drain the request before responding so keep-alive connections stay healthy.
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/api` };
}

async function main(): Promise<void> {
  const mode = ["dispatch", "real-http"].includes(process.argv[2] ?? "")
    ? (process.argv[2] as "dispatch" | "real-http")
    : "idle";
  const polls = Number(process.argv[3] ?? 500);
  const fake = new FakeSlack();
  if (mode === "dispatch") fake.activeMentions = 4;
  const httpServer = mode === "real-http" ? await startFakeSlackServer(fake) : null;
  const settings = buildSettings(httpServer?.url);
  const clock = createFakeClock();
  const transport = new SlackWebTransport(
    settings,
    httpServer ? fetch : fake.fetch,
    async () => {},
    { warn: () => {} },
    { now: () => clock.nowMs },
  );
  const client = new SlackTrackerClient(settings, transport);
  const workflow: WorkflowDefinition = {
    path: "/tmp/fake-workflow.md",
    config: {},
    promptTemplate: "",
    settings,
  };
  const runtime = new LorenzRuntime({
    workflow,
    client,
    clock,
    appendLogEvent: async () => {},
    removeIssueWorkspaces: async () => {},
    listIssueWorkspaces: async () => [],
    runner:
      mode === "dispatch"
        ? createFakeAgentRunner({ defaultBehavior: { turnCount: 2 } }, clock)
        : async () => {
            throw new Error("runner should not be invoked in idle mode");
          },
    validateDispatch: () => {},
  });

  const gc = globalThis.gc;
  if (!gc) throw new Error("run with --expose-gc");

  const batch = Math.max(1, Math.floor(polls / 10));
  gc();
  const baseline = process.memoryUsage().heapUsed;
  console.log(`mode=${mode} baseline heapUsed=${mb(baseline)} (${polls} polls, batch=${batch})`);
  for (let i = 1; i <= polls; i++) {
    fake.tick = i;
    await runtime.pollOnce();
    // Let runs settle and retry/backoff timers fire, like a real daemon
    // sitting through its polling interval.
    await clock.advance(settings.polling.intervalMs);
    if (i % batch === 0) {
      gc();
      const heap = process.memoryUsage().heapUsed;
      console.log(
        `poll ${i}: heapUsed=${mb(heap)} (+${mb(heap - baseline)} since baseline)`,
      );
    }
  }
  runtime.stop();
  httpServer?.server.close();
}

void main();
