import { test } from "vitest";
import { parseConfig } from "@symphony/config";

import { assert } from "../../../test/assert.js";

import { SlackWebTransport } from "@symphony/slack-tracker";

function settings() {
  return parseConfig(
    { tracker: { kind: "slack", channels: ["C1"] } },
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
