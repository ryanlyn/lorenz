import { test } from "vitest";
import { assert } from "@symphony/test-utils";

import { parseSlackConfig } from "./helpers.js";

import { executeSlackTool, InMemorySlackTransport, slackToolSpecs } from "@symphony/slack-tracker";

function settings() {
  return parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
}

test("slack toolSpecs lists the status, comment, read, query, and context tools", () => {
  assert.deepEqual(
    slackToolSpecs().map((t) => t.name),
    [
      "slack_update_status",
      "slack_comment",
      "slack_read_thread",
      "slack_query",
      "slack_user_info",
      "slack_channel_context",
    ],
  );
});

test("slack_query lists bot-mention issues with derived state and labels", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      { ts: "1.1", text: "<@U1> fix the build #backend", reactions: ["eyes"] },
      { ts: "1.2", text: "<@U1> ship docs", reactions: ["white_check_mark"] },
      { ts: "1.3", text: "just chatter, no mention", reactions: [] },
    ],
  });

  const res = await executeSlackTool("slack_query", {}, settings(), transport);
  assert.equal(res.success, true);
  const result = res.result as {
    rows: Array<{ issueId: string; title: string; state: string; labels: string[] }>;
    total: number;
  };
  // The non-mention message is excluded by listMentions.
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.rows.map((r) => r.issueId),
    ["C1:1.1", "C1:1.2"],
  );
  assert.deepEqual(
    result.rows.map((r) => r.state),
    ["In Progress", "Done"],
  );
  assert.deepEqual(result.rows[0]!.labels, ["backend"]);
  // Default projection only: no text, reactions, or thread unless requested.
  assert.deepEqual(Object.keys(result.rows[0]!).sort(), ["issueId", "labels", "state", "title"]);
});

test("slack_query filters by state, then expands thread and reactions", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      {
        ts: "1.1",
        text: "<@U1> alpha",
        reactions: ["eyes"],
        replies: [{ ts: "1.1a", text: "working", user: "U2" }],
      },
      { ts: "1.2", text: "<@U1> beta", reactions: ["white_check_mark"] },
    ],
  });

  const res = await executeSlackTool(
    "slack_query",
    {
      where: { field: "state", op: "eq", value: "In Progress" },
      select: ["issueId", "text"],
      expand: ["thread", "reactions"],
    },
    settings(),
    transport,
  );
  assert.equal(res.success, true);
  const result = res.result as {
    rows: Array<{
      issueId: string;
      text: string;
      reactions: string[];
      thread: Array<{ text: string }>;
    }>;
    total: number;
  };
  assert.equal(result.total, 1);
  const row = result.rows[0]!;
  assert.equal(row.issueId, "C1:1.1");
  assert.equal(row.text, "<@U1> alpha");
  assert.deepEqual(row.reactions, ["eyes"]);
  assert.deepEqual(
    row.thread.map((t) => t.text),
    ["working"],
  );
});

test("slack_query only scans allow-listed channels (a requested channel is intersected)", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> allowed", reactions: [] }],
    C9: [{ ts: "9.1", text: "<@U1> off-limits", reactions: [] }],
  });

  // Requesting C9 (not in tracker.channels=["C1"]) yields nothing - it is dropped, never fetched.
  const offLimits = await executeSlackTool(
    "slack_query",
    { channels: ["C9"] },
    settings(),
    transport,
  );
  assert.equal((offLimits.result as { total: number }).total, 0);

  // The default (no channels arg) scans the allow-list only, never C9.
  const def = await executeSlackTool("slack_query", { select: ["issueId"] }, settings(), transport);
  assert.deepEqual(
    (def.result as { rows: Array<{ issueId: string }> }).rows.map((r) => r.issueId),
    ["C1:1.1"],
  );
});

test("slack_query rejects a malformed expand value", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> x", reactions: [] }],
  });

  const res = await executeSlackTool("slack_query", { expand: ["bogus"] }, settings(), transport);
  assert.equal(res.success, false);
  assert.match(res.error ?? "", /expand items/);
});

test("slack_read_thread returns text, derived status, reactions, and the thread replies", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      {
        ts: "1.1",
        text: "<@U1> do the thing",
        reactions: ["eyes"],
        replies: [{ ts: "1.2", text: "on it", user: "U2" }],
      },
    ],
  });

  const result = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:1.1" },
    settings(),
    transport,
  );

  assert.equal(result.success, true);
  assert.deepEqual(result.result, {
    issueId: "C1:1.1",
    status: "In Progress",
    text: "<@U1> do the thing",
    reactions: ["eyes"],
    permalink: "https://example.slack.com/archives/C1/p11",
    replies: [{ ts: "1.2", text: "on it", user: "U2" }],
  });
});

