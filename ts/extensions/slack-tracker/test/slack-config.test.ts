import { test } from "vitest";
import { acpExecutorProvider } from "@symphony/acp";
import { AgentExecutorRegistry } from "@symphony/agent-sdk";
import { settingsForIssueState, validateDispatchConfig } from "@symphony/config";
import type { Settings } from "@symphony/domain";
import { assert } from "@symphony/test-utils";

import { parseSlackConfig, slackTrackers } from "./helpers.js";

import { slackTrackerOptions } from "@symphony/slack-tracker";

const executors = new AgentExecutorRegistry();
executors.register(acpExecutorProvider);

function validateSlackDispatch(settings: Settings): void {
  validateDispatchConfig(settings, slackTrackers, executors);
}

test("config parses slack bot_user_id and resolves SLACK_BOT_USER_ID fallback", () => {
  const explicit = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U_EXPLICIT" } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  assert.equal(slackTrackerOptions(explicit).botUserId, "U_EXPLICIT");

  const fromEnv = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"] } },
    { SLACK_BOT_TOKEN: "xoxb-test", SLACK_BOT_USER_ID: "U_ENV" },
  );
  assert.equal(slackTrackerOptions(fromEnv).botUserId, "U_ENV");

  const fromEnvRef = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "$SLACK_BOT_USER_ID" } },
    { SLACK_BOT_TOKEN: "xoxb-test", SLACK_BOT_USER_ID: "U_REF" },
  );
  assert.equal(slackTrackerOptions(fromEnvRef).botUserId, "U_REF");

  const unset = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"] } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  assert.equal(slackTrackerOptions(unset).botUserId, undefined);
});

test("parses slack tracker config with channels, emoji overrides, and token env", () => {
  const settings = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1", "C2"], emoji_states: { rocket: "Shipped" } } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  assert.equal(settings.tracker.kind, "slack");
  assert.equal(settings.tracker.endpoint, "https://slack.com/api");
  assert.equal(settings.tracker.apiKey, "xoxb-test");
  assert.deepEqual(slackTrackerOptions(settings).channels, ["C1", "C2"]);
  assert.deepEqual(slackTrackerOptions(settings).emojiStates, { rocket: "Shipped" });
});

test("rejects unknown slack tracker options and malformed emoji_states", () => {
  assert.throws(
    () =>
      parseSlackConfig(
        { tracker: { kind: "slack", channels: ["C1"], bogus: true } },
        { SLACK_BOT_TOKEN: "xoxb-test" },
      ),
    /unsupported tracker option.*slack.*bogus/,
  );
  assert.throws(
    () =>
      parseSlackConfig(
        { tracker: { kind: "slack", channels: ["C1"], emoji_states: { rocket: 7 } } },
        { SLACK_BOT_TOKEN: "xoxb-test" },
      ),
    /emoji_states\.rocket must be a string/,
  );
});

test("cloned settings deep-copy slack channels and emoji states", () => {
  const settings = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1", "C2"], emoji_states: { rocket: "Shipped" } } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  const clone = settingsForIssueState(settings, "Todo");

  (clone.tracker.options.channels as string[]).push("C3");
  (clone.tracker.options.emojiStates as Record<string, string>).rocket = "Mutated";

  assert.deepEqual(slackTrackerOptions(settings).channels, ["C1", "C2"]);
  assert.deepEqual(slackTrackerOptions(settings).emojiStates, { rocket: "Shipped" });
});

test("slack tracker requires a token and at least one channel", () => {
  assert.throws(
    () =>
      validateSlackDispatch(
        parseSlackConfig(
          { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U_BOT" } },
          {},
        ),
      ),
    /SLACK_BOT_TOKEN/,
  );
  assert.throws(
    () =>
      validateSlackDispatch(
        parseSlackConfig(
          { tracker: { kind: "slack", bot_user_id: "U_BOT" } },
          { SLACK_BOT_TOKEN: "xoxb-test" },
        ),
      ),
    /channels is required/,
  );
});

test("slack tracker requires bot_user_id so mentions are scoped to the bot (fail closed)", () => {
  // Without a bot user id the mention matcher would fall back to matching ANY <@U...> mention,
  // spawning agents on ordinary human-to-human chatter. Validation must reject that config.
  assert.throws(
    () =>
      validateSlackDispatch(
        parseSlackConfig(
          { tracker: { kind: "slack", channels: ["C1"] } },
          { SLACK_BOT_TOKEN: "xoxb" },
        ),
      ),
    /bot_user_id.*required|SLACK_BOT_USER_ID/,
  );
  // An empty SLACK_BOT_USER_ID env value must not satisfy the requirement either.
  assert.throws(
    () =>
      validateSlackDispatch(
        parseSlackConfig(
          { tracker: { kind: "slack", channels: ["C1"] } },
          { SLACK_BOT_TOKEN: "xoxb", SLACK_BOT_USER_ID: "" },
        ),
      ),
    /bot_user_id.*required|SLACK_BOT_USER_ID/,
  );
  // With a bot user id present (explicit or via env), validation passes.
  validateSlackDispatch(
    parseSlackConfig(
      { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U_BOT" } },
      { SLACK_BOT_TOKEN: "xoxb" },
    ),
  );
  validateSlackDispatch(
    parseSlackConfig(
      { tracker: { kind: "slack", channels: ["C1"] } },
      { SLACK_BOT_TOKEN: "xoxb", SLACK_BOT_USER_ID: "U_ENV" },
    ),
  );
});
