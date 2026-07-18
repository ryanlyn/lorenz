import { assert } from "@lorenz/test-utils";
import { test } from "vitest";

import {
  BOT_ID,
  BOT_ROLE_ID,
  CHANNEL_ID,
  GUILD_ID,
  USER_ID,
  message,
  parseDiscordConfig,
} from "./helpers.js";

import {
  DiscordTrackerClient,
  InMemoryDiscordTransport,
  discordMessageToRow,
  stateFromThread,
} from "@lorenz/discord-tracker";

test("maps bot mentions to normalized issues with labels and Discord permalinks", async () => {
  const settings = parseDiscordConfig();
  const root = message({ id: "723456789012345678" });
  const client = new DiscordTrackerClient(settings, new InMemoryDiscordTransport([root]));

  const [issue] = await client.fetchCandidateIssues();
  assert.equal(issue?.id, `${CHANNEL_ID}:${root.id}`);
  assert.equal(issue?.identifier, `DSC-${CHANNEL_ID}-${root.id}`);
  assert.equal(issue?.title, "investigate #route-backend");
  assert.deepEqual(issue?.labels, ["route-backend"]);
  assert.equal(issue?.state, "Todo");
  assert.equal(issue?.url, `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${root.id}`);
});

test("maps the bot managed role mention to the same normalized issue", async () => {
  const settings = parseDiscordConfig();
  const root = message({
    id: "723456789012345678",
    content: `<@&${BOT_ROLE_ID}> investigate #route-backend`,
    mentionUserIds: [],
    mentionRoleIds: [BOT_ROLE_ID],
    botRoleIds: [BOT_ROLE_ID],
  });
  const client = new DiscordTrackerClient(settings, new InMemoryDiscordTransport([root]));

  const [issue] = await client.fetchCandidateIssues();
  assert.equal(issue?.title, "investigate #route-backend");
});

test("uses configured active and terminal states instead of the default Discord vocabulary", async () => {
  const settings = parseDiscordConfig({
    active_states: ["Open", "Working"],
    terminal_states: ["Closed"],
  });
  const root = message({
    id: "723456789012345678",
    reactions: [{ emoji: "✅", me: true }],
  });
  const command = message({
    id: "823456789012345678",
    channelId: root.id,
    content: `<@${BOT_ID}> !done`,
  });
  const client = new DiscordTrackerClient(settings, new InMemoryDiscordTransport([root]));

  assert.equal((await client.fetchCandidateIssues())[0]?.state, "Open");
  assert.equal(stateFromThread(root, [command], settings), "Closed");
});

test("Gateway wake-ups invalidate the REST scan cache", async () => {
  const settings = parseDiscordConfig();
  const transport = new InMemoryDiscordTransport([message({ id: "723456789012345678" })]);
  let gatewayChange: (() => void) | undefined;
  let changes = 0;
  const client = new DiscordTrackerClient(settings, transport, (options) => {
    gatewayChange = options.onChange;
    return { start() {}, close() {} };
  });
  const stream = client.watch(() => {
    changes += 1;
  });

  assert.equal((await client.fetchCandidateIssues()).length, 1);
  transport.messages.push(message({ id: "823456789012345678" }));
  gatewayChange?.();
  assert.equal(changes, 1);
  assert.equal((await client.fetchCandidateIssues()).length, 2);
  stream?.close();
});

test("issue fetches reject mismatched transport responses", async () => {
  const settings = parseDiscordConfig();
  const requested = message({ id: "723456789012345678" });
  const transport = new InMemoryDiscordTransport([requested]);
  transport.getMessage = async () => message({ id: requested.id, channelId: "623456789012345678" });
  const client = new DiscordTrackerClient(settings, transport);

  assert.deepEqual(await client.fetchIssuesByIds([`${CHANNEL_ID}:${requested.id}`]), []);
});

