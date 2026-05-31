import { test } from "vitest";
import { parseConfig } from "@symphony/config";

import { assert } from "../../../test/assert.js";

import { InMemorySlackTransport, SlackTrackerClient } from "@symphony/slack-tracker";

function settings() {
  return parseConfig(
    { tracker: { kind: "slack", channels: ["C1"], active_states: ["Todo", "In Progress"] } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
}

function botSettings() {
  return parseConfig(
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

test("mentions become issues; reactions drive state", async () => {
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

  const byId = await client.fetchIssuesByIds(["C1:1700000000.000200"]);
  assert.deepEqual(
    byId.map((i) => i.state),
    ["Done"],
  );
});

test("piped mention form <@U123|alice> is detected and stripped from the title", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1700000000.000300", text: "<@U123|alice> do it", reactions: [] }],
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
        { ts: "1700000000.000700", text: "<@U_OTHER> mention removed", reactions: ["eyes"] },
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
