import type { Settings } from "@symphony/domain";
import { defaultStateType } from "@symphony/issue";

import { slackTrackerOptions } from "./options.js";

export const DEFAULT_EMOJI_STATES: Record<string, string> = {
  eyes: "In Progress",
  white_check_mark: "Done",
  x: "Cancelled",
};

/** Matches any Slack user mention, optionally in its piped `<@U123|label>` form. */
const ANY_MENTION = /<@[A-Z0-9_]+(\|[^>]*)?>/;

/** Escape a Slack user id for safe interpolation into a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex matching a mention of `botUserId` (plain `<@BOTID>` or piped `<@BOTID|label>`),
 * or any user mention when `botUserId` is not set (documented back-compat).
 */
function mentionRegExp(botUserId?: string): RegExp {
  if (!botUserId) return new RegExp(ANY_MENTION.source);
  return new RegExp(`<@${escapeRegExp(botUserId)}(\\|[^>]*)?>`);
}

/**
 * True when `text` mentions the bot. With `botUserId` set, only mentions of that specific user
 * count; without it, any `<@U...>` mention counts (back-compat).
 */
export function isBotMention(text: string, botUserId?: string): boolean {
  return mentionRegExp(botUserId).test(text);
}

/**
 * Strip a single leading bot mention (and following whitespace) from `text`. With `botUserId`
 * set, only that user's leading mention is stripped; without it, any leading `<@U...>` mention is.
 */
export function stripLeadingMention(text: string, botUserId?: string): string {
  const source = botUserId
    ? `^<@${escapeRegExp(botUserId)}(\\|[^>]*)?>\\s*`
    : `^${ANY_MENTION.source}\\s*`;
  return text.replace(new RegExp(source), "");
}

/**
 * The emoji-name → state map for the workflow. Built on a null prototype: reaction names come
 * straight from Slack and are used as lookup keys, so an emoji named `constructor` or
 * `__proto__` must read as "unmapped" rather than resolving to an inherited Object member.
 */
export function statusEmojiMap(settings: Settings): Record<string, string> {
  return Object.assign(
    Object.create(null) as Record<string, string>,
    DEFAULT_EMOJI_STATES,
    slackTrackerOptions(settings).emojiStates ?? {},
  );
}

/**
 * Rank a status by category so a more-advanced state wins over a less-advanced one. Canceled
 * outranks completed so that a cancellation deterministically overrides a completion when both
 * reactions are present, regardless of reaction order. Custom state names (no known category)
 * rank by their configured role: terminal states rank with completed and active states with
 * started, so a human-applied custom terminal reaction still closes an issue the agent marked
 * in-progress.
 */
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
    if (settings.tracker.terminalStates.some((s) => s.trim().toLowerCase() === target)) return 3;
    if (settings.tracker.activeStates.some((s) => s.trim().toLowerCase() === target)) return 2;
  }
  return 0;
}

/**
 * Derive state from the reactions present; the most-advanced mapped status wins (ties
 * broken by reaction order), else "Todo". Pass `settings` so custom state names rank by
 * their configured active/terminal role instead of falling to the bottom.
 */
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
    const rank = stateRank(state, settings);
    if (rank > bestRank) {
      best = state;
      bestRank = rank;
    }
  }
  return best ?? "Todo";
}

/** Reverse lookup: the emoji name whose mapped state equals `state` (case-insensitive). */
export function emojiForState(state: string, map: Record<string, string>): string | null {
  const target = state.trim().toLowerCase();
  for (const [emoji, mapped] of Object.entries(map)) {
    if (mapped.trim().toLowerCase() === target) return emoji;
  }
  return null;
}
