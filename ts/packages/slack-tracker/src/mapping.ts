import type { Settings } from "@symphony/domain";

export const DEFAULT_EMOJI_STATES: Record<string, string> = {
  eyes: "In Progress",
  white_check_mark: "Done",
  x: "Cancelled",
};

export function statusEmojiMap(settings: Settings): Record<string, string> {
  return { ...DEFAULT_EMOJI_STATES, ...(settings.tracker.emojiStates ?? {}) };
}

/** Derive state from the reactions present; the first matching status emoji wins, else "Todo". */
export function stateFromReactions(reactions: string[], map: Record<string, string>): string {
  for (const reaction of reactions) {
    const state = map[reaction];
    if (state) return state;
  }
  return "Todo";
}

/** Reverse lookup: the emoji name whose mapped state equals `state` (case-insensitive). */
export function emojiForState(state: string, map: Record<string, string>): string | null {
  const target = state.trim().toLowerCase();
  for (const [emoji, mapped] of Object.entries(map)) {
    if (mapped.trim().toLowerCase() === target) return emoji;
  }
  return null;
}
