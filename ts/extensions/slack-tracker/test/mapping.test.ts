import { test } from "vitest";
import { assert } from "@symphony/test-utils";

import { parseSlackConfig } from "./helpers.js";

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
  const settings = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], emoji_states: { rocket: "Shipped" } } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  const map = statusEmojiMap(settings);
  assert.equal(map.rocket, "Shipped");
  assert.equal(map.eyes, "In Progress");
});

test("reactions named after Object prototype members are unmapped, not inherited members", () => {
  // Slack custom emoji can legally be named `constructor` or `__proto__`; a truthy bracket
  // lookup on a prototype-bearing map would resolve them to inherited functions and crash
  // state derivation for the whole channel.
  const settings = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  const map = statusEmojiMap(settings);
  assert.equal(stateFromReactions(["constructor", "__proto__"], map), "Todo");
  assert.equal(stateFromReactions(["constructor", "eyes"], map), "In Progress");
  // The exported default map is a plain object; the lookup guard must hold there too.
  assert.equal(stateFromReactions(["constructor"], DEFAULT_EMOJI_STATES), "Todo");
});

test("custom state names rank by their configured terminal/active role", () => {
  // A human closing an issue with a custom terminal reaction must outrank the agent's
  // lingering :eyes:, or the runtime re-dispatches a finished issue forever.
  const settings = parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1"],
        bot_user_id: "U1",
        emoji_states: { rocket: "Shipped", wrench: "Rework" },
        active_states: ["Todo", "In Progress", "Rework"],
        terminal_states: ["Shipped"],
      },
    },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  const map = statusEmojiMap(settings);
  assert.equal(stateFromReactions(["eyes", "rocket"], map, settings), "Shipped");
  assert.equal(stateFromReactions(["rocket", "eyes"], map, settings), "Shipped");
  // A custom ACTIVE state ranks with started: it beats Todo but not a terminal reaction.
  assert.equal(stateFromReactions(["wrench"], map, settings), "Rework");
  assert.equal(stateFromReactions(["wrench", "x"], map, settings), "Cancelled");
});
