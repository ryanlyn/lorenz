import { test } from "vitest";
import { acpExecutorProvider } from "@lorenz/acp";
import { AgentExecutorRegistry } from "@lorenz/agent-sdk";
import { settingsForIssueState, validateDispatchConfig } from "@lorenz/config";
import type { Settings } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";

import { parseSlackConfig, slackTrackers } from "./helpers.js";

import { slackTrackerOptions } from "@lorenz/slack-tracker";

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

test("config parses slack app_token and resolves the SLACK_APP_TOKEN fallback", () => {
  const explicit = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1", app_token: "xapp-explicit" } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  assert.equal(slackTrackerOptions(explicit).appToken, "xapp-explicit");

  const fromEnv = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-env" },
  );
  assert.equal(slackTrackerOptions(fromEnv).appToken, "xapp-env");

  const fromRef = parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1"],
        bot_user_id: "U1",
        app_token: "$SLACK_APP_TOKEN",
      },
    },
    { SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-ref" },
  );
  assert.equal(slackTrackerOptions(fromRef).appToken, "xapp-ref");

  // Unset stays pull-only: no app token surfaces in options, and an empty env value is dropped
  // rather than stored as "".
  const unset = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb-test" },
  );
  assert.equal(slackTrackerOptions(unset).appToken, undefined);

  const empty = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "" },
  );
  assert.equal(slackTrackerOptions(empty).appToken, undefined);
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

test("channel entries resolve $VAR references like bot_user_id does", () => {
  const settings = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["$SLACK_CHANNEL_ID", "C2"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL_ID: "C1" },
  );
  assert.deepEqual(slackTrackerOptions(settings).channels, ["C1", "C2"]);

  // An unresolved reference collapses to empty and is dropped, so dispatch validation fails
  // loudly instead of the poll loop querying a literal "$SLACK_CHANNEL_ID" forever.
  const unresolved = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["$SLACK_CHANNEL_ID"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
  assert.deepEqual(slackTrackerOptions(unresolved).channels, []);
  assert.throws(() => validateSlackDispatch(unresolved), /channels is required/);
});

test("parses the optional users allowlist and resolves $VAR references, dropping empties", () => {
  const explicit = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1", users: ["U_A", "U_B"] } },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
  assert.deepEqual(slackTrackerOptions(explicit).users, ["U_A", "U_B"]);

  const fromRef = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1", users: ["$SLACK_USER_ID"] } },
    { SLACK_BOT_TOKEN: "xoxb", SLACK_USER_ID: "U_REF" },
  );
  assert.deepEqual(slackTrackerOptions(fromRef).users, ["U_REF"]);

  // An unresolved reference collapses to empty and is dropped rather than narrowing dispatch to
  // a literal "$SLACK_USER_ID" that can never match an author.
  const unresolved = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1", users: ["$SLACK_USER_ID"] } },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
  assert.deepEqual(slackTrackerOptions(unresolved).users, []);

  // Omitting it entirely means no author constraint (an empty list).
  const omitted = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
  assert.deepEqual(slackTrackerOptions(omitted).users, []);
});

test("a direct-message channel id is a valid watched channel", () => {
  // DMs are watched by listing the D... channel id; nothing special distinguishes it from a
  // C.../G... channel at the config layer, and dispatch validation accepts it.
  const settings = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["D0123456789"], bot_user_id: "U_BOT" } },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
  assert.deepEqual(slackTrackerOptions(settings).channels, ["D0123456789"]);
  validateSlackDispatch(settings);
});

test("slack tracker rejects an assignee: messages have no assignee to filter on", () => {
  // Silently accepting it would mark every issue dispatchable on every instance, defeating
  // an assignee-partitioned deployment.
  assert.throws(
    () =>
      validateSlackDispatch(
        parseSlackConfig(
          {
            tracker: {
              kind: "slack",
              channels: ["C1"],
              bot_user_id: "U1",
              assignee: "worker@example.com",
            },
          },
          { SLACK_BOT_TOKEN: "xoxb" },
        ),
      ),
    /assignee is not supported/,
  );
});

test("emoji_states parses to the same options identity regardless of YAML key order", () => {
  // The MCP auth scope hashes nested option records in insertion order; a semantically
  // identical reorder of the workflow file must not change the parsed identity.
  const a = parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1"],
        bot_user_id: "U1",
        emoji_states: { rocket: "Shipped", wrench: "Rework" },
      },
    },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
  const b = parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1"],
        bot_user_id: "U1",
        emoji_states: { wrench: "Rework", rocket: "Shipped" },
      },
    },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
  assert.equal(JSON.stringify(a.tracker.options), JSON.stringify(b.tracker.options));
});
