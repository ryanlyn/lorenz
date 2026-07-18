import { acpExecutorProvider } from "@lorenz/acp";
import { AgentExecutorRegistry } from "@lorenz/agent-sdk";
import { validateDispatchConfig } from "@lorenz/config";
import { ToolRegistry } from "@lorenz/tool-sdk";
import { TrackerRegistry } from "@lorenz/tracker-sdk";
import { assert } from "@lorenz/test-utils";
import { test } from "vitest";

import {
  BOT_ID,
  CHANNEL_ID,
  GUILD_ID,
  USER_ID,
  discordTrackers,
  parseDiscordConfig,
} from "./helpers.js";

import { discordTrackerOptions, registerDiscordTracker } from "@lorenz/discord-tracker";

const executors = new AgentExecutorRegistry();
executors.register(acpExecutorProvider);

test("parses Discord ids, emoji states, and environment fallbacks", () => {
  const settings = parseDiscordConfig(
    {
      guild_id: "$DISCORD_GUILD_ID",
      channels: ["$DISCORD_CHANNEL_ID"],
      bot_user_id: "$DISCORD_BOT_USER_ID",
      users: ["$DISCORD_USER_ID"],
      emoji_states: { "🚀": "Shipped" },
      scan_lookback_days: 30,
    },
    {
      DISCORD_GUILD_ID: GUILD_ID,
      DISCORD_CHANNEL_ID: CHANNEL_ID,
      DISCORD_BOT_USER_ID: BOT_ID,
      DISCORD_USER_ID: USER_ID,
    },
  );

  assert.equal(settings.tracker.endpoint, "https://discord.com/api/v10");
  assert.deepEqual(discordTrackerOptions(settings), {
    guildId: GUILD_ID,
    channels: [CHANNEL_ID],
    botUserId: BOT_ID,
    users: [USER_ID],
    emojiStates: { "🚀": "Shipped" },
    scanLookbackDays: 30,
  });
});

test("drops unresolved id references and rejects incomplete dispatch configuration", () => {
  const settings = parseDiscordConfig({ channels: ["$MISSING_CHANNEL"] });
  assert.deepEqual(discordTrackerOptions(settings).channels, []);
  assert.throws(
    () => validateDispatchConfig(settings, discordTrackers, executors),
    /channels is required/,
  );

  const noToken = parseDiscordConfig({}, { DISCORD_BOT_TOKEN: "" });
  assert.throws(
    () => validateDispatchConfig(noToken, discordTrackers, executors),
    /DISCORD_BOT_TOKEN/,
  );
});

test("fails closed when a configured requester allowlist entry resolves empty", () => {
  assert.throws(
    () => parseDiscordConfig({ users: ["$MISSING_REQUESTER"] }),
    /tracker\.users\[0\] resolved to an empty value/,
  );

  const unrestricted = parseDiscordConfig({ users: [] });
  assert.deepEqual(discordTrackerOptions(unrestricted).users, []);
});

test("validates stable Discord snowflake ids and rejects assignee partitioning", () => {
  const malformed = parseDiscordConfig({ guild_id: "guild-name" });
  assert.throws(
    () => validateDispatchConfig(malformed, discordTrackers, executors),
    /guild_id must be a 17-20 digit Discord id/,
  );

  const assigned = parseDiscordConfig({ assignee: "me" });
  assert.throws(
    () => validateDispatchConfig(assigned, discordTrackers, executors),
    /assignee is not supported/,
  );
});

test("rejects unknown options and malformed emoji mappings", () => {
  assert.throws(
    () => parseDiscordConfig({ channnels: [CHANNEL_ID] }),
    /unsupported tracker option/,
  );
  assert.throws(
    () => parseDiscordConfig({ emoji_states: { "✅": 7 } }),
    /emoji_states\.✅ must be a string/,
  );
});

test("registers the tracker and tool pack idempotently", () => {
  const trackers = new TrackerRegistry();
  const tools = new ToolRegistry();
  registerDiscordTracker({ trackers, tools });
  registerDiscordTracker({ trackers, tools });
  assert.equal(trackers.require("discord").kind, "discord");
  assert.equal(tools.get("discord")?.name, "discord");
});
