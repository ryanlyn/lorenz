import { test } from "vitest";
import { parseConfig } from "@symphony/config";

import { assert } from "../../../test/assert.js";

import {
  DEFAULT_EMOJI_STATES,
  emojiForState,
  stateFromReactions,
  statusEmojiMap,
} from "@symphony/slack-tracker";

test("default emoji map yields Todo with no status reactions and maps the rest", () => {
  const map = DEFAULT_EMOJI_STATES;
  assert.equal(stateFromReactions([], map), "Todo");
  assert.equal(stateFromReactions(["thumbsup", "eyes"], map), "In Progress");
  assert.equal(stateFromReactions(["white_check_mark"], map), "Done");
  assert.equal(stateFromReactions(["x"], map), "Cancelled");
});

test("emojiForState reverse-looks-up the configured emoji", () => {
  const map = DEFAULT_EMOJI_STATES;
  assert.equal(emojiForState("In Progress", map), "eyes");
  assert.equal(emojiForState("done", map), "white_check_mark");
  assert.equal(emojiForState("Todo", map), null);
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
