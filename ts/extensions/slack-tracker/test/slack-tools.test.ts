import { test } from "vitest";
import { assert } from "@symphony/test-utils";

import { parseSlackConfig } from "./helpers.js";

import {
  executeSlackTool,
  InMemorySlackTransport,
  slackToolSpecs,
  stateFromReactions,
  statusEmojiMap,
} from "@symphony/slack-tracker";

function settings() {
  return parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
}

function aliasedDoneSettings() {
  return parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1"],
        bot_user_id: "U1",
        emoji_states: {
          white_check_mark: "Ignored",
          check_mark: "Done",
          "green-check-mark": "Done",
        },
      },
    },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
}

test("slack toolSpecs lists update_status, comment, read_thread, and query", () => {
  assert.deepEqual(
    slackToolSpecs().map((t) => t.name),
    ["slack_update_status", "slack_comment", "slack_read_thread", "slack_query"],
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

test("slack_update_status swaps the status reaction; slack_comment replies in thread", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const moved = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
  );
  assert.equal(moved.success, true);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["white_check_mark"]);

  const replied = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "done!" },
    settings(),
    transport,
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

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
  );
  assert.equal(result.success, true);
  assert.deepEqual(calls, []);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["white_check_mark"]);
});

test("slack_update_status is a no-op when a target-state emoji alias is already present", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["green-check-mark"] }],
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

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    aliasedDoneSettings(),
    transport,
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls, []);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["green-check-mark"]);
});

test("slack_update_status accepts Slack canonicalizing a configured emoji alias", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });
  const add = transport.addReaction.bind(transport);
  transport.addReaction = async (channel, ts, name) =>
    add(channel, ts, name === "check_mark" ? "green-check-mark" : name);

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    aliasedDoneSettings(),
    transport,
  );

  assert.equal(result.success, true);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["green-check-mark"]);
});

test("slack_update_status fails when the status has no configured emoji", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Shipped" },
    settings(),
    transport,
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
  // When set, removals of these reaction names RESOLVE SUCCESSFULLY but do NOT remove the
  // reaction. This models Slack's reactions.remove "no_reaction" error treated as success when
  // the requestor is not the reaction's author (a human added the managed emoji, so the bot
  // cannot remove it): the call appears to succeed yet the stale reaction lingers.
  removeNoOp: Set<string> | null = null;

  override async addReaction(channel: string, ts: string, name: string): Promise<void> {
    if (this.failAdd) throw new Error("addReaction failed");
    return super.addReaction(channel, ts, name);
  }

  override async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    if (this.failRemoveOnly ? this.failRemoveOnly.has(name) : this.failRemove) {
      throw new Error("removeReaction failed");
    }
    if (this.removeNoOp?.has(name)) {
      // Resolve as success (mirroring no_reaction-as-success) without removing the reaction.
      return Promise.resolve();
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

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
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

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "In Progress" },
    settings(),
    transport,
  );

  // Cleanup remove failed: roll back the added eyes so only the stale white_check_mark remains
  // and the read path reports the OLD status (Done).
  assert.equal(result.success, false);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["white_check_mark"]);
});

test("slack_update_status restores the full original set when a later multi-stale remove fails", async () => {
  // Two stale managed reactions: x (Cancelled, the ranking winner) and eyes (In Progress).
  // Updating to Done removes x first (succeeds) then eyes (fails). The rollback must re-add the
  // already-removed x AND drop the just-added target, restoring the ORIGINAL set so the read
  // path still reports the prior status (Cancelled) rather than a wrong/partial one.
  const transport = new FailingSlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["x", "eyes"] }],
  });
  transport.failRemoveOnly = new Set(["eyes"]);

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  const msg = await transport.getMessage("C1", "1.1");
  // The original managed-reaction set is fully restored: both stale reactions present, target not.
  assert.equal(msg!.reactions.includes("x"), true);
  assert.equal(msg!.reactions.includes("eyes"), true);
  assert.equal(msg!.reactions.includes("white_check_mark"), false);
  // The read path still reports the OLD status (Cancelled), never the wrong new status.
  assert.equal(stateFromReactions(msg!.reactions, statusEmojiMap(settings())), "Cancelled");
});

