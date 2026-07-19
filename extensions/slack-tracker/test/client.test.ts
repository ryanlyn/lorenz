import { test } from "vitest";
import { trackerIssueEventsBytes, type TrackerChange } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";

import { parseSlackConfig } from "./helpers.js";

import {
  InMemorySlackTransport,
  SlackTrackerClient,
  type SlackSocketMode,
  type SlackSocketModeOptions,
} from "@lorenz/slack-tracker";

function settings() {
  return parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1"],
        bot_user_id: "U_BOT",
        active_states: ["Todo", "In Progress"],
      },
    },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
}

function botSettings() {
  return parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1"],
        bot_user_id: "U_BOT",
        active_states: ["Todo", "In Progress"],
      },
    },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
}

test("mentions become issues; the bot's reactions drive state", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      { ts: "1700000000.000100", text: "<@U_BOT> fix the flaky test\nmore detail", reactions: [] },
      { ts: "1700000000.000200", text: "<@U_BOT> ship docs", reactions: ["white_check_mark"] },
    ],
  });
  const client = new SlackTrackerClient(settings(), transport);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(
    candidates.map((i) => i.title),
    ["fix the flaky test"],
  );
  assert.equal(candidates[0]!.id, "C1:1700000000.000100");
  assert.equal(candidates[0]!.state, "Todo");
  assert.equal(candidates[0]!.description, "<@U_BOT> fix the flaky test\nmore detail");
  assert.equal(candidates[0]!.issueEventCursor, "0");

  const byId = await client.fetchIssuesByIds(["C1:1700000000.000200"]);
  assert.deepEqual(
    byId.map((i) => i.state),
    ["Done"],
  );
});

test("piped mention form <@U_BOT|worker> is detected and stripped from the title", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1700000000.000300", text: "<@U_BOT|worker> do it", reactions: [] }],
  });
  const client = new SlackTrackerClient(settings(), transport);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(
    candidates.map((i) => i.title),
    ["do it"],
  );
});

test("hashtag tokens in the message become deduped, lowercased labels", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      { ts: "1700000000.000400", text: "<@U_BOT> fix the build #backend #Urgent", reactions: [] },
    ],
  });
  const client = new SlackTrackerClient(settings(), transport);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(candidates[0]!.labels, ["backend", "urgent"]);
});

test("channel references and user mentions are not mistaken for hashtag labels", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1700000000.000450", text: "<@U1> see <#C0ABC|general> #backend", reactions: [] }],
  });
  const client = new SlackTrackerClient(settings(), transport);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(candidates[0]!.labels, ["backend"]);
});

test("in-token '#' (hex colors, URL fragments) does not leak as a bogus label", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      {
        ts: "1700000000.000475",
        text: "<@U_BOT> fix color:#fff see http://x#frag then #Backend and #api",
        reactions: [],
      },
    ],
  });
  const client = new SlackTrackerClient(settings(), transport);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(candidates[0]!.labels, ["backend", "api"]);
});

test("a message with no hashtags yields no labels", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1700000000.000500", text: "<@U_BOT> fix the build", reactions: [] }],
  });
  const client = new SlackTrackerClient(settings(), transport);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(candidates[0]!.labels, []);
});

test("fetchIssuesByIds re-validates channel and bot mention (refresh-path trust boundary)", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        { ts: "1700000000.000600", text: "<@U_BOT> still tracked", reactions: ["eyes"] },
        // A HUMAN's reaction: with the mention edited away and no bot marker, the issue is gone.
        { ts: "1700000000.000700", text: "<@U_OTHER> mention removed", humanReactions: ["eyes"] },
      ],
      C9: [{ ts: "1700000000.000800", text: "<@U_BOT> wrong channel", reactions: ["eyes"] }],
    },
    { botUserId: "U_BOT" },
  );
  const client = new SlackTrackerClient(botSettings(), transport);

  // Still a bot mention in a configured channel -> returned.
  assert.deepEqual(
    (await client.fetchIssuesByIds(["C1:1700000000.000600"])).map((i) => i.id),
    ["C1:1700000000.000600"],
  );
  // Bot mention edited away -> reconciles as gone (no issue), not still active.
  assert.deepEqual(await client.fetchIssuesByIds(["C1:1700000000.000700"]), []);
  // Id whose channel is not in tracker.channels -> rejected even though the bot is mentioned.
  assert.deepEqual(await client.fetchIssuesByIds(["C9:1700000000.000800"]), []);
});

