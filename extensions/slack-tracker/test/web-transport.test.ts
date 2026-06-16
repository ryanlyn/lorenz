import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { parseSlackConfig } from "./helpers.js";

import { SlackWebTransport } from "@lorenz/slack-tracker";

function settings() {
  return parseSlackConfig(
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

  const settingsWithBot = parseSlackConfig(
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

  // Build a slack settings object and then blank out the bot user id, since dispatch validation
  // requires one. This mirrors a misconfigured deployment where SLACK_BOT_USER_ID resolves empty.
  const noBot = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb-abc" },
  );
  delete noBot.tracker.options.botUserId;

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

test("listMentions returns all pages and emits NO truncation warning when history exhausts", async () => {
  // Three pages: the third has no next_cursor, the normal terminal condition (full exhaustion).
  // All three pages' mentions must be returned and the scan must NOT warn about truncation.
  let page = 0;
  const fetchImpl = (async () => {
    page += 1;
    const next_cursor = page < 3 ? `CURSOR_${page + 1}` : "";
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: `${page}.0`, text: "<@U1> page mention", reactions: [] }],
        response_metadata: { next_cursor },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const warnings: string[] = [];
  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve(), {
    warn: (m) => warnings.push(m),
  });
  const messages = await transport.listMentions(["C1"]);

  assert.equal(page, 3);
  assert.deepEqual(
    messages.map((m) => m.ts),
    ["1.0", "2.0", "3.0"],
  );
  assert.equal(warnings.length, 0);
});

test("listMentions warns LOUDLY (not silently) when the page cap is hit with a cursor still present", async () => {
  // A pathological channel whose next_cursor never empties: every page returns another cursor.
  // With a tiny injected cap, hitting the cap while a cursor is STILL present must emit exactly one
  // truncation warning naming the channel, rather than silently returning a partial scan.
  let pages = 0;
  const fetchImpl = (async () => {
    pages += 1;
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: `${pages}.0`, text: "<@U1> endless", reactions: [] }],
        response_metadata: { next_cursor: `CURSOR_${pages + 1}` },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const warnings: string[] = [];
  const transport = new SlackWebTransport(
    settings(),
    fetchImpl,
    () => Promise.resolve(),
    { warn: (m) => warnings.push(m) },
    { maxHistoryPages: 3 },
  );
  const messages = await transport.listMentions(["C1"]);

  // The cap bounds the scan to exactly maxHistoryPages requests; collected mentions still survive.
  assert.equal(pages, 3);
  assert.deepEqual(
    messages.map((m) => m.ts),
    ["1.0", "2.0", "3.0"],
  );
  // Exactly one loud warning, naming the channel and signaling truncation.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /C1/);
  assert.match(warnings[0]!, /truncat/i);
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

test("listMentions REJECTS when a single channel fails mid-pagination (no channel completed)", async () => {
  // Page 1 succeeds with a next_cursor; page 2 fails after the transport's retries. The first page
  // is a PARTIAL scan, not a complete one - every mention beyond the failed page would be invisible
  // to candidate discovery and terminal cleanup. With only one channel and that channel never
  // completing, listMentions must REJECT so the runtime records a poll_error rather than returning a
  // healthy-looking partial first page (this is the regression the round-9 finding caught).
  const fetchImpl = (async (url: string | URL) => {
    const parsed = new URL(String(url));
    const cursor = parsed.searchParams.get("cursor");
    if (!cursor) {
      return new Response(
        JSON.stringify({
          ok: true,
          messages: [{ ts: "1.1", text: "<@U1> first page does NOT survive", reactions: [] }],
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

  await assert.rejects(() => transport.listMentions(["C1"]), /C1.*fatal_error/);
  // The per-channel discard warning still fires (the channel is logged, not silently dropped).
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /C1/);
});

test("listMentions returns ONLY a fully-scanned channel's mentions when a sibling fails mid-pagination", async () => {
  // Channel A succeeds on page 1 (next_cursor present) then fails on page 2; channel B fully
  // exhausts in a single page. A never completes, so its partial buffer is DISCARDED and contributes
  // NOTHING; B completed, so listMentions RESOLVES with only B's mentions. A single failed channel
  // among several is logged (naming A), not thrown - preserving per-channel isolation.
  const fetchImpl = (async (url: string | URL) => {
    const parsed = new URL(String(url));
    const channel = parsed.searchParams.get("channel");
    const cursor = parsed.searchParams.get("cursor");
    if (channel === "C_A") {
      if (!cursor) {
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [{ ts: "A1.1", text: "<@U1> A page 1 discarded", reactions: [] }],
            response_metadata: { next_cursor: "CURSOR_A2" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: false, error: "fatal_error" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: "B1.1", text: "<@U1> B fully exhausts", reactions: [] }],
        response_metadata: { next_cursor: "" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const warnings: string[] = [];
  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve(), {
    warn: (m) => warnings.push(m),
  });
  const messages = await transport.listMentions(["C_A", "C_B"]);

  // Only B's mention is returned; A's partial first page contributes nothing.
  assert.deepEqual(
    messages.map((m) => m.ts),
    ["B1.1"],
  );
  assert.equal(messages[0]!.channel, "C_B");
  // Exactly one warning, naming the failed channel A.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /C_A/);
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
  // reactions.add is idempotent, so retrying after an ambiguous 5xx is allowed.
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

test("addReaction treats already_reacted as success (idempotent re-apply resolves)", async () => {
  // Slack returns ok:false error:"already_reacted" when the reaction is already present. The GOAL
  // (reaction present) is satisfied, so addReaction must RESOLVE rather than throw. This is what
  // lets an idempotent retry after an ambiguous 5xx that actually applied resolve cleanly instead
  // of reporting a failure while the target reaction is in fact present.
  const fetchImpl = (async () => {
    return new Response(JSON.stringify({ ok: false, error: "already_reacted" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  // Resolves (no throw): the reaction is present, which is the goal.
  await transport.addReaction("C1", "1.1", "eyes");
});

test("removeReaction treats no_reaction as success (already absent resolves)", async () => {
  // Slack returns ok:false error:"no_reaction" when the reaction is already absent. The GOAL
  // (reaction absent) is satisfied, so removeReaction must RESOLVE rather than throw.
  const fetchImpl = (async () => {
    return new Response(JSON.stringify({ ok: false, error: "no_reaction" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  await transport.removeReaction("C1", "1.1", "eyes");
});

test("addReaction retries on a 5xx then succeeds (idempotent retry allowed)", async () => {
  // reactions.add is idempotent: a 5xx (ambiguous - may or may not have applied) is safe to retry
  // because re-applying is harmless. First call 5xx, second call 200 -> two fetches, resolves.
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("server error", { status: 502 });
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

test("chat.postMessage does NOT retry on a 5xx (ambiguous - reply may have posted) and surfaces failure", async () => {
  // chat.postMessage is NON-idempotent: a retry would post a DUPLICATE reply. A 5xx is AMBIGUOUS
  // (the reply may already have been delivered), so the transport must NOT retry - it makes exactly
  // ONE fetch to chat.postMessage and surfaces a clear failure rather than risk a duplicate.
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("server error", { status: 503 });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  await assert.rejects(() => transport.postReply("C1", "1.1", "done!"), /chat\.postMessage.*503/);
  // Exactly one fetch: no retry on the ambiguous 5xx, so no possibility of a duplicate reply.
  assert.equal(calls, 1);
});

test("chat.postMessage retries on a 429 then succeeds (pre-processing rejection is safe)", async () => {
  // A 429 means Slack rejected the request BEFORE processing - no reply was posted - so retrying
  // cannot duplicate. chat.postMessage may retry exactly on 429: first 429, then 200 -> two fetches.
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, () => Promise.resolve());
  await transport.postReply("C1", "1.1", "done!");

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

test("getThread reads conversations.replies and drops the parent message", async () => {
  const calls: Array<{ url: string }> = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push({ url: String(url) });
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [
          { ts: "1.1", text: "<@U1> the root", reactions: [{ name: "eyes" }] },
          { ts: "1.2", text: "first reply", user: "U_HUMAN" },
          { ts: "1.3", text: "second reply" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const replies = await new SlackWebTransport(settings(), fetchImpl).getThread("C1", "1.1");

  // The parent (ts === thread ts) is dropped; only the replies remain, with user when present.
  assert.deepEqual(replies, [
    { ts: "1.2", text: "first reply", user: "U_HUMAN" },
    { ts: "1.3", text: "second reply" },
  ]);
  assert.match(calls[0]!.url, /\/conversations\.replies\?/);
  assert.match(calls[0]!.url, /channel=C1/);
  assert.match(calls[0]!.url, /ts=1\.1/);
});

test("getThread follows next_cursor across pages, excluding the parent on each page", async () => {
  const calls: Array<{ url: string }> = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push({ url: String(url) });
    const cursor = new URL(String(url)).searchParams.get("cursor");
    if (!cursor) {
      return new Response(
        JSON.stringify({
          ok: true,
          messages: [
            { ts: "1.1", text: "<@U1> root", reactions: [] },
            { ts: "1.2", text: "reply one" },
          ],
          response_metadata: { next_cursor: "CURSOR_2" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: "1.3", text: "reply two" }],
        response_metadata: { next_cursor: "" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const replies = await new SlackWebTransport(settings(), fetchImpl).getThread("C1", "1.1");

  assert.deepEqual(
    replies.map((r) => r.text),
    ["reply one", "reply two"],
  );
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1]!.url).searchParams.get("cursor"), "CURSOR_2");
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

test("a hostile Retry-After header is capped instead of parking the poll for hours", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("{}", { status: 429, headers: { "retry-after": "86400" } });
    }
    return new Response(JSON.stringify({ ok: true, messages: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(settings(), fetchImpl, async (ms) => {
    sleeps.push(ms);
  });
  await transport.listMentions(["C1"]);

  // The 24h header is honored in direction but bounded: an un-abortable multi-hour sleep
  // would hang the serial poll loop and every agent tool call behind it.
  assert.deepEqual(sleeps, [60_000]);
});

test("getThread warns when the page cap truncates a thread", async () => {
  const fetchImpl = (async () => {
    return new Response(
      JSON.stringify({
        ok: true,
        messages: [{ ts: "1.9", text: "reply", user: "U2" }],
        response_metadata: { next_cursor: "MORE" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const warnings: string[] = [];
  const transport = new SlackWebTransport(
    settings(),
    fetchImpl,
    () => Promise.resolve(),
    { warn: (m) => warnings.push(m) },
    { maxHistoryPages: 2 },
  );
  const replies = await transport.getThread("C1", "1.1");

  // Same loud-truncation contract as the history scan: a silently partial thread would let a
  // continuation agent recover incomplete progress notes with no signal.
  assert.equal(replies.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /truncated thread/);
});

test("teamUrl reports the auth.test workspace URL and caches it per token", async () => {
  let calls = 0;
  const fetchImpl = (async (url: string | URL) => {
    assert.match(String(url), /auth\.test/);
    calls += 1;
    return new Response(JSON.stringify({ ok: true, url: "https://acme.slack.com/" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const transport = new SlackWebTransport(
    parseSlackConfig(
      { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
      { SLACK_BOT_TOKEN: "xoxb-team-url-test" },
    ),
    fetchImpl,
  );
  assert.equal(await transport.teamUrl(), "https://acme.slack.com");
  assert.equal(await transport.teamUrl(), "https://acme.slack.com");
  assert.equal(calls, 1);
});
