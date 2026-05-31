import { test } from "vitest";
import { parseConfig } from "@symphony/config";

import { assert } from "../../../test/assert.js";

import { SlackWebTransport } from "@symphony/slack-tracker";

function settings() {
  return parseConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb-abc" },
  );
}

test("listMentions calls conversations.history with auth and parses messages", async () => {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: "1.1", text: "<@U1> hi", reactions: [{ name: "eyes", count: 1 }] }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl);
  const messages = await transport.listMentions(["C1"]);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]!.reactions, ["eyes"]);
  assert.equal(messages[0]!.channel, "C1");
  assert.match(calls[0]!.url, /\/conversations\.history\?/);
  assert.match(calls[0]!.url, /channel=C1/);
  assert.equal(calls[0]!.auth, "Bearer xoxb-abc");
});

test("listMentions filters to the configured bot user when botUserId is set", async () => {
  const fetchImpl = (async () => {
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [
          { ts: "1.1", text: "<@U_OTHER> human chatter", reactions: [] },
          { ts: "1.2", text: "<@U_BOT> do it", reactions: [] },
          { ts: "1.3", text: "<@U_BOT|worker> and this", reactions: [] },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const settingsWithBot = parseConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U_BOT" } },
    { SLACK_BOT_TOKEN: "xoxb-abc" },
  );
  const transport = new SlackWebTransport(settingsWithBot, fetchImpl);
  const messages = await transport.listMentions(["C1"]);

  assert.deepEqual(
    messages.map((m) => m.ts),
    ["1.2", "1.3"],
  );
});

test("listMentions fails closed when no botUserId is configured: no mentions, warns once, no fetch", async () => {
  // Trust boundary: with NO botUserId set, the production web transport must refuse to scan rather
  // than fall back to any-mention (which would treat every human-to-human <@U...> mention as an
  // issue and expose its text to workers). It returns nothing, warns once, and never even calls
  // Slack. Contrast with the positive bot-id test above on the identical payload, where the bot's
  // own mentions ("1.2"/"1.3") ARE returned - so the disappearance here is provably the fail-closed
  // guard, not unrelated parsing.
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [
          { ts: "1.1", text: "<@U_OTHER> human chatter", reactions: [] },
          { ts: "1.2", text: "<@U_BOT> do it", reactions: [] },
          { ts: "1.3", text: "<@U_BOT|worker> and this", reactions: [] },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  // Build a slack settings object and then blank out the bot user id, since parseConfig + validate
  // now require one. This mirrors a misconfigured deployment where SLACK_BOT_USER_ID resolves empty.
  const noBot = parseConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb-abc" },
  );
  delete noBot.tracker.botUserId;

  const warnings: string[] = [];
  const transport = new SlackWebTransport(noBot, fetchImpl, () => Promise.resolve(), {
    warn: (m) => warnings.push(m),
  });

  assert.deepEqual(await transport.listMentions(["C1"]), []);
  // A second poll must not re-warn (one-time warning) and must still match nothing.
  assert.deepEqual(await transport.listMentions(["C1"]), []);

  assert.equal(fetchCalls, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /SLACK_BOT_USER_ID|bot_user_id/);
});

test("listMentions follows response_metadata.next_cursor across pages", async () => {
  const calls: Array<{ url: string }> = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push({ url: String(url) });
    const parsed = new URL(String(url));
    const cursor = parsed.searchParams.get("cursor");
    if (!cursor) {
      return new Response(
        JSON.stringify({
          ok: true,
          messages: [{ ts: "1.1", text: "<@U1> first page", reactions: [] }],
          response_metadata: { next_cursor: "CURSOR_2" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: "2.2", text: "<@U1> second page", reactions: [] }],
        response_metadata: { next_cursor: "" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl);
  const messages = await transport.listMentions(["C1"]);

  assert.deepEqual(
    messages.map((m) => m.ts),
    ["1.1", "2.2"],
  );
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0]!.url).searchParams.get("cursor"), null);
  assert.equal(new URL(calls[1]!.url).searchParams.get("cursor"), "CURSOR_2");
});

test("listMentions stops paging when next_cursor is empty", async () => {
  let pages = 0;
  const fetchImpl = (async () => {
    pages += 1;
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: `${pages}.0`, text: "<@U1> only page", reactions: [] }],
        response_metadata: { next_cursor: "" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl);
  const messages = await transport.listMentions(["C1"]);

  assert.equal(pages, 1);
  assert.deepEqual(
    messages.map((m) => m.ts),
    ["1.0"],
  );
});

test("listMentions isolates a failing channel: skips it, logs, and returns the rest", async () => {
  const fetchImpl = (async (url: string | URL) => {
    const channel = new URL(String(url)).searchParams.get("channel");
    if (channel === "C_BAD") {
      return new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: "2.2", text: "<@U1> from good channel", reactions: [] }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const warnings: string[] = [];
  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve(), {
    warn: (m) => warnings.push(m),
  });
  const messages = await transport.listMentions(["C_BAD", "C_GOOD"]);

  assert.deepEqual(
    messages.map((m) => m.ts),
    ["2.2"],
  );
  assert.equal(messages[0]!.channel, "C_GOOD");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /C_BAD/);
  assert.match(warnings[0]!, /not_in_channel/);
});

test("listMentions surfaces a partial first page from a channel that fails mid-pagination", async () => {
  const fetchImpl = (async (url: string | URL) => {
    const parsed = new URL(String(url));
    const cursor = parsed.searchParams.get("cursor");
    if (!cursor) {
      return new Response(
        JSON.stringify({
          ok: true,
          messages: [{ ts: "1.1", text: "<@U1> first page survives", reactions: [] }],
          response_metadata: { next_cursor: "CURSOR_2" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: false, error: "fatal_error" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const warnings: string[] = [];
  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve(), {
    warn: (m) => warnings.push(m),
  });
  const messages = await transport.listMentions(["C1"]);

  assert.deepEqual(
    messages.map((m) => m.ts),
    ["1.1"],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /C1/);
});

test("addReaction posts to reactions.add", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  await new SlackWebTransport(settings(), fetchImpl).addReaction("C1", "1.1", "eyes");
  assert.match(calls[0]!, /\/reactions\.add/);
});

test("get retries once on HTTP 429 honoring Retry-After then succeeds", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: "1.1", text: "<@U1> hi", reactions: [] }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  const messages = await transport.listMentions(["C1"]);

  assert.equal(calls, 2);
  assert.deepEqual(
    messages.map((m) => m.ts),
    ["1.1"],
  );
});

test("get gives up after the retry cap on a persistent 429 with a clear error", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "0" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  await assert.rejects(() => transport.listMentions(["C1"]), /conversations\.history.*429/);
  assert.equal(calls, 5);
});

test("post retries on HTTP 5xx with backoff then succeeds", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("server error", { status: 503 });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  await transport.addReaction("C1", "1.1", "eyes");

  assert.equal(calls, 2);
});

test("listMentions rejects with a method+status message on a non-JSON error body", async () => {
  const fetchImpl = (async () => {
    return new Response("<html><body>Bad Gateway</body></html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  await assert.rejects(() => transport.listMentions(["C1"]), /conversations\.history.*502/);
});

test("get surfaces a clear non-JSON error instead of a SyntaxError", async () => {
  const fetchImpl = (async () => {
    return new Response("<html>nope</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  let caught: unknown;
  try {
    await transport.listMentions(["C1"]);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, "expected an Error");
  assert.ok(!((caught as Error) instanceof SyntaxError), "should not leak a SyntaxError");
  assert.match((caught as Error).message, /conversations\.history/);
  assert.match((caught as Error).message, /non-JSON/);
  assert.match((caught as Error).message, /200/);
});

test("post rejects with a method+status message on a non-JSON 4xx body", async () => {
  const fetchImpl = (async () => {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  await assert.rejects(() => transport.addReaction("C1", "1.1", "eyes"), /reactions\.add.*401/);
});

test("request-path failures (abort/timeout) are annotated with the slack method", async () => {
  const fetchImpl = (async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  await assert.rejects(() => transport.listMentions(["C1"]), /conversations\.history.*timed out/);
});

test("getMessage requests a single inclusive message and parses the match", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: "1.1", text: "<@U1> hi", reactions: [{ name: "eyes", count: 1 }] }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl);
  const message = await transport.getMessage("C1", "1.1");

  assert.ok(message);
  assert.equal(message!.ts, "1.1");
  assert.equal(message!.channel, "C1");
  assert.deepEqual(message!.reactions, ["eyes"]);
  const url = new URL(calls[0]!);
  assert.match(url.pathname, /\/conversations\.history$/);
  assert.equal(url.searchParams.get("channel"), "C1");
  assert.equal(url.searchParams.get("latest"), "1.1");
  assert.equal(url.searchParams.get("inclusive"), "true");
  assert.equal(url.searchParams.get("limit"), "1");
});

test("getMessage returns null when no message matches the requested ts", async () => {
  const fetchImpl = (async () => {
    return new Response(
      JSON.stringify({ ok: true, messages: [{ ts: "9.9", text: "<@U1> other", reactions: [] }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl);
  assert.equal(await transport.getMessage("C1", "1.1"), null);
});

test("removeReaction posts the channel/timestamp/name to reactions.remove", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await new SlackWebTransport(settings(), fetchImpl).removeReaction("C1", "1.1", "eyes");

  assert.match(calls[0]!.url, /\/reactions\.remove$/);
  assert.deepEqual(calls[0]!.body, { channel: "C1", timestamp: "1.1", name: "eyes" });
});

test("postReply posts to chat.postMessage with thread_ts and text", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await new SlackWebTransport(settings(), fetchImpl).postReply("C1", "1.1", "done!");

  assert.match(calls[0]!.url, /\/chat\.postMessage$/);
  assert.deepEqual(calls[0]!.body, { channel: "C1", thread_ts: "1.1", text: "done!" });
});

test("a 200 response with ok:false surfaces the slack error reason", async () => {
  const fetchImpl = (async () => {
    return new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl);
  await assert.rejects(
    () => transport.postReply("C1", "1.1", "hi"),
    /chat\.postMessage failed: channel_not_found/,
  );
});