test("InMemorySlackTransport getThread returns seeded replies and a posted reply is read back", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      {
        ts: "1700000000.000100",
        text: "<@U_BOT> do it",
        reactions: ["eyes"],
        replies: [{ ts: "1700000000.000101", text: "first", user: "U_HUMAN" }],
      },
    ],
  });

  // The parent message is excluded; only the seeded reply is returned.
  assert.deepEqual(await transport.getThread("C1", "1700000000.000100"), [
    { ts: "1700000000.000101", text: "first", user: "U_HUMAN" },
  ]);

  // A posted reply is appended to the thread and can be read back.
  await transport.postReply("C1", "1700000000.000100", "second");
  const after = await transport.getThread("C1", "1700000000.000100");
  assert.deepEqual(
    after.map((r) => r.text),
    ["first", "second"],
  );

  // An unknown / non-parent ts yields an empty thread.
  assert.deepEqual(await transport.getThread("C1", "9.9"), []);

  const controller = new AbortController();
  controller.abort(new Error("stop thread recovery"));
  await assert.rejects(
    () => transport.getThread("C1", "1700000000.000100", controller.signal),
    /stop thread recovery/,
  );
});

test("with botUserId only mentions of the bot become candidates", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        { ts: "1700000000.000100", text: "<@U_OTHER> human chatter", reactions: [] },
        { ts: "1700000000.000200", text: "<@U_BOT> handle this", reactions: [] },
        { ts: "1700000000.000300", text: "<@U_BOT|worker> and this", reactions: [] },
      ],
    },
    { botUserId: "U_BOT" },
  );
  const client = new SlackTrackerClient(botSettings(), transport);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(
    candidates.map((i) => i.title),
    ["handle this", "and this"],
  );
  assert.deepEqual(
    candidates.map((i) => i.id),
    ["C1:1700000000.000200", "C1:1700000000.000300"],
  );
});

function allowlistSettings() {
  return parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1"],
        bot_user_id: "U_BOT",
        users: ["U_ALICE"],
        active_states: ["Todo", "In Progress"],
      },
    },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
}

test("tracker.users constrains candidate mentions to allowed authors (fail closed on unknown author)", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        { ts: "1700000000.000100", text: "<@U_BOT> from alice", user: "U_ALICE", reactions: [] },
        { ts: "1700000000.000200", text: "<@U_BOT> from bob", user: "U_BOB", reactions: [] },
        { ts: "1700000000.000300", text: "<@U_BOT> no author", reactions: [] },
      ],
    },
    { botUserId: "U_BOT", allowedUsers: ["U_ALICE"] },
  );
  const client = new SlackTrackerClient(allowlistSettings(), transport);

  // Only the allowed author's mention becomes an issue; a non-allowed author and a message with
  // no known author are both dropped.
  assert.deepEqual(
    (await client.fetchCandidateIssues()).map((i) => i.id),
    ["C1:1700000000.000100"],
  );
});

test("tracker.users gates reply-mention tracking by the request reply's author", async () => {
  const now = Date.now() / 1000;
  const rootA = `${(now - 3600).toFixed(6)}`;
  const rootB = `${(now - 3000).toFixed(6)}`;
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: rootA,
          text: "some discussion",
          reactions: [],
          replies: [
            { ts: `${(now - 1800).toFixed(6)}`, text: "<@U_BOT> please do it", user: "U_BOB" },
          ],
        },
        {
          ts: rootB,
          text: "other discussion",
          reactions: [],
          replies: [
            { ts: `${(now - 1700).toFixed(6)}`, text: "<@U_BOT> handle this", user: "U_ALICE" },
          ],
        },
      ],
    },
    { botUserId: "U_BOT", allowedUsers: ["U_ALICE"] },
  );
  const client = new SlackTrackerClient(allowlistSettings(), transport);

  // A bot-mention reply from a non-allowed author does not create an issue; only the thread whose
  // request reply is from an allowed author is tracked.
  assert.deepEqual(
    (await client.fetchCandidateIssues()).map((i) => i.id),
    [`C1:${rootB}`],
  );
});

