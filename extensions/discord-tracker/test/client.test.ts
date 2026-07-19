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
  type DiscordInteraction,
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
    content: "status: Closed",
    authorId: BOT_ID,
    authorBot: true,
    mentionUserIds: [],
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
  await Promise.resolve();
  assert.deepEqual(
    transport.registeredCommands.map((command) => command.name),
    ["status", "Track with Lorenz", "done", "cancel", "reopen", "start"],
  );
  stream?.close();
});

test("slash commands defer immediately and write authoritative status in the issue thread", async () => {
  const settings = parseDiscordConfig();
  const root = message({ id: "723456789012345678", hasThread: true });
  const transport = new InMemoryDiscordTransport([root]);
  const client = new DiscordTrackerClient(settings, transport);

  const changed = await client.handleInteraction(
    interaction({ channelId: root.id, commandName: "done" }),
  );

  assert.equal(changed, true);
  assert.deepEqual(transport.deferredInteractions, [
    { interactionId: "623456789012345678", interactionToken: "interaction-token" },
  ]);
  assert.deepEqual(transport.postedMessages, [{ threadId: root.id, body: "status: Done" }]);
  assert.deepEqual(transport.addedReactions, [
    { channelId: CHANNEL_ID, messageId: root.id, emoji: "✅" },
  ]);
  assert.deepEqual(transport.completedInteractions[0]?.result, {
    title: "Status updated",
    description: "This issue is now **Done**.",
    color: 0x57f287,
  });
});

test("message context command tracks existing channel messages without requiring a mention", async () => {
  const settings = parseDiscordConfig();
  const root = message({
    id: "723456789012345678",
    content: "investigate the intermittent timeout",
    mentionUserIds: [],
  });
  const transport = new InMemoryDiscordTransport([root]);
  const client = new DiscordTrackerClient(settings, transport);

  const changed = await client.handleInteraction(
    interaction({ commandName: "Track with Lorenz", targetId: root.id }),
  );

  assert.equal(changed, true);
  assert.deepEqual(transport.addedReactions, [
    { channelId: CHANNEL_ID, messageId: root.id, emoji: "🤖" },
  ]);
  assert.deepEqual(transport.createdThreads, [root.id]);
  assert.deepEqual(transport.postedMessages, [{ threadId: root.id, body: "status: Todo" }]);
  transport.scanChannels = async () => {
    throw new Error("the immediate interaction candidate must not wait for a historical scan");
  };
  assert.deepEqual(
    (await client.fetchCandidateIssues()).map((issue) => issue.id),
    [`${CHANNEL_ID}:${root.id}`],
  );
  assert.equal(
    (await client.fetchIssuesByIds([`${CHANNEL_ID}:${root.id}`]))[0]?.title,
    "investigate the intermittent timeout",
  );
});

test("message context command is idempotent for an already tracked message", async () => {
  const settings = parseDiscordConfig();
  const root = message({
    id: "723456789012345678",
    content: "investigate the intermittent timeout",
    mentionUserIds: [],
    reactions: [{ emoji: "🤖", me: true }],
    hasThread: true,
  });
  const transport = new InMemoryDiscordTransport([root], new Map([[root.id, []]]));
  const client = new DiscordTrackerClient(settings, transport);

  const changed = await client.handleInteraction(
    interaction({ commandName: "Track with Lorenz", targetId: root.id }),
  );

  assert.equal(changed, false);
  assert.deepEqual(transport.addedReactions, []);
  assert.deepEqual(transport.postedMessages, []);
  assert.equal(transport.completedInteractions[0]?.result.title, "Already tracked");
});

test("slash commands fail privately outside an issue thread and do not mutate state", async () => {
  const transport = new InMemoryDiscordTransport();
  const client = new DiscordTrackerClient(parseDiscordConfig(), transport);

  const changed = await client.handleInteraction(interaction({ commandName: "cancel" }));

  assert.equal(changed, false);
  assert.deepEqual(transport.postedMessages, []);
  assert.equal(
    transport.completedInteractions[0]?.result.title,
    "Lorenz could not apply that action",
  );
  assert.match(
    transport.completedInteractions[0]?.result.description ?? "",
    /inside a Lorenz issue thread/,
  );
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

test("a later bare mention continues terminal work in progress", () => {
  const settings = parseDiscordConfig();
  const root = message({
    id: "723456789012345678",
    reactions: [{ emoji: "✅", me: true }],
  });
  const reopen = message({
    id: "823456789012345678",
    channelId: root.id,
    content: `<@${BOT_ID}> the failure is still happening`,
    authorId: USER_ID,
  });
  assert.equal(stateFromThread(root, [reopen], settings), "In Progress");
});

test("a bare managed-role mention also continues terminal work in progress", () => {
  const settings = parseDiscordConfig();
  const root = message({
    id: "723456789012345678",
    reactions: [{ emoji: "✅", me: true }],
  });
  const reopen = message({
    id: "823456789012345678",
    channelId: root.id,
    content: `<@&${BOT_ROLE_ID}> this needs another pass`,
    mentionUserIds: [],
    mentionRoleIds: [BOT_ROLE_ID],
    botRoleIds: [BOT_ROLE_ID],
  });

  assert.equal(stateFromThread(root, [reopen], settings), "In Progress");
});

test("a bare mention folds todo work into progress", () => {
  const settings = parseDiscordConfig();
  const root = message({ id: "723456789012345678" });
  const continuation = message({
    id: "823456789012345678",
    channelId: root.id,
    content: `<@${BOT_ID}> keep going with the investigation`,
  });

  assert.equal(stateFromThread(root, [continuation], settings), "In Progress");
});

test("a bare mention uses the configured in-progress state", () => {
  const settings = parseDiscordConfig({
    active_states: ["Open", "Working"],
    terminal_states: ["Closed"],
  });
  const root = message({ id: "723456789012345678" });
  const continuation = message({
    id: "823456789012345678",
    channelId: root.id,
    content: `<@${BOT_ID}> continue`,
  });

  assert.equal(stateFromThread(root, [continuation], settings), "Working");
});

test("a bare mention from a disallowed author does not change state", () => {
  const settings = parseDiscordConfig({ users: ["623456789012345678"] });
  const root = message({ id: "723456789012345678" });
  const continuation = message({
    id: "823456789012345678",
    channelId: root.id,
    content: `<@${BOT_ID}> continue`,
    authorId: USER_ID,
  });

  assert.equal(stateFromThread(root, [continuation], settings), "Todo");
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

  assert.equal(issue?.state, "In Progress");
  await client.flushStatusMirrorHeals();
  assert.deepEqual(transport.removedReactions, [
    { channelId: CHANNEL_ID, messageId: root.id, emoji: "✅" },
  ]);
  assert.deepEqual(transport.addedReactions, [
    { channelId: CHANNEL_ID, messageId: root.id, emoji: "👀" },
  ]);
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
    [[`${CHANNEL_ID}:${root.id}`, "In Progress"]],
  );

  releaseRemove();
  await client.flushStatusMirrorHeals();
  assert.deepEqual(root.reactions, [{ emoji: "👀", me: true }]);
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

function interaction(overrides: Partial<DiscordInteraction> = {}): DiscordInteraction {
  return {
    id: "623456789012345678",
    applicationId: "323456789012345678",
    token: "interaction-token",
    type: "command",
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    userId: USER_ID,
    userBot: false,
    ...overrides,
  };
}
