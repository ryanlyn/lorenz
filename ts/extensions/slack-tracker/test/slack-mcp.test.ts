import { test } from "vitest";
import { toolSpecs, trackerMcpServerName } from "@lorenz/mcp";
import { ToolRegistry } from "@lorenz/tool-sdk";
import { createTrackerToolProvider, TrackerRegistry } from "@lorenz/tracker-sdk";
import { assert } from "@lorenz/test-utils";

import { parseSlackConfig } from "./helpers.js";

import {
  InMemorySlackTransport,
  registerSlackTracker,
  slackToolOpsWith,
} from "@lorenz/slack-tracker";

function settings() {
  return parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
}

test("slack dispatch mounts the neutral tracker pack plus the slack pack by default", () => {
  // Compose private registries exactly as the CLI composition root does.
  const trackers = new TrackerRegistry();
  const tools = new ToolRegistry();
  registerSlackTracker({ trackers, tools });
  tools.register(createTrackerToolProvider(trackers));

  assert.deepEqual(
    toolSpecs(settings(), tools).map((tool) => tool.name),
    [
      "tracker_read_issue",
      "tracker_query",
      "tracker_update_status",
      "tracker_comment",
      "tracker_create_issue",
      "slack_update_status",
      "slack_comment",
      "slack_read_thread",
      "slack_query",
      "slack_user_info",
      "slack_channel_context",
    ],
  );
});

test("the agent MCP server is named for the slack tracker kind", () => {
  assert.equal(trackerMcpServerName("slack"), "lorenz_slack");
});

test("neutral tracker ops read, query, comment, and update status over the slack transport", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      { ts: "1.1", text: "<@U1> fix the build #backend", reactions: ["eyes"] },
      { ts: "1.2", text: "<@U1> ship docs", reactions: ["white_check_mark"] },
    ],
  });
  const ops = slackToolOpsWith(settings(), transport);

  const issue = await ops.readIssue!("C1:1.1");
  assert.equal(issue.id, "C1:1.1");
  assert.equal(issue.title, "fix the build #backend");
  assert.equal(issue.state, "In Progress");
  assert.deepEqual(issue.labels, ["backend"]);

  // The no-arg query is candidate-scoped like the other trackers: only active states return.
  const candidates = await ops.queryIssues!({});
  assert.deepEqual(
    candidates.map((i) => i.id),
    ["C1:1.1"],
  );
  // Permalinks come from the workspace base URL the transport reports.
  assert.equal(candidates[0]!.url, "https://example.slack.com/archives/C1/p11");
  assert.equal(candidates[0]!.identifier, "SLK-C1-1-1");
  // jql is Jira's surface: reject loudly instead of returning unfiltered rows as if filtered.
  await assert.rejects(() => ops.queryIssues!({ jql: "status = Done" }), /not supported/);
  const done = await ops.queryIssues!({ states: ["Done"] });
  assert.deepEqual(
    done.map((i) => i.id),
    ["C1:1.2"],
  );
  const byId = await ops.queryIssues!({ issueIds: ["C1:1.2"] });
  assert.deepEqual(
    byId.map((i) => i.state),
    ["Done"],
  );

  const updated = await ops.updateStatus!("C1:1.1", "Done");
  assert.equal(updated.state, "Done");
  // The bot's reaction mirror still reflects the new state for glanceability.
  assert.deepEqual((await transport.getMessage("C1", "1.1"))!.reactions, ["white_check_mark"]);

  await ops.addComment!("C1:1.1", "progress note");
  assert.deepEqual(transport.replies, [
    { channel: "C1", threadTs: "1.1", body: "status: Done" },
    { channel: "C1", threadTs: "1.1", body: "progress note" },
  ]);

  // Slack issues are created by humans @-mentioning the bot, never by an agent.
  assert.equal(ops.createIssue, undefined);
});

test("neutral tracker ops enforce the same trust boundary as the slack tools", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "no mention here", reactions: [] }],
    C9: [{ ts: "9.1", text: "<@U1> off-limits channel", reactions: [] }],
  });
  const ops = slackToolOpsWith(settings(), transport);

  await assert.rejects(() => ops.readIssue!("C9:9.1"), /not a configured tracker channel/);
  await assert.rejects(() => ops.readIssue!("C1:1.1"), /not a tracked bot-mention/);
  await assert.rejects(() => ops.addComment!("C1:9.9", "hi"), /no tracked issue/);
  await assert.rejects(() => ops.updateStatus!("nonsense", "Done"), /'<channel>:<ts>' form/);
});