test("tracker.users gates the tool trust boundary, but a bot-marked root stays tracked", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1700000000.000100",
          text: "<@U_BOT> from alice",
          user: "U_ALICE",
          reactions: ["eyes"],
        },
        // A HUMAN's :eyes:, not a bot marker: does not keep a non-allowed author tracked.
        {
          ts: "1700000000.000200",
          text: "<@U_BOT> from bob",
          user: "U_BOB",
          humanReactions: ["eyes"],
        },
        // Author not allowed, but the bot already marked it on an earlier poll: stays tracked so a
        // later tightening of `users` does not orphan an in-flight issue.
        {
          ts: "1700000000.000300",
          text: "<@U_BOT> from carol",
          user: "U_CAROL",
          reactions: ["eyes"],
        },
      ],
    },
    { botUserId: "U_BOT", allowedUsers: ["U_ALICE"] },
  );
  const client = new SlackTrackerClient(allowlistSettings(), transport);

  assert.deepEqual(
    (await client.fetchIssuesByIds(["C1:1700000000.000100"])).map((i) => i.id),
    ["C1:1700000000.000100"],
  );
  // Non-allowed author with no bot marker -> reconciles as gone.
  assert.deepEqual(await client.fetchIssuesByIds(["C1:1700000000.000200"]), []);
  // Non-allowed author the bot already marked -> still tracked.
  assert.deepEqual(
    (await client.fetchIssuesByIds(["C1:1700000000.000300"])).map((i) => i.id),
    ["C1:1700000000.000300"],
  );
});

test("issue identifiers keep the channel: equal ts values in two channels stay distinct", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1700000000.000100", text: "<@U_BOT> in channel one", reactions: [] }],
    C2: [{ ts: "1700000000.000100", text: "<@U_BOT> in channel two", reactions: [] }],
  });
  const settings = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1", "C2"], active_states: ["Todo"] } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  const client = new SlackTrackerClient(settings, transport);

  const identifiers = (await client.fetchCandidateIssues()).map((i) => i.identifier);
  // Workspace directories and terminal cleanup are keyed by identifier downstream, so a
  // cross-channel ts collision must not collapse two issues into one workspace.
  assert.deepEqual(identifiers, ["SLK-C1-1700000000-000100", "SLK-C2-1700000000-000100"]);
});

test("issues carry a permalink and creation time derived from the message", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1700000000.000100", text: "<@U_BOT> link me", reactions: [] }],
  });
  const client = new SlackTrackerClient(settings(), transport);

  const [issue] = await client.fetchCandidateIssues();
  assert.equal(issue!.url, "https://example.slack.com/archives/C1/p1700000000000100");
  assert.equal(issue!.createdAt, new Date(1700000000000).toISOString());
});

test("hashtags inside link captions are not labels", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      {
        ts: "1700000000.000600",
        text: "<@U_BOT> see <https://wiki/x|the #route-prod runbook> then fix #backend",
        reactions: [],
      },
    ],
  });
  const client = new SlackTrackerClient(settings(), transport);

  const candidates = await client.fetchCandidateIssues();
  // The link caption's hashtag must not leak in as a label (it could even become a dispatch
  // route); the plain-text hashtag outside the link still does.
  assert.deepEqual(candidates[0]!.labels, ["backend"]);
});

test("one mention scan serves the back-to-back reads of a single poll cycle", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1700000000.000700", text: "<@U_BOT> cache me", reactions: [] }],
  });
  let scans = 0;
  const original = transport.scanChannels.bind(transport);
  transport.scanChannels = async (channels) => {
    scans += 1;
    return original(channels);
  };
  const client = new SlackTrackerClient(settings(), transport);

  // The runtime triggers terminal-state reconciliation and candidate discovery back-to-back
  // in one cycle; both must share a single full-history scan.
  await client.fetchIssuesByStates(["Done", "Cancelled"]);
  await client.fetchCandidateIssues();
  assert.equal(scans, 1);
});

