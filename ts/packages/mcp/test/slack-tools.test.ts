import { test } from "vitest";
import { InMemorySlackTransport } from "@symphony/slack-tracker";
import { parseConfig } from "@symphony/config";

import { assert } from "../../../test/assert.js";

import { executeTool, toolSpecs } from "@symphony/mcp";

function settings() {
  return parseConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
}

test("slack toolSpecs lists update_status and comment", () => {
  assert.deepEqual(
    toolSpecs(settings()).map((t) => t.name),
    ["slack_update_status", "slack_comment"],
  );
});

test("slack_update_status swaps the status reaction; slack_comment replies in thread", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const moved = await executeTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    fetch,
    { slackTransport: transport },
  );
  assert.equal(moved.success, true);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["white_check_mark"]);

  const replied = await executeTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "done!" },
    settings(),
    fetch,
    { slackTransport: transport },
  );
  assert.equal(replied.success, true);
  assert.deepEqual(transport.replies, [{ channel: "C1", threadTs: "1.1", body: "done!" }]);
});

test("slack_update_status is a no-op when the target emoji is already present", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["white_check_mark"] }],
  });
  const calls: Array<{ kind: string; name: string }> = [];
  const add = transport.addReaction.bind(transport);
  const remove = transport.removeReaction.bind(transport);
  transport.addReaction = async (channel, ts, name) => {
    calls.push({ kind: "add", name });
    return add(channel, ts, name);
  };
  transport.removeReaction = async (channel, ts, name) => {
    calls.push({ kind: "remove", name });
    return remove(channel, ts, name);
  };

  const result = await executeTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    fetch,
    { slackTransport: transport },
  );
  assert.equal(result.success, true);
  assert.deepEqual(calls, []);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["white_check_mark"]);
});

test("slack_update_status fails when the status has no configured emoji", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Shipped" },
    settings(),
    fetch,
    { slackTransport: transport },
  );
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /Shipped/);
});
