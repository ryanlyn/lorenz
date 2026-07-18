import type { Settings } from "@lorenz/domain";
import { isRecord } from "@lorenz/domain";
import { stringListOption, stringOption } from "@lorenz/tracker-sdk";

export const DISCORD_DEFAULT_ENDPOINT = "https://discord.com/api/v10";

export interface DiscordTrackerOptions {
  /** Discord guild containing every watched channel. */
  guildId?: string | undefined;
  /** Guild text or announcement channel ids whose bot mentions become issues. */
  channels: string[];
  /** Discord user id of the bot identity. */
  botUserId?: string | undefined;
  /** Optional user-id allowlist for issue authors. Empty permits any non-bot author. */
  users: string[];
  /** Discord emoji key to workflow-state overrides, merged over the defaults. */
  emojiStates?: Record<string, string> | undefined;
  /** Fixed trailing history window for candidate scans. Zero or absent is unbounded. */
  scanLookbackDays?: number | undefined;
}

export function discordTrackerOptions(settings: Settings): DiscordTrackerOptions {
  const options = settings.tracker.options;
  const guildId = stringOption(options, "guildId");
  const botUserId = stringOption(options, "botUserId");
  const emojiStates = emojiStatesValue(options.emojiStates);
  const scanLookbackDays = numberOption(options, "scanLookbackDays");
  return {
    channels: stringListOption(options, "channels") ?? [],
    users: stringListOption(options, "users") ?? [],
    ...(guildId !== undefined ? { guildId } : {}),
    ...(botUserId !== undefined ? { botUserId } : {}),
    ...(emojiStates !== undefined ? { emojiStates } : {}),
    ...(scanLookbackDays !== undefined ? { scanLookbackDays } : {}),
  };
}

export function discordEndpoint(settings: Settings): string {
  return (settings.tracker.endpoint || DISCORD_DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

export function numberOption(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`tracker.${key} must be a non-negative number`);
  }
  return value;
}

export function emojiStatesValue(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new Error("tracker.emoji_states must be a mapping of emoji to state name");
  }
  const out: Record<string, string> = {};
  for (const [emoji, state] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (typeof state !== "string") {
      throw new Error(`tracker.emoji_states.${emoji} must be a string`);
    }
    out[emoji] = state;
  }
  return out;
}