test("a bot mention in a reply tracks the thread: request title, marker, restart survival", async () => {
  const now = Date.now() / 1000;
  const rootTs = `${(now - 3600).toFixed(6)}`;
  const replyTs = `${(now - 1800).toFixed(6)}`;
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: rootTs,
          text: "we're seeing flaky deploys in prod",
          reactions: [],
          replies: [{ ts: replyTs, text: "<@U_BOT> please fix this #backend", user: "U_HUMAN" }],
        },
      ],
    },
    { botUserId: "U_BOT" },
  );
  const client = new SlackTrackerClient(settings(), transport);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(
    candidates.map((i) => i.id),
    [`C1:${rootTs}`],
  );
  // The request reply carries the ask: title and routing labels come from it.
  assert.equal(candidates[0]!.title, "please fix this #backend");
  assert.deepEqual(candidates[0]!.labels, ["backend"]);
  assert.match(candidates[0]!.description ?? "", /flaky deploys in prod/);
  assert.equal(candidates[0]!.issueEventCursor, replyTs);
  // The bot marked the root so the thread stays tracked without re-reading replies.
  assert.ok((await transport.getMessage("C1", rootTs))!.botReactions.includes("robot_face"));

  // A fresh client (daemon restart) recognizes the marker even with an expired lookback.
  const restarted = new SlackTrackerClient(
    parseSlackConfig(
      {
        tracker: {
          kind: "slack",
          channels: ["C1"],
          bot_user_id: "U_BOT",
          reply_lookback_days: 0,
          active_states: ["Todo", "In Progress"],
        },
      },
      { SLACK_BOT_TOKEN: "xoxb-test" },
    ),
    transport,
  );
  assert.deepEqual(
    (await restarted.fetchCandidateIssues()).map((i) => i.id),
    [`C1:${rootTs}`],
  );
});

test("untracked threads older than the reply lookback are not inspected", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1000.000100",
          text: "ancient conversation",
          reactions: [],
          replies: [{ ts: "1000.000200", text: "<@U_BOT> old request", user: "U_HUMAN" }],
        },
      ],
    },
    { botUserId: "U_BOT" },
  );
  const client = new SlackTrackerClient(settings(), transport);

  // The reply ts (epoch ~1000s) is far older than the 2-day lookback floor.
  assert.deepEqual(await client.fetchCandidateIssues(), []);
});

test("the bot's reaction mirror self-heals after a human command", async () => {
  // A human `!done` changes the derived state, but the bot's stale :eyes: mirror lingers
  // until the bot acts. The poll reconciles the mirror to the thread-derived state - once
  // per state change, not on every poll (re-attempting would churn the API while the
  // background queue drains, or forever when a mapped emoji cannot be added).
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1700000000.000100",
          text: "<@U_BOT> fix the thing",
          reactions: ["eyes"],
          replies: [{ ts: "1700000000.000200", text: "<@U_BOT> !done", user: "U_HUMAN" }],
        },
      ],
    },
    { botUserId: "U_BOT" },
  );
  let reactionCalls = 0;
  const add = transport.addReaction.bind(transport);
  const remove = transport.removeReaction.bind(transport);
  transport.addReaction = async (channel, ts, name) => {
    reactionCalls += 1;
    return add(channel, ts, name);
  };
  transport.removeReaction = async (channel, ts, name) => {
    reactionCalls += 1;
    return remove(channel, ts, name);
  };
  const client = new SlackTrackerClient(settings(), transport);

  // Done is terminal, so the issue is not a candidate - but the poll still heals the mirror
  // (in the background queue; flush to observe the settled result).
  assert.deepEqual(await client.fetchCandidateIssues(), []);
  await client.flushStatusMirrorHeals();
  assert.deepEqual((await transport.getMessage("C1", "1700000000.000100"))!.reactions, [
    "white_check_mark",
  ]);
  assert.ok(reactionCalls > 0);

  // A second poll with an unchanged state attempts no further reaction writes.
  const afterHeal = reactionCalls;
  await client.fetchCandidateIssues();
  await client.flushStatusMirrorHeals();
  assert.equal(reactionCalls, afterHeal);
});

