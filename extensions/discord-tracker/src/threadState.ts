import type { Settings } from "@lorenz/domain";
import { defaultStateType } from "@lorenz/issue";

import {
  isAllowedAuthor,
  isBotMention,
  stateFromReactions,
  statusEmojiMap,
  stripLeadingMention,
} from "./mapping.js";
import { discordTrackerOptions } from "./options.js";
import type { DiscordMessage } from "./transport.js";

export const BOT_STATUS_PREFIX = "status:";
const BOT_STATUS_RE = /^status:\s*(.+?)\s*$/i;
const COMMAND_STATES: Array<{
  keywords: string[];
  state: (settings: Settings) => string | null;
}> = [
  {
    keywords: ["done", "complete", "completed", "finished"],
    state: (settings) => terminalState(settings, "Done"),
  },
  {
    keywords: ["cancel", "cancelled", "canceled", "stop"],
    state: (settings) => terminalState(settings, "Cancelled"),
  },
  { keywords: ["reopen", "rework", "retry"], state: reopenState },
  {
    keywords: ["in progress", "start", "started", "wip"],
    state: (settings) => activeState(settings, "In Progress"),
  },
  {
    keywords: ["todo", "backlog"],
    state: (settings) => activeState(settings, "Todo"),
  },
];

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

function reopenState(settings: Settings): string {
  return settings.tracker.activeStates[0] ?? "Todo";
}

function activeState(settings: Settings, preferred: string): string | null {
  return resolveStateName(preferred, settings) ?? settings.tracker.activeStates[0] ?? null;
}

function terminalState(settings: Settings, preferred: string): string | null {
  return resolveStateName(preferred, settings) ?? settings.tracker.terminalStates[0] ?? null;
}

function isTerminalState(state: string, settings: Settings): boolean {
  const target = state.trim().toLowerCase();
  if (settings.tracker.terminalStates.some((candidate) => candidate.toLowerCase() === target)) {
    return true;
  }
  const category = defaultStateType(state);
  return category === "completed" || category === "canceled";
}

export function parseStatusCommand(message: DiscordMessage, settings: Settings): string | null {
  const { botUserId } = discordTrackerOptions(settings);
  if (!isBotMention(message, botUserId)) return null;
  const stripped = stripLeadingMention(message.content.trim(), botUserId, message.botRoleIds);
  const firstLine = (stripped.split("\n")[0] ?? "").trim();
  if (!firstLine.startsWith("!")) return null;
  const body = firstLine
    .slice(1)
    .trim()
    .replace(/[.!?]+$/, "");
  const explicit = /^status:?\s+(.+)$/i.exec(body);
  if (explicit) return resolveStateName(explicit[1]!, settings);
  const lower = body.toLowerCase();
  for (const command of COMMAND_STATES) {
    if (command.keywords.includes(lower)) return command.state(settings);
  }
  return null;
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
    const command = parseStatusCommand(message, settings);
    if (command) state = command;
    else if (isTerminalState(state, settings)) state = reopenState(settings);
  }
  return state;
}
