import type { TrackerProvider } from "@lorenz/tracker-sdk";
import {
  rejectUnknownOptions,
  resolveEnvReference,
  stringListOption,
  stringOption,
} from "@lorenz/tracker-sdk";

import { DiscordTrackerClient, isDiscordSnowflake } from "./client.js";
import {
  DISCORD_DEFAULT_ENDPOINT,
  discordTrackerOptions,
  emojiStatesValue,
  numberOption,
} from "./options.js";
import { DiscordRestTransport } from "./restTransport.js";

export const discordTrackerProvider: TrackerProvider = {
  kind: "discord",
  configAliases: {
    guild_id: "guildId",
    bot_user_id: "botUserId",
    emoji_states: "emojiStates",
    scan_lookback_days: "scanLookbackDays",
  },
  envFallbacks: { apiKey: "DISCORD_BOT_TOKEN" },
  defaultEndpoint: DISCORD_DEFAULT_ENDPOINT,
  parseOptions(options, context) {
    rejectUnknownOptions(
      options,
      ["guildId", "channels", "botUserId", "users", "emojiStates", "scanLookbackDays"],
      "discord",
    );
    const guildId = context.resolveSecret?.(stringOption(options, "guildId"), "DISCORD_GUILD_ID");
    const botUserId = context.resolveSecret?.(
      stringOption(options, "botUserId"),
      "DISCORD_BOT_USER_ID",
    );
    const channels = resolveIdList(options, "channels", context.env);
    const users = resolveIdList(options, "users", context.env, true);
    const emojiStates = emojiStatesValue(options.emojiStates);
    const scanLookbackDays = numberOption(options, "scanLookbackDays");
    return {
      ...(guildId ? { guildId } : {}),
      ...(channels.length > 0 ? { channels } : {}),
      ...(botUserId ? { botUserId } : {}),
      ...(users.length > 0 ? { users } : {}),
      ...(emojiStates !== undefined ? { emojiStates } : {}),
      ...(scanLookbackDays !== undefined ? { scanLookbackDays } : {}),
    };
  },
  validateDispatch(settings) {
    if (!settings.tracker.apiKey) {
      throw new Error("tracker.api_key (or DISCORD_BOT_TOKEN) is required for the discord tracker");
    }
    if (settings.tracker.assignee) {
      throw new Error(
        "tracker.assignee is not supported by the discord tracker; remove it because Discord " +
          "messages have no assignee field",
      );
    }
    const tracker = discordTrackerOptions(settings);
    if (!tracker.guildId) {
      throw new Error("tracker.guild_id (or DISCORD_GUILD_ID) is required for the discord tracker");
    }
    if (!tracker.botUserId) {
      throw new Error(
        "tracker.bot_user_id (or DISCORD_BOT_USER_ID) is required for the discord tracker so " +
          "only mentions of this bot create issues",
      );
    }
    if (tracker.channels.length === 0) {
      throw new Error("tracker.channels is required for the discord tracker");
    }
    assertSnowflake(tracker.guildId, "tracker.guild_id");
    assertSnowflake(tracker.botUserId, "tracker.bot_user_id");
    tracker.channels.forEach((channel, index) =>
      assertSnowflake(channel, `tracker.channels[${index}]`),
    );
    tracker.users.forEach((user, index) => assertSnowflake(user, `tracker.users[${index}]`));
  },
  createClient(settings) {
    return new DiscordTrackerClient(settings, new DiscordRestTransport(settings));
  },
  defaultToolPacks: () => ["discord"],
  projectUrl(settings) {
    const tracker = discordTrackerOptions(settings);
    const channel = tracker.channels[0];
    return tracker.guildId && channel
      ? `https://discord.com/channels/${encodeURIComponent(tracker.guildId)}/${encodeURIComponent(channel)}`
      : undefined;
  },
};

function resolveIdList(
  options: Record<string, unknown>,
  key: string,
  env: NodeJS.ProcessEnv,
  rejectEmptyEntries = false,
): string[] {
  const resolved = (stringListOption(options, key) ?? []).map((value) =>
    resolveEnvReference(value, env),
  );
  if (rejectEmptyEntries) {
    const emptyIndex = resolved.findIndex((value) => value === "");
    if (emptyIndex !== -1) {
      throw new Error(
        `tracker.${key}[${emptyIndex}] resolved to an empty value; set the referenced environment variable or remove the allowlist entry`,
      );
    }
  }
  return [...new Set(resolved.filter((value) => value !== ""))];
}

function assertSnowflake(value: string, label: string): void {
  if (!isDiscordSnowflake(value)) {
    throw new Error(`${label} must be a 17-20 digit Discord id`);
  }
}