test("human reactions never drive state and never trigger mirror writes", async () => {
  // A human's :white_check_mark: on an eventless mention thread must NOT read as Done (that
  // would let any channel member close an issue silently, bypassing the author allowlist) and
  // must not be "ratified" by a heal. Humans transition via !commands; the issue stays Todo.
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1700000000.000100",
          text: "<@U_BOT> fix the thing",
          humanReactions: ["white_check_mark", "eyes"],
        },
      ],
    },
    { botUserId: "U_BOT" },
  );
  let reactionCalls = 0;
  transport.addReaction = async () => {
    reactionCalls += 1;
  };
  transport.removeReaction = async () => {
    reactionCalls += 1;
  };
  const client = new SlackTrackerClient(settings(), transport);

  const candidates = await client.fetchCandidateIssues();
  await client.flushStatusMirrorHeals();
  assert.deepEqual(
    candidates.map((i) => [i.id, i.state]),
    [["C1:1700000000.000100", "Todo"]],
  );
  assert.equal(reactionCalls, 0);
});

test("the bot's own reactions still drive the eventless-state fallback", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        // Seeded `reactions` are bot-authored: the mirror written in an earlier session.
        { ts: "1700000000.000100", text: "<@U_BOT> shipped earlier", reactions: ["eyes"] },
      ],
    },
    { botUserId: "U_BOT" },
  );
  const client = new SlackTrackerClient(settings(), transport);

  assert.deepEqual(
    (await client.fetchCandidateIssues()).map((i) => i.state),
    ["In Progress"],
  );
});

test("a mirror heal only removes managed reactions actually present on the message", async () => {
  // Default managed set is {eyes, white_check_mark, x}. The root carries only :eyes:, so the
  // heal to Done must remove exactly :eyes: and add :white_check_mark: - never fire a remove
  // for :x: (or any other managed emoji) that is not on the message. Reaction methods are
  // Slack Tier-3; the blanket sweep was ~one remove per managed emoji per healed root.
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1700000000.000100",
          text: "<@U_BOT> fix the thing",
          reactions: ["eyes"],
          replies: [{ ts: "1700000000.000200", text: "<@U_BOT> !done", user: "U_HUMAN" }],
        },
      ],
    },
    { botUserId: "U_BOT" },
  );
  const removed: string[] = [];
  const added: string[] = [];
  const add = transport.addReaction.bind(transport);
  const remove = transport.removeReaction.bind(transport);
  transport.addReaction = async (channel, ts, name) => {
    added.push(name);
    return add(channel, ts, name);
  };
  transport.removeReaction = async (channel, ts, name) => {
    removed.push(name);
    return remove(channel, ts, name);
  };
  const client = new SlackTrackerClient(settings(), transport);

  await client.fetchCandidateIssues();
  await client.flushStatusMirrorHeals();
  assert.deepEqual(removed, ["eyes"]);
  assert.deepEqual(added, ["white_check_mark"]);
});

test("a heal that is only missing its target emoji costs one add and zero removes", async () => {
  // A human `!wip` on a root with no reactions at all: the mirror is merely missing :eyes:.
  // Nothing managed is present, so the heal must be a single reactions.add.
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1700000000.000100",
          text: "<@U_BOT> fix the thing",
          reactions: [],
          replies: [{ ts: "1700000000.000200", text: "<@U_BOT> !wip", user: "U_HUMAN" }],
        },
      ],
    },
    { botUserId: "U_BOT" },
  );
  let removes = 0;
  let adds = 0;
  const add = transport.addReaction.bind(transport);
  transport.addReaction = async (channel, ts, name) => {
    adds += 1;
    return add(channel, ts, name);
  };
  transport.removeReaction = async () => {
    removes += 1;
  };
  const client = new SlackTrackerClient(settings(), transport);

  await client.fetchCandidateIssues();
  await client.flushStatusMirrorHeals();
  assert.equal(removes, 0);
  assert.equal(adds, 1);
});

