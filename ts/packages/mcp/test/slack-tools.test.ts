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

class FailingSlackTransport extends InMemorySlackTransport {
  failAdd = false;
  failRemove = false;
  // When set, only removals of these reaction names fail. This models a real partial failure
  // where removing the stale reaction errors but the rollback removal of the target succeeds.
  failRemoveOnly: Set<string> | null = null;

  override async addReaction(channel: string, ts: string, name: string): Promise<void> {
    if (this.failAdd) throw new Error("addReaction failed");
    return super.addReaction(channel, ts, name);
  }

  override async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    if (this.failRemoveOnly ? this.failRemoveOnly.has(name) : this.failRemove) {
      throw new Error("removeReaction failed");
    }
    return super.removeReaction(channel, ts, name);
  }
}

test("slack_update_status rolls back to the old status (Cancelled) when removeReaction fails", async () => {
  // x ranks higher than white_check_mark; a stale x left next to a newly added Done would
  // shadow it and report the wrong status, so the rollback must drop the freshly added target.
  const transport = new FailingSlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["x"] }],
  });
  // The stale x removal fails; the rollback removal of the just-added white_check_mark succeeds.
  transport.failRemoveOnly = new Set(["x"]);

  const result = await executeTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    fetch,
    { slackTransport: transport },
  );

  // Cleanup remove failed: roll back the added target so only the stale x remains and the read
  // path reports the OLD status (Cancelled), never the wrong new status.
  assert.equal(result.success, false);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["x"]);
});

test("slack_update_status rolls back to the old status (Done) when removeReaction fails", async () => {
  // Done -> In Progress: a stale white_check_mark left next to a newly added eyes would shadow
  // it (completed outranks started), so the rollback must drop the freshly added target.
  const transport = new FailingSlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["white_check_mark"] }],
  });
  // The stale white_check_mark removal fails; the rollback removal of the added eyes succeeds.
  transport.failRemoveOnly = new Set(["white_check_mark"]);

  const result = await executeTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "In Progress" },
    settings(),
    fetch,
    { slackTransport: transport },
  );

  // Cleanup remove failed: roll back the added eyes so only the stale white_check_mark remains
  // and the read path reports the OLD status (Done).
  assert.equal(result.success, false);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["white_check_mark"]);
});

test("slack_update_status preserves the old status when addReaction fails", async () => {
  const transport = new FailingSlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });
  transport.failAdd = true;

  const result = await executeTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    fetch,
    { slackTransport: transport },
  );

  // The add failed up front: no remove should have been attempted, so the prior status is
  // fully preserved (existing reactions unchanged).
  assert.equal(result.success, false);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["eyes"]);
});

test("slack_update_status add-before-remove happy path swaps to a single target", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    fetch,
    { slackTransport: transport },
  );

  assert.equal(result.success, true);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["white_check_mark"]);
});

test("slack_update_status rejects a channel that is not in tracker.channels", async () => {
  // Seed the disallowed channel with a real bot-mention message so the only failing guard is
  // the channel allow-list, and assert no reaction side effect occurred.
  const transport = new InMemorySlackTransport({
    C9: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeTool(
    "slack_update_status",
    { issueId: "C9:1.1", status: "Done" },
    settings(),
    fetch,
    { slackTransport: transport },
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

  const result = await executeTool(
    "slack_comment",
    { issueId: "C9:1.1", body: "hi" },
    settings(),
    fetch,
    { slackTransport: transport },
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /C9/);
  assert.deepEqual(transport.replies, []);
});

test("slack_update_status fails when no message exists at the issueId", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeTool(
    "slack_update_status",
    { issueId: "C1:9.9", status: "Done" },
    settings(),
    fetch,
    { slackTransport: transport },
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /no tracked issue/);
});

test("slack_comment fails when no message exists at the issueId", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: [] }],
  });

  const result = await executeTool(
    "slack_comment",
    { issueId: "C1:9.9", body: "hi" },
    settings(),
    fetch,
    { slackTransport: transport },
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /no tracked issue/);
  assert.deepEqual(transport.replies, []);
});

test("slack_update_status fails when the message is not a bot mention", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "just chatting, no mention here", reactions: ["eyes"] }],
  });

  const result = await executeTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    fetch,
    { slackTransport: transport },
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

  const result = await executeTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "hi" },
    settings(),
    fetch,
    { slackTransport: transport },
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not a tracked bot-mention/);
  assert.deepEqual(transport.replies, []);
});
