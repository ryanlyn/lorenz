import { assert } from "@lorenz/test-utils";
import { test } from "vitest";

import { BOT_ID, CHANNEL_ID, USER_ID, message, parseDiscordConfig } from "./helpers.js";

import {
  InMemoryDiscordTransport,
  executeDiscordTool,
  type DiscordUser,
} from "@lorenz/discord-tracker";

test("status updates create the native thread and mirror only the bot's reactions", async () => {
  const settings = parseDiscordConfig();
  const root = message({
    id: "723456789012345678",
    reactions: [
      { emoji: "👀", me: true },
      { emoji: "✅", me: false },
    ],
  });
  const transport = new InMemoryDiscordTransport([root]);

  const result = await executeDiscordTool(
    "discord_update_status",
    { issueId: `${CHANNEL_ID}:${root.id}`, status: "Done" },
    settings,
    transport,
  );

  assert.equal(result.success, true);
  assert.deepEqual(transport.createdThreads, [root.id]);
  assert.deepEqual(transport.postedMessages, [{ threadId: root.id, body: "status: Done" }]);
  assert.deepEqual(transport.removedReactions, [
    { channelId: CHANNEL_ID, messageId: root.id, emoji: "👀" },
  ]);
  assert.deepEqual(transport.addedReactions, [
    { channelId: CHANNEL_ID, messageId: root.id, emoji: "✅" },
  ]);
});

test("Workpad tool posts structured rich content instead of flattening it into a comment", async () => {
  const settings = parseDiscordConfig();
  const root = message({ id: "723456789012345678" });
  const transport = new InMemoryDiscordTransport([root]);

  const result = await executeDiscordTool(
    "discord_workpad",
    {
      issueId: `${CHANNEL_ID}:${root.id}`,
      environment: "host:/workspace@abc1234",
      plan: ["Reproduce", "Implement"],
      acceptanceCriteria: ["Slash commands respond immediately"],
      validationCommands: ["mise run test"],
      progress: ["23:10 - reproduced"],
    },
    settings,
    transport,
  );

  assert.equal(result.success, true);
  assert.deepEqual(transport.createdThreads, [root.id]);
  assert.deepEqual(transport.postedMessages, []);
  assert.deepEqual(transport.postedWorkpads[0], {
    threadId: root.id,
    messageId: "900000000000000000",
    workpad: {
      environment: "host:/workspace@abc1234",
      plan: ["Reproduce", "Implement"],
      acceptanceCriteria: ["Slash commands respond immediately"],
      validationCommands: ["mise run test"],
      progress: ["23:10 - reproduced"],
    },
  });
});

test("comments, reads, queries, user lookups, and context stay inside the tracker scope", async () => {
  const settings = parseDiscordConfig();
  const root = message({ id: "723456789012345678", hasThread: true });
  const threadMessage = message({
    id: "823456789012345678",
    channelId: root.id,
    content: "progress note",
    authorId: BOT_ID,
    authorBot: true,
    mentionUserIds: [],
  });
  const user: DiscordUser = { id: USER_ID, username: "requester", globalName: "Requester" };
  const transport = new InMemoryDiscordTransport(
    [root],
    new Map([[root.id, [threadMessage]]]),
    new Map([[USER_ID, user]]),
  );
  const issueId = `${CHANNEL_ID}:${root.id}`;

  const comment = await executeDiscordTool(
    "discord_comment",
    { issueId, body: "working on it" },
    settings,
    transport,
  );
  assert.equal(comment.success, true);
  assert.deepEqual(transport.postedMessages, [{ threadId: root.id, body: "working on it" }]);

  const read = await executeDiscordTool("discord_read_thread", { issueId }, settings, transport);
  assert.equal(read.success, true);
  assert.match(JSON.stringify(read), /progress note/);

  const query = await executeDiscordTool(
    "discord_query",
    { expand: ["thread"] },
    settings,
    transport,
  );
  assert.equal(query.success, true);
  assert.match(JSON.stringify(query), /route-backend/);

  const lookup = await executeDiscordTool(
    "discord_user_info",
    { userId: USER_ID },
    settings,
    transport,
  );
  assert.match(JSON.stringify(lookup), /Requester/);

  const context = await executeDiscordTool(
    "discord_channel_context",
    { issueId },
    settings,
    transport,
  );
  assert.match(JSON.stringify(context), /investigate/);
});

