import { parseConfig } from "@lorenz/config";
import type { Settings } from "@lorenz/domain";
import { TrackerRegistry } from "@lorenz/tracker-sdk";

import {
  discordTrackerProvider,
  type DiscordMessage,
  type DiscordReaction,
} from "@lorenz/discord-tracker";

export const GUILD_ID = "123456789012345678";
export const CHANNEL_ID = "223456789012345678";
export const BOT_ID = "423456789012345678";
export const BOT_ROLE_ID = "473456789012345678";
export const USER_ID = "523456789012345678";

export const discordTrackers = new TrackerRegistry();
discordTrackers.register(discordTrackerProvider);

export function parseDiscordConfig(
  config: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
): Settings {
  return parseConfig(
    {
      tracker: {
        kind: "discord",
        guild_id: GUILD_ID,
        channels: [CHANNEL_ID],
        bot_user_id: BOT_ID,
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done", "Cancelled"],
        ...config,
      },
    },
    { DISCORD_BOT_TOKEN: "discord-token", ...env },
    {},
    discordTrackers,
  );
}

export function message(
  overrides: Partial<DiscordMessage> & Pick<DiscordMessage, "id">,
): DiscordMessage {
  return {
    id: overrides.id,
    channelId: CHANNEL_ID,
    content: `<@${BOT_ID}> investigate #route-backend`,
    timestamp: "2026-07-16T00:00:00.000Z",
    authorId: USER_ID,
    authorName: "requester",
    authorBot: false,
    mentionUserIds: [BOT_ID],
    mentionRoleIds: [],
    botRoleIds: [],
    reactions: [] as DiscordReaction[],
    hasThread: false,
    ...overrides,
  };
}
