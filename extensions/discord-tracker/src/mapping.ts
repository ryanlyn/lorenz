import type { Settings } from "@lorenz/domain";
import { defaultStateType } from "@lorenz/issue";

import { discordTrackerOptions } from "./options.js";
import type { DiscordMessage } from "./transport.js";

export const DEFAULT_DISCORD_EMOJI_STATES: Record<string, string> = {
  "👀": "In Progress",
  "✅": "Done",
  "❌": "Cancelled",
};

export function isBotMention(message: DiscordMessage, botUserId?: string): boolean {
  if (botUserId === undefined) return false;
  return (
    message.mentionUserIds.includes(botUserId) ||
    message.mentionRoleIds.some((roleId) => message.botRoleIds.includes(roleId))
  );
}

export function isAllowedAuthor(message: DiscordMessage, allowedUsers: string[]): boolean {
  if (message.authorBot) return false;
  if (allowedUsers.length === 0) return true;
  return message.authorId !== undefined && allowedUsers.includes(message.authorId);
}

export function isBotMarked(message: DiscordMessage, markerEmoji: string): boolean {
  return message.reactions.some((reaction) => reaction.me && reaction.emoji === markerEmoji);
}

export function stripLeadingMention(
  text: string,
  botUserId?: string,
  botRoleIds: string[] = [],
): string {
  if (botUserId) {
    const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stripped = text.replace(new RegExp(`^<@!?${escaped}>\\s*`), "");
    if (stripped !== text) return stripped;
  }
  for (const roleId of botRoleIds) {
    const escaped = roleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stripped = text.replace(new RegExp(`^<@&${escaped}>\\s*`), "");
    if (stripped !== text) return stripped;
  }
  return text;
}

export function statusEmojiMap(settings: Settings): Record<string, string> {
  return Object.assign(
    Object.create(null) as Record<string, string>,
    DEFAULT_DISCORD_EMOJI_STATES,
    discordTrackerOptions(settings).emojiStates ?? {},
  );
}

function stateRank(state: string, settings?: Settings): number {
  switch (defaultStateType(state)) {
    case "canceled":
      return 4;
    case "completed":
      return 3;
    case "started":
      return 2;
    case "backlog":
    case "unstarted":
    case "triage":
      return 1;
    default:
      break;
  }
  if (settings) {
    const target = state.trim().toLowerCase();
    if (settings.tracker.terminalStates.some((candidate) => candidate.toLowerCase() === target)) {
      return 3;
    }
    if (settings.tracker.activeStates.some((candidate) => candidate.toLowerCase() === target)) {
      return 2;
    }
  }
  return 0;
}

export function stateFromReactions(
  reactions: string[],
  map: Record<string, string>,
  settings?: Settings,
): string {
  let best: string | null = null;
  let bestRank = -1;
  for (const reaction of reactions) {
    const state = map[reaction];
    if (typeof state !== "string") continue;
    if (
      settings &&
      ![...settings.tracker.activeStates, ...settings.tracker.terminalStates].some(
        (candidate) => candidate.trim().toLowerCase() === state.trim().toLowerCase(),
      )
    ) {
      continue;
    }
    const rank = stateRank(state, settings);
    if (rank > bestRank) {
      best = state;
      bestRank = rank;
    }
  }
  return best ?? settings?.tracker.activeStates[0] ?? "Todo";
}

export function emojiForState(state: string, map: Record<string, string>): string | null {
  const target = state.trim().toLowerCase();
  for (const [emoji, mapped] of Object.entries(map)) {
    if (mapped.trim().toLowerCase() === target) return emoji;
  }
  return null;
}