test("a rate-limited mirror heal does not block candidate discovery", async () => {
  // Two issues: one needs a mirror heal whose reactions.remove is stuck (a 429 backoff in the
  // real transport), the other is a plain new mention. The poll must still return promptly with
  // both issues - the heal runs in the background queue, not on the dispatch path.
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1700000000.000100",
          text: "<@U_BOT> healed later",
          reactions: ["eyes"],
          replies: [{ ts: "1700000000.000150", text: "<@U_BOT> !todo", user: "U_HUMAN" }],
        },
        { ts: "1700000000.000200", text: "<@U_BOT> fresh request", reactions: [] },
      ],
    },
    { botUserId: "U_BOT" },
  );
  let releaseRemove!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseRemove = resolve;
  });
  const remove = transport.removeReaction.bind(transport);
  transport.removeReaction = async (channel, ts, name) => {
    await blocked;
    return remove(channel, ts, name);
  };
  const client = new SlackTrackerClient(settings(), transport);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(
    candidates.map((i) => i.id),
    ["C1:1700000000.000100", "C1:1700000000.000200"],
  );

  // Unblock the stuck remove and let the heal settle; the mirror still converges.
  releaseRemove();
  await client.flushStatusMirrorHeals();
  assert.deepEqual((await transport.getMessage("C1", "1700000000.000100"))!.reactions, []);
});

test("fetchIssuesByIds derives in-window issues from the scan and warms the candidate cache", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1700000000.000100", text: "<@U_BOT> tracked work", reactions: ["eyes"] }] },
    { botUserId: "U_BOT" },
  );
  let scans = 0;
  const scanChannels = transport.scanChannels.bind(transport);
  transport.scanChannels = async (channels) => {
    scans += 1;
    return scanChannels(channels);
  };
  let getMessages = 0;
  const getMessage = transport.getMessage.bind(transport);
  transport.getMessage = async (channel, ts) => {
    getMessages += 1;
    return getMessage(channel, ts);
  };
  const client = new SlackTrackerClient(settings(), transport);

  // Refresh a tracked id, then fetch candidates in the same cycle: ONE scan total, and the
  // in-window id is derived from the scan with NO per-id getMessage round-trip.
  const refreshed = await client.fetchIssuesByIds(["C1:1700000000.000100"]);
  assert.deepEqual(
    refreshed.map((i) => i.id),
    ["C1:1700000000.000100"],
  );
  await client.fetchCandidateIssues();
  assert.equal(scans, 1);
  assert.equal(getMessages, 0);
});

test("fetchIssuesByIds skips the scan entirely when no id is parseable", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1700000000.000100", text: "<@U_BOT> tracked work", reactions: ["eyes"] }] },
    { botUserId: "U_BOT" },
  );
  let scans = 0;
  transport.scanChannels = async () => {
    scans += 1;
    return { mentions: [], threadedRoots: [] };
  };
  const client = new SlackTrackerClient(settings(), transport);

  // Startup workspace cleanup passes identifiers (no `channel:ts` colon); those must not cost
  // a channel-history scan.
  assert.deepEqual(await client.fetchIssuesByIds(["SLK-C1-1700000000-000100"]), []);
  assert.equal(scans, 0);
});

test("fetchIssuesByIds takes a fresh scan before deciding tracked issue state", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1700000000.000100", text: "<@U_BOT> tracked work", reactions: ["eyes"] }] },
    { botUserId: "U_BOT" },
  );
  let scans = 0;
  let terminalOnNextScan = false;
  const scanChannels = transport.scanChannels.bind(transport);
  transport.scanChannels = async (channels) => {
    scans += 1;
    const scan = await scanChannels(channels);
    if (!terminalOnNextScan) return scan;
    return {
      mentions: scan.mentions.map((root) =>
        root.ts === "1700000000.000100"
          ? { ...root, reactions: ["white_check_mark"], botReactions: ["white_check_mark"] }
          : root,
      ),
      threadedRoots: scan.threadedRoots,
    };
  };
  const client = new SlackTrackerClient(settings(), transport);

  assert.deepEqual(
    (await client.fetchCandidateIssues()).map((i) => i.state),
    ["In Progress"],
  );
  terminalOnNextScan = true;

  const refreshed = await client.fetchIssuesByIds(["C1:1700000000.000100"]);

  assert.equal(scans, 2);
  assert.deepEqual(
    refreshed.map((i) => i.state),
    ["Done"],
  );
});