test("slack_update_status reports an ambiguous failure when rollback cannot restore the original set", async () => {
  // In Progress -> Done with ALL removes failing. add white_check_mark succeeds; removing the
  // stale eyes fails, triggering rollback. The rollback removeReaction(white_check_mark) ALSO
  // fails (real outage), so both eyes and white_check_mark linger. The read path ranks Done above
  // In Progress, so the message would observe as "Done" even though the swap failed: the tool must
  // NOT claim "status not changed" and must surface the actual managed reactions.
  const transport = new FailingSlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });
  transport.failRemove = true;

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  // The error must NOT lie about the state being unchanged.
  assert.equal(/status not changed/.test(result.error ?? ""), false);
  // It must report that the update failed and could not be fully rolled back, and include the
  // ACTUAL current managed reactions so the caller does not trust the prior status.
  assert.match(result.error ?? "", /could not be fully rolled back/);
  assert.match(result.error ?? "", /eyes/);
  assert.match(result.error ?? "", /white_check_mark/);
  // The actual reactions are surfaced in the result for programmatic callers.
  const reported = (result.result as { error: { currentManagedReactions: string[] } }).error
    .currentManagedReactions;
  assert.equal(reported.includes("eyes"), true);
  assert.equal(reported.includes("white_check_mark"), true);
  // Both reactions genuinely lingered on the message.
  const msg = await transport.getMessage("C1", "1.1");
  assert.equal(msg!.reactions.includes("eyes"), true);
  assert.equal(msg!.reactions.includes("white_check_mark"), true);
});

test("slack_update_status preserves the old status when addReaction fails", async () => {
  const transport = new FailingSlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });
  transport.failAdd = true;

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
  );

  // The add failed up front: no remove should have been attempted, so the prior status is
  // fully preserved (existing reactions unchanged).
  assert.equal(result.success, false);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["eyes"]);
});

test("slack_update_status fails when a 'successful' remove leaves a human-authored reaction lingering", async () => {
  // A HUMAN added the Cancelled emoji (x), so the bot's reactions.remove returns no_reaction and
  // resolves as success WITHOUT removing it. Updating to Done adds white_check_mark and "removes"
  // x (a no-op). Every write resolves, but the message now has BOTH ["x", "white_check_mark"], so
  // the read path ranks Cancelled above Done and would mis-report the OLD status. The tool must
  // verify the effective end state, NOT claim success, and surface the actual managed reactions.
  const transport = new FailingSlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["x"] }],
  });
  transport.removeNoOp = new Set(["x"]);

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
  );

  // The swap did not take effect: x lingered, so the effective status is still Cancelled, not Done.
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /did not take effect/);
  assert.match(result.error ?? "", /x/);
  assert.match(result.error ?? "", /white_check_mark/);
  // The actual reactions are surfaced for programmatic callers.
  const reported = (result.result as { error: { currentManagedReactions: string[] } }).error
    .currentManagedReactions;
  assert.equal(reported.includes("x"), true);
  assert.equal(reported.includes("white_check_mark"), true);
  // Both reactions genuinely linger on the message, so the read path still resolves to Cancelled.
  const msg = await transport.getMessage("C1", "1.1");
  assert.equal(msg!.reactions.includes("x"), true);
  assert.equal(msg!.reactions.includes("white_check_mark"), true);
  assert.equal(stateFromReactions(msg!.reactions, statusEmojiMap(settings())), "Cancelled");
});

test("slack_update_status add-before-remove happy path swaps to a single target", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
  );

  assert.equal(result.success, true);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["white_check_mark"]);
});

test("slack_update_status succeeds for a case-variant status and reports the canonical state", async () => {
  // emojiForState resolves the status case-insensitively, so "done" maps to white_check_mark and the
  // swap takes effect. The success-path verification must compare the effective ranked state against
  // the target emoji's CANONICAL mapped state ("Done"), not the raw "done" the agent passed - an
  // exact-string check would otherwise falsely report that the correctly-applied update did not take
  // effect.
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "done" },
    settings(),
    transport,
  );

  assert.equal(result.success, true);
  // The reported status is the canonical mapped name, not the raw lowercase input.
  assert.equal((result.result as { status: string }).status, "Done");
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["white_check_mark"]);
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