test("slack_read_thread reads back a reply posted via slack_comment", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["white_check_mark"] }],
  });

  const replied = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "all done" },
    settings(),
    transport,
  );
  assert.equal(replied.success, true);

  const read = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:1.1" },
    settings(),
    transport,
  );
  assert.equal(read.success, true);
  const result = read.result as {
    status: string;
    reactions: string[];
    replies: Array<{ text: string }>;
  };
  assert.equal(result.status, "Done");
  assert.deepEqual(result.reactions, ["white_check_mark"]);
  assert.deepEqual(
    result.replies.map((r) => r.text),
    ["all done"],
  );
});

test("slack_read_thread rejects a channel that is not in tracker.channels", async () => {
  const transport = new InMemorySlackTransport({
    C9: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C9:1.1" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /C9/);
});

test("slack_read_thread fails when no message exists at the issueId", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:9.9" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /no tracked issue/);
});

test("slack_read_thread fails when the message is not a bot mention", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "just chatting, no mention here", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:1.1" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not a tracked bot-mention/);
});

test("slack_update_status posts the authoritative status reply and mirrors the reaction", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }] },
    { botUserId: "U1" },
  );

  const moved = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
  );
  assert.equal(moved.success, true);
  assert.deepEqual(moved.result, { ok: true, status: "Done" });
  // The thread reply is the source of truth...
  assert.deepEqual(transport.replies, [{ channel: "C1", threadTs: "1.1", body: "status: Done" }]);
  // ...and the bot's reaction mirror tracks it for glanceability.
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["white_check_mark"]);

  const replied = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "done!" },
    settings(),
    transport,
  );
  assert.equal(replied.success, true);
  assert.deepEqual(transport.replies[1], { channel: "C1", threadTs: "1.1", body: "done!" });
});

test("slack_update_status resolves a case-variant status to the canonical name", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: [] }] },
    { botUserId: "U1" },
  );

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "done" },
    settings(),
    transport,
  );

  assert.equal(result.success, true);
  assert.equal((result.result as { status: string }).status, "Done");
  assert.deepEqual(transport.replies, [{ channel: "C1", threadTs: "1.1", body: "status: Done" }]);
});

test("slack_update_status rejects a status outside the workflow's states", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: [] }] },
    { botUserId: "U1" },
  );

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Shipped" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /unknown status 'Shipped'/);
  assert.deepEqual(transport.replies, []);
});

test("slack_update_status works for custom states with no mapped emoji", async () => {
  // The reaction swap used to fail without an emoji mapping; the thread reply carries the
  // state regardless, so custom states no longer require an emoji_states entry.
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.1", text: "<@U1> ship it", reactions: [] }] },
    { botUserId: "U1" },
  );
  const custom = parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1"],
        bot_user_id: "U1",
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Shipped"],
      },
    },
    { SLACK_BOT_TOKEN: "xoxb" },
  );

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Shipped" },
    custom,
    transport,
  );

  assert.equal(result.success, true);
  assert.deepEqual(transport.replies, [
    { channel: "C1", threadTs: "1.1", body: "status: Shipped" },
  ]);

  const read = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:1.1" },
    custom,
    transport,
  );
  assert.equal((read.result as { status: string }).status, "Shipped");
});

test("a failing reaction mirror never fails the status transition", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }] },
    { botUserId: "U1" },
  );
  transport.addReaction = async () => {
    throw new Error("reactions.add exploded");
  };
  transport.removeReaction = async () => {
    throw new Error("reactions.remove exploded");
  };

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
  );

  assert.equal(result.success, true);
  assert.deepEqual(transport.replies, [{ channel: "C1", threadTs: "1.1", body: "status: Done" }]);
});

test("a human command in the thread overrides the reaction reading", async () => {
  // Reactions are per-author: a human cannot remove the agent's :eyes:. The command thread
  // reply supersedes it.
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1.1",
          text: "<@U1> do the thing",
          reactions: ["eyes"],
          replies: [{ ts: "1.2", text: "<@U1> !done", user: "U_HUMAN" }],
        },
      ],
    },
    { botUserId: "U1" },
  );

  const read = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:1.1" },
    settings(),
    transport,
  );
  assert.equal((read.result as { status: string }).status, "Done");
});

test("a bare re-mention reopens a terminal issue to the default active state", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1.1",
          text: "<@U1> do the thing",
          reactions: ["white_check_mark"],
          replies: [
            { ts: "1.3", text: "<@U1> this broke again, take another look", user: "U_HUMAN" },
          ],
        },
      ],
    },
    { botUserId: "U1" },
  );

  const read = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:1.1" },
    settings(),
    transport,
  );
  assert.equal((read.result as { status: string }).status, "Todo");
});