test("fetchIssuesByIds falls back to getMessage for ids outside the scan window (never drops a live root)", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        { ts: "1700000000.000100", text: "<@U_BOT> aged out of the window", reactions: ["eyes"] },
      ],
    },
    { botUserId: "U_BOT" },
  );
  // Simulate a root older than the candidate scan window: the scan omits it, but the authoritative
  // by-id read still returns it. The refresh must NOT report it gone (which would abort its live run).
  transport.scanChannels = async () => ({ mentions: [], threadedRoots: [] });
  let getMessages = 0;
  const getMessage = transport.getMessage.bind(transport);
  transport.getMessage = async (channel, ts) => {
    getMessages += 1;
    return getMessage(channel, ts);
  };
  const client = new SlackTrackerClient(settings(), transport);

  const refreshed = await client.fetchIssuesByIds(["C1:1700000000.000100"]);
  assert.deepEqual(
    refreshed.map((i) => i.id),
    ["C1:1700000000.000100"],
  );
  assert.ok(getMessages > 0);
});

test("fetchIssuesByIds preserves the requested id order across scan hits and fallbacks", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        { ts: "1700000000.000100", text: "<@U_BOT> out of scan", reactions: ["eyes"] },
        { ts: "1700000000.000200", text: "<@U_BOT> in scan", reactions: ["eyes"] },
      ],
    },
    { botUserId: "U_BOT" },
  );
  // The first id falls OUTSIDE the candidate scan (aged out of the window) so it takes the
  // getMessage fallback; the second is a scan hit. The result must keep the REQUESTED order, not
  // emit scan hits first and append fallbacks.
  transport.scanChannels = async () => ({
    mentions: [
      {
        channel: "C1",
        ts: "1700000000.000200",
        text: "<@U_BOT> in scan",
        reactions: ["eyes"],
        botReactions: ["eyes"],
      },
    ],
    threadedRoots: [],
  });
  const client = new SlackTrackerClient(settings(), transport);

  const result = await client.fetchIssuesByIds(["C1:1700000000.000100", "C1:1700000000.000200"]);
  assert.deepEqual(
    result.map((i) => i.id),
    ["C1:1700000000.000100", "C1:1700000000.000200"],
  );
});

test("watch is null (pull-only) when no app token is configured", () => {
  const transport = new InMemorySlackTransport({ C1: [] });
  const client = new SlackTrackerClient(settings(), transport);
  // No SLACK_APP_TOKEN -> no Socket Mode push; the runtime stays on interval polling.
  assert.equal(
    client.watch(() => {}),
    null,
  );
});

test("watch opens Socket Mode with the resolved app token and watched channels", () => {
  const transport = new InMemorySlackTransport({ C1: [] });
  const withApp = parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1", "C2"],
        bot_user_id: "U_BOT",
        active_states: ["Todo"],
      },
    },
    { SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-123" },
  );

  let opened: SlackSocketModeOptions | null = null;
  let started = false;
  let closed = false;
  const client = new SlackTrackerClient(withApp, transport, (options) => {
    opened = options;
    return {
      start: () => {
        started = true;
      },
      close: () => {
        closed = true;
      },
    } as unknown as SlackSocketMode;
  });

  const changes: Array<TrackerChange | undefined> = [];
  const onChange = (change?: TrackerChange) => changes.push(change);
  const stream = client.watch(onChange);
  assert.ok(stream !== null);
  assert.equal(started, true);
  assert.ok(opened !== null);
  const opts = opened as unknown as SlackSocketModeOptions;
  assert.equal(opts.appToken, "xapp-123");
  assert.equal(opts.endpoint, "https://slack.com/api");
  assert.deepEqual(opts.channels, ["C1", "C2"]);
  opts.onChange({
    event: {
      type: "message",
      channel: "C1",
      ts: "1700000001.000200",
      thread_ts: "1700000000.000100",
      user: "U_HUMAN",
      text: "steer left",
    },
  });
  assert.deepEqual(changes, [
    {
      issueEvents: {
        issueId: "C1:1700000000.000100",
        events: [
          {
            authorizedForSteering: true,
            ts: "1700000001.000200",
            author: "U_HUMAN",
            text: "steer left",
          },
        ],
      },
    },
  ]);

  stream!.close();
  assert.equal(closed, true);
});