test("uses the native thread as authoritative state and filters candidate states", async () => {
  const settings = parseDiscordConfig();
  const todo = message({ id: "723456789012345678" });
  const done = message({ id: "823456789012345678", hasThread: true });
  const threads = new Map([
    [
      done.id,
      [
        message({
          id: "923456789012345678",
          channelId: done.id,
          content: "status: Done",
          authorId: BOT_ID,
          authorBot: true,
          mentionUserIds: [],
        }),
      ],
    ],
  ]);
  const client = new DiscordTrackerClient(
    settings,
    new InMemoryDiscordTransport([todo, done], threads),
  );

  assert.deepEqual(
    (await client.fetchCandidateIssues()).map((issue) => issue.id),
    [`${CHANNEL_ID}:${todo.id}`],
  );
  assert.equal((await client.fetchIssuesByIds([`${CHANNEL_ID}:${done.id}`]))[0]?.state, "Done");
});

test("human commands transition state and a later bare mention reopens terminal work", () => {
  const settings = parseDiscordConfig();
  const root = message({
    id: "723456789012345678",
    reactions: [{ emoji: "✅", me: true }],
  });
  const command = message({
    id: "823456789012345678",
    channelId: root.id,
    content: `<@${BOT_ID}> !cancel`,
  });
  assert.equal(stateFromThread(root, [command], settings), "Cancelled");

  const reopen = message({
    id: "923456789012345678",
    channelId: root.id,
    content: `<@${BOT_ID}> the failure is still happening`,
    authorId: USER_ID,
  });
  assert.equal(stateFromThread(root, [command, reopen], settings), "Todo");
});

test("human status commands accept the bot managed role mention", () => {
  const settings = parseDiscordConfig();
  const root = message({ id: "723456789012345678" });
  const command = message({
    id: "823456789012345678",
    channelId: root.id,
    content: `<@&${BOT_ROLE_ID}> !cancel`,
    mentionUserIds: [],
    mentionRoleIds: [BOT_ROLE_ID],
    botRoleIds: [BOT_ROLE_ID],
  });

  assert.equal(stateFromThread(root, [command], settings), "Cancelled");
});
test("only bot-owned reactions provide the fallback state", () => {
  const settings = parseDiscordConfig();
  const humanReaction = message({
    id: "723456789012345678",
    reactions: [{ emoji: "✅", me: false }],
  });
  const botReaction = message({
    id: "823456789012345678",
    reactions: [{ emoji: "✅", me: true }],
  });
  assert.equal(
    discordMessageToRow(humanReaction, settings, stateFromThread(humanReaction, [], settings))
      .state,
    "Todo",
  );
  assert.equal(stateFromThread(botReaction, [], settings), "Done");
});

test("polling resolves thread state and heals the visual reaction mirror in the background", async () => {
  const settings = parseDiscordConfig();
  const root = message({
    id: "723456789012345678",
    hasThread: true,
    reactions: [{ emoji: "✅", me: true }],
  });
  const reopen = message({
    id: "823456789012345678",
    channelId: root.id,
    content: `<@${BOT_ID}> this still needs work`,
  });
  const transport = new InMemoryDiscordTransport([root], new Map([[root.id, [reopen]]]));
  const client = new DiscordTrackerClient(settings, transport);

  const [issue] = await client.fetchCandidateIssues();

  assert.equal(issue?.state, "Todo");
  await client.flushStatusMirrorHeals();
  assert.deepEqual(transport.removedReactions, [
    { channelId: CHANNEL_ID, messageId: root.id, emoji: "✅" },
  ]);
  assert.deepEqual(transport.addedReactions, []);
});

test("dispatch acknowledgement immediately adds the In Progress reaction", async () => {
  const settings = parseDiscordConfig();
  const root = message({ id: "723456789012345678" });
  const transport = new InMemoryDiscordTransport([root]);
  const client = new DiscordTrackerClient(settings, transport);
  const [issue] = await client.fetchCandidateIssues();

  assert.equal(await client.acknowledgeIssue(issue!), true);
  assert.deepEqual(transport.postedMessages, []);
  assert.deepEqual(transport.addedReactions, [
    { channelId: CHANNEL_ID, messageId: root.id, emoji: "👀" },
  ]);

  const acknowledged = { ...issue!, state: "In Progress" };
  assert.equal(await client.acknowledgeIssue(acknowledged), false);
  assert.equal(transport.addedReactions.length, 1);
});