test("slack_update_status rejects a channel that is not in tracker.channels", async () => {
  // Seed the disallowed channel with a real bot-mention message so the only failing guard is
  // the channel allow-list, and assert no reaction side effect occurred.
  const transport = new InMemorySlackTransport({
    C9: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C9:1.1", status: "Done" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /C9/);
  const msg = await transport.getMessage("C9", "1.1");
  assert.deepEqual(msg!.reactions, ["eyes"]);
});

test("slack_comment rejects a channel that is not in tracker.channels", async () => {
  const transport = new InMemorySlackTransport({
    C9: [{ ts: "1.1", text: "<@U1> do the thing", reactions: [] }],
  });

  const result = await executeSlackTool(
    "slack_comment",
    { issueId: "C9:1.1", body: "hi" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /C9/);
  assert.deepEqual(transport.replies, []);
});

test("slack_update_status fails when no message exists at the issueId", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:9.9", status: "Done" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /no tracked issue/);
});

test("slack_comment fails when no message exists at the issueId", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: [] }],
  });

  const result = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:9.9", body: "hi" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /no tracked issue/);
  assert.deepEqual(transport.replies, []);
});

test("slack_update_status fails when the message is not a bot mention", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "just chatting, no mention here", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not a tracked bot-mention/);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["eyes"]);
});

test("slack_comment fails when the message is not a bot mention", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "just chatting, no mention here", reactions: [] }],
  });

  const result = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "hi" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not a tracked bot-mention/);
  assert.deepEqual(transport.replies, []);
});

test("slack tools fail loudly when bot_user_id is not configured", async () => {
  // Settings can reach a mounted tool pack without dispatch validation. The transport fails
  // closed (scans nothing), so without this guard the agent would see a successful empty
  // result and conclude there is no work rather than a misconfigured tracker.
  const noBot = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"] } },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> tracked", reactions: [] }],
  });

  const query = await executeSlackTool("slack_query", {}, noBot, transport);
  assert.equal(query.success, false);
  assert.match(query.error ?? "", /bot_user_id/);

  const read = await executeSlackTool("slack_read_thread", { issueId: "C1:1.1" }, noBot, transport);
  assert.equal(read.success, false);
  assert.match(read.error ?? "", /bot_user_id/);
});

test("slack_user_info resolves a workspace member and fails on unknown ids", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [] },
    {
      botUserId: "U1",
      users: { U_HUMAN: { id: "U_HUMAN", name: "ryan", realName: "Ryan L", isBot: false } },
    },
  );

  const found = await executeSlackTool(
    "slack_user_info",
    { userId: "U_HUMAN" },
    settings(),
    transport,
  );
  assert.equal(found.success, true);
  assert.deepEqual(found.result, {
    user: { id: "U_HUMAN", name: "ryan", realName: "Ryan L", isBot: false },
  });

  const missing = await executeSlackTool(
    "slack_user_info",
    { userId: "U_NOPE" },
    settings(),
    transport,
  );
  assert.equal(missing.success, false);
  assert.match(missing.error ?? "", /unknown slack user/);
});

test("slack_channel_context reads the window around a tracked issue only", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        { ts: "1.0", text: "earlier chatter", user: "U_A", reactions: [] },
        { ts: "2.0", text: "more context", user: "U_B", reactions: [] },
        { ts: "3.0", text: "<@U1> fix the thing", user: "U_B", reactions: [] },
        { ts: "4.0", text: "after the ask", user: "U_A", reactions: [] },
      ],
    },
    { botUserId: "U1" },
  );

  const result = await executeSlackTool(
    "slack_channel_context",
    { issueId: "C1:3.0", before: 2, after: 5 },
    settings(),
    transport,
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.result, {
    anchor: "C1:3.0",
    messages: [
      { ts: "2.0", user: "U_B", text: "more context" },
      { ts: "3.0", user: "U_B", text: "<@U1> fix the thing" },
      { ts: "4.0", user: "U_A", text: "after the ask" },
    ],
  });

  // The anchor must be a tracked issue: surrounding chatter is not a free-roaming read.
  const untracked = await executeSlackTool(
    "slack_channel_context",
    { issueId: "C1:1.0" },
    settings(),
    transport,
  );
  assert.equal(untracked.success, false);
  assert.match(untracked.error ?? "", /not a tracked bot-mention issue/);
});

test("slack_query includes bot-marked reply-tracked threads with thread state", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        { ts: "1.1", text: "<@U1> mention-tracked", reactions: [] },
        {
          ts: "2.1",
          text: "background discussion",
          reactions: [],
          botReacted: true,
          replies: [
            { ts: "2.2", text: "<@U1> please handle #infra", user: "U_HUMAN" },
            { ts: "2.3", text: "status: In Progress", user: "U1" },
          ],
        },
      ],
    },
    { botUserId: "U1" },
  );

  const res = await executeSlackTool(
    "slack_query",
    { select: ["issueId", "title", "state"] },
    settings(),
    transport,
  );
  assert.equal(res.success, true);
  const rows = (res.result as { rows: Array<Record<string, unknown>> }).rows;
  assert.deepEqual(rows, [
    { issueId: "C1:1.1", title: "mention-tracked", state: "Todo" },
    { issueId: "C1:2.1", title: "please handle #infra", state: "In Progress" },
  ]);
});