test("watch excludes replies that are not agent steering", () => {
  const transport = new InMemorySlackTransport({ C1: [] });
  const withApp = parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1"],
        bot_user_id: "U_BOT",
        users: ["U_ALICE"],
        active_states: ["Todo"],
      },
    },
    { SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-123" },
  );

  let opened: SlackSocketModeOptions | null = null;
  const changes: Array<TrackerChange | undefined> = [];
  const client = new SlackTrackerClient(withApp, transport, (options) => {
    opened = options;
    return {
      start: () => {},
      close: () => {},
    } as unknown as SlackSocketMode;
  });
  client.watch((change) => changes.push(change));
  const emit = (event: Record<string, unknown>) =>
    (opened as unknown as SlackSocketModeOptions).onChange({ event });
  const reply = {
    type: "message",
    channel: "C1",
    ts: "1700000001.000200",
    thread_ts: "1700000000.000100",
    user: "U_HUMAN",
  };

  emit({ ...reply, user: "U_BOT", text: "status: In Progress" });
  emit({ ...reply, text: "not allowed" });
  emit({ ...reply, text: "<@U_BOT> !done" });
  emit({ ...reply, text: "<@U_BOT> !aside context only" });
  emit({ ...reply, bot_id: "B_OTHER", text: "bot reply" });
  emit({ ...reply, subtype: "message_changed", text: "edited" });
  emit({ ...reply, thread_ts: undefined, text: "root message" });
  emit({ ...reply, user: "U_ALICE", text: "allowed steering" });

  assert.deepEqual(changes, [
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {
      issueEvents: {
        issueId: "C1:1700000000.000100",
        events: [
          {
            authorizedForSteering: true,
            ts: "1700000001.000200",
            author: "U_ALICE",
            text: "allowed steering",
          },
        ],
      },
    },
  ]);
});

test("fetchIssueEvents returns a bounded page of authorized human steering replies", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      {
        ts: "1700000000.000100",
        text: "<@U_BOT> do it",
        reactions: ["eyes"],
        replies: [
          { ts: "1700000000.000200", text: "already delivered", user: "U_HUMAN" },
          { ts: "1700000000.000300", text: "status: In Progress", user: "U_BOT" },
          { ts: "1700000000.000400", text: "<@U_BOT> !done", user: "U_HUMAN" },
          { ts: "1700000000.000500", text: "!aside context only", user: "U_HUMAN" },
          { ts: "1700000000.000600", text: "steer left", user: "U_HUMAN" },
          { ts: "1700000000.000650", text: "steer right", user: "U_HUMAN" },
          { ts: "1700000000.000675", text: "another bot", user: "U_OTHER_BOT", isBot: true },
          { ts: "1700000000.000700", text: "missing author" },
        ],
      },
    ],
  });
  const client = new SlackTrackerClient(settings(), transport);

  const first = await client.fetchIssueEvents("C1:1700000000.000100", "1700000000.000200", {
    maxEvents: 1,
    maxBytes: 64 * 1024,
  });
  assert.deepEqual(first, {
    events: [
      {
        authorizedForSteering: true,
        ts: "1700000000.000600",
        author: "U_HUMAN",
        text: "steer left",
      },
    ],
    hasMore: true,
  });

  const second = await client.fetchIssueEvents("C1:1700000000.000100", "1700000000.000600", {
    maxEvents: 1,
    maxBytes: 64 * 1024,
  });
  assert.deepEqual(second, {
    events: [
      {
        authorizedForSteering: true,
        ts: "1700000000.000650",
        author: "U_HUMAN",
        text: "steer right",
      },
    ],
    hasMore: false,
  });
});

test("fetchIssueEvents applies tracker.users authorization and the page byte limit", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      {
        ts: "1700000000.000100",
        text: "<@U_BOT> do it",
        reactions: ["eyes"],
        replies: [
          { ts: "1700000000.000200", text: "not authorized", user: "U_BOB" },
          { ts: "1700000000.000300", text: "a".repeat(1_000), user: "U_ALICE" },
        ],
      },
    ],
  });
  const client = new SlackTrackerClient(allowlistSettings(), transport);

  const page = await client.fetchIssueEvents("C1:1700000000.000100", "0", {
    maxEvents: 10,
    maxBytes: 256,
  });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0]!.author, "U_ALICE");
  assert.equal(page.events[0]!.authorizedForSteering, true);
  assert.ok(trackerIssueEventsBytes(page.events) <= 256);
  assert.match(page.events[0]!.text, /message shortened for live delivery/);
  assert.equal(page.hasMore, false);
});
