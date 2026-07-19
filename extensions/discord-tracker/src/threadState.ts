import type { Settings } from "@lorenz/domain";

import { isAllowedAuthor, isBotMention, stateFromReactions, statusEmojiMap } from "./mapping.js";
import { discordTrackerOptions } from "./options.js";
import type { DiscordMessage } from "./transport.js";

export const BOT_STATUS_PREFIX = "status:";
const BOT_STATUS_RE = /^status:\s*(.+?)\s*$/i;

export function resolveStateName(name: string, settings: Settings): string | null {
  const target = name.trim().toLowerCase();
  if (target === "") return null;
  return (
    [...settings.tracker.activeStates, ...settings.tracker.terminalStates].find(
      (state) => state.trim().toLowerCase() === target,
    ) ?? null
  );
}

export function botStatusRecord(content: string): string | null {
  return BOT_STATUS_RE.exec(content.trim())?.[1] ?? null;
}

export function inProgressState(settings: Settings): string {
  return (
    resolveStateName("In Progress", settings) ??
    settings.tracker.activeStates[1] ??
    settings.tracker.activeStates[0] ??
    "Todo"
  );
}

export function stateFromThread(
  root: DiscordMessage,
  messages: DiscordMessage[],
  settings: Settings,
): string {
  const { botUserId, users } = discordTrackerOptions(settings);
  const ordered = [...messages].sort((left, right) => {
    const timestampOrder = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    return timestampOrder || left.id.localeCompare(right.id);
  });
  let state = stateFromReactions(
    root.reactions.filter((reaction) => reaction.me).map((reaction) => reaction.emoji),
    statusEmojiMap(settings),
    settings,
  );

  for (const message of ordered) {
    if (botUserId !== undefined && message.authorId === botUserId) {
      const recorded = botStatusRecord(message.content);
      if (recorded !== null) {
        const resolved = resolveStateName(recorded, settings);
        if (resolved) state = resolved;
      }
      continue;
    }
    if (!isBotMention(message, botUserId) || !isAllowedAuthor(message, users)) continue;
    state = inProgressState(settings);
  }
  return state;
}