test("tools reject unconfigured channels and non-mention messages", async () => {
  const settings = parseDiscordConfig();
  const untracked = message({
    id: "723456789012345678",
    content: "ordinary channel chatter",
    mentionUserIds: [],
  });
  const transport = new InMemoryDiscordTransport([untracked]);

  const result = await executeDiscordTool(
    "discord_comment",
    { issueId: `${CHANNEL_ID}:${untracked.id}`, body: "should not post" },
    settings,
    transport,
  );
  assert.equal(result.success, false);
  assert.match(JSON.stringify(result), /not a tracked Discord issue/);
  assert.deepEqual(transport.postedMessages, []);
});

test("tools reject malformed snowflakes and mismatched message identities before writing", async () => {
  const settings = parseDiscordConfig();
  const root = message({ id: "723456789012345678" });
  const transport = new InMemoryDiscordTransport([root]);
  let reads = 0;
  transport.getMessage = async () => {
    reads += 1;
    return message({ id: root.id, channelId: "623456789012345678" });
  };

  const malformed = await executeDiscordTool(
    "discord_comment",
    {
      issueId: `${CHANNEL_ID}:../../623456789012345678/messages/723456789012345678`,
      body: "must not post",
    },
    settings,
    transport,
  );
  assert.equal(malformed.success, false);
  assert.equal(reads, 0);

  const mismatched = await executeDiscordTool(
    "discord_comment",
    { issueId: `${CHANNEL_ID}:${root.id}`, body: "must not post" },
    settings,
    transport,
  );
  assert.equal(mismatched.success, false);
  assert.match(JSON.stringify(mismatched), /mismatched message/);
  assert.deepEqual(transport.postedMessages, []);

  const invalidUser = await executeDiscordTool(
    "discord_user_info",
    { userId: "../../channels/623456789012345678" },
    settings,
    transport,
  );
  assert.equal(invalidUser.success, false);
});

test("status tools only accept workflow-configured state names", async () => {
  const settings = parseDiscordConfig({ active_states: ["Open"], terminal_states: ["Closed"] });
  const root = message({ id: "723456789012345678" });
  const transport = new InMemoryDiscordTransport([root]);

  const rejected = await executeDiscordTool(
    "discord_update_status",
    { issueId: `${CHANNEL_ID}:${root.id}`, status: "Done" },
    settings,
    transport,
  );
  assert.equal(rejected.success, false);

  const accepted = await executeDiscordTool(
    "discord_update_status",
    { issueId: `${CHANNEL_ID}:${root.id}`, status: "Closed" },
    settings,
    transport,
  );
  assert.equal(accepted.success, true);
  assert.deepEqual(transport.postedMessages, [{ threadId: root.id, body: "status: Closed" }]);
});

test("comments cannot forge authoritative status records", async () => {
  const settings = parseDiscordConfig();
  const root = message({ id: "723456789012345678" });
  const transport = new InMemoryDiscordTransport([root]);

  const result = await executeDiscordTool(
    "discord_comment",
    { issueId: `${CHANNEL_ID}:${root.id}`, body: "status: Done" },
    settings,
    transport,
  );

  assert.equal(result.success, false);
  assert.match(JSON.stringify(result), /reserved 'status:' record/);

  const chunked = await executeDiscordTool(
    "discord_comment",
    {
      issueId: `${CHANNEL_ID}:${root.id}`,
      body: `${"a".repeat(1990)}\nstatus: Done`,
    },
    settings,
    transport,
  );
  assert.equal(chunked.success, false);
  assert.deepEqual(transport.postedMessages, []);
});