test("a blocked reaction heal never delays candidate discovery", async () => {
  const settings = parseDiscordConfig();
  const root = message({
    id: "723456789012345678",
    hasThread: true,
    reactions: [{ emoji: "✅", me: true }],
  });
  const reopen = message({
    id: "823456789012345678",
    channelId: root.id,
    content: `<@${BOT_ID}> this still needs work`,
  });
  const transport = new InMemoryDiscordTransport([root], new Map([[root.id, [reopen]]]));
  let releaseRemove!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseRemove = resolve;
  });
  const removeReaction = transport.removeReaction.bind(transport);
  transport.removeReaction = async (...args) => {
    await blocked;
    return removeReaction(...args);
  };
  const client = new DiscordTrackerClient(settings, transport);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(
    candidates.map((issue) => [issue.id, issue.state]),
    [[`${CHANNEL_ID}:${root.id}`, "Todo"]],
  );

  releaseRemove();
  await client.flushStatusMirrorHeals();
  assert.deepEqual(root.reactions, []);
});

test("reuses thread state until Discord reports a newer thread message", async () => {
  const settings = parseDiscordConfig();
  const inProgress = message({
    id: "823456789012345678",
    channelId: "723456789012345678",
    content: "status: In Progress",
    authorId: BOT_ID,
    authorBot: true,
    mentionUserIds: [],
  });
  const root = message({
    id: "723456789012345678",
    hasThread: true,
    threadLastMessageId: inProgress.id,
    reactions: [{ emoji: "👀", me: true }],
  });
  const thread = [inProgress];
  const transport = new InMemoryDiscordTransport([root], new Map([[root.id, thread]]));
  const getThread = transport.getThread.bind(transport);
  let reads = 0;
  transport.getThread = async (messageId) => {
    reads += 1;
    return getThread(messageId);
  };
  const client = new DiscordTrackerClient(settings, transport);

  assert.equal((await client.fetchCandidateIssues())[0]?.state, "In Progress");
  assert.equal((await client.fetchCandidateIssues())[0]?.state, "In Progress");
  assert.equal(reads, 1);

  const done = message({
    id: "923456789012345678",
    channelId: root.id,
    content: "status: Done",
    authorId: BOT_ID,
    authorBot: true,
    mentionUserIds: [],
  });
  thread.push(done);
  root.threadLastMessageId = done.id;
  assert.deepEqual(await client.fetchCandidateIssues(), []);
  assert.equal(reads, 2);
});

test("by-id reconciliation bypasses cached thread state", async () => {
  const settings = parseDiscordConfig();
  const status = message({
    id: "823456789012345678",
    channelId: "723456789012345678",
    content: "status: In Progress",
    authorId: BOT_ID,
    authorBot: true,
    mentionUserIds: [],
  });
  const root = message({
    id: "723456789012345678",
    hasThread: true,
    threadLastMessageId: status.id,
    reactions: [{ emoji: "👀", me: true }],
  });
  const transport = new InMemoryDiscordTransport([root], new Map([[root.id, [status]]]));
  const getThread = transport.getThread.bind(transport);
  let reads = 0;
  transport.getThread = async (messageId) => {
    reads += 1;
    return getThread(messageId);
  };
  const client = new DiscordTrackerClient(settings, transport);

  assert.equal((await client.fetchCandidateIssues())[0]?.state, "In Progress");
  status.content = "status: Done";
  assert.equal((await client.fetchIssuesByIds([`${CHANNEL_ID}:${root.id}`]))[0]?.state, "Done");
  assert.equal(reads, 2);
});
