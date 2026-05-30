import { test } from "vitest";
import { parseConfig } from "@symphony/config";

import { assert } from "../../../test/assert.js";

import {
  DEFAULT_EMOJI_STATES,
  emojiForState,
  isBotMention,
  stateFromReactions,
  statusEmojiMap,
  stripLeadingMention,
} from "@symphony/slack-tracker";

test("default emoji map yields Todo with no status reactions and maps the rest", () => {
  const map = DEFAULT_EMOJI_STATES;
  assert.equal(stateFromReactions([], map), "Todo");
  assert.equal(stateFromReactions(["thumbsup", "eyes"], map), "In Progress");
  assert.equal(stateFromReactions(["white_check_mark"], map), "Done");
  assert.equal(stateFromReactions(["x"], map), "Cancelled");
});

test("stateFromReactions picks the most-advanced status regardless of reaction order", () => {
  const map = DEFAULT_EMOJI_STATES;
  assert.equal(stateFromReactions(["eyes", "white_check_mark"], map), "Done");
  assert.equal(stateFromReactions(["white_check_mark", "eyes"], map), "Done");
  assert.equal(stateFromReactions(["x", "eyes"], map), "Cancelled");
});

test("a cancellation deterministically overrides a completion regardless of order", () => {
  const map = DEFAULT_EMOJI_STATES;
  assert.equal(stateFromReactions(["white_check_mark", "x"], map), "Cancelled");
  assert.equal(stateFromReactions(["x", "white_check_mark"], map), "Cancelled");
});

test("emojiForState reverse-looks-up the configured emoji", () => {
  const map = DEFAULT_EMOJI_STATES;
  assert.equal(emojiForState("In Progress", map), "eyes");
  assert.equal(emojiForState("done", map), "white_check_mark");
  assert.equal(emojiForState("Todo", map), null);
});

test("isBotMention matches only the bot when botUserId is set", () => {
  assert.equal(isBotMention("<@U_BOT> do it", "U_BOT"), true);
  assert.equal(isBotMention("<@U_BOT|worker> do it", "U_BOT"), true);
  assert.equal(isBotMention("<@U_OTHER> ping someone else", "U_BOT"), false);
  assert.equal(isBotMention("hey <@U_BOT> later in line", "U_BOT"), true);
  assert.equal(isBotMention("no mention here", "U_BOT"), false);
});

test("isBotMention matches any user mention when botUserId is unset (back-compat)", () => {
  assert.equal(isBotMention("<@U_OTHER> hi"), true);
  assert.equal(isBotMention("<@U123|alice> hi"), true);
  assert.equal(isBotMention("plain text"), false);
});

test("stripLeadingMention removes only the leading bot mention when botUserId is set", () => {
  assert.equal(stripLeadingMention("<@U_BOT> fix it", "U_BOT"), "fix it");
  assert.equal(stripLeadingMention("<@U_BOT|worker> fix it", "U_BOT"), "fix it");
  assert.equal(stripLeadingMention("<@U_OTHER> fix it", "U_BOT"), "<@U_OTHER> fix it");
});

test("stripLeadingMention removes any leading mention when botUserId is unset", () => {
  assert.equal(stripLeadingMention("<@U_OTHER> fix it"), "fix it");
  assert.equal(stripLeadingMention("<@U123|alice> fix it"), "fix it");
});

test("statusEmojiMap merges config overrides over defaults", () => {
  const settings = parseConfig(
    { tracker: { kind: "slack", channels: ["C1"], emoji_states: { rocket: "Shipped" } } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  const map = statusEmojiMap(settings);
  assert.equal(map.rocket, "Shipped");
  assert.equal(map.eyes, "In Progress");
});
