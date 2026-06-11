import type { Settings } from "@symphony/domain";
import { isRecord } from "@symphony/domain";
import { stringListOption, stringOption } from "@symphony/tracker-sdk";

export const SLACK_DEFAULT_ENDPOINT = "https://slack.com/api";

/** Slack-specific keys of the `tracker:` config section, validated by the provider. */
export interface SlackTrackerOptions {
  /** Slack channel IDs to watch for mentions. */
  channels: string[];
  /**
   * Slack user id of the bot/worker identity (e.g. `"U0123ABCD"`). Only messages that
   * mention this user become candidate issues; the production transport fails closed
   * (matches nothing) when it is unset.
   */
  botUserId?: string | undefined;
  /** Slack emoji-name → workflow-state overrides (merged over the defaults). */
  emojiStates?: Record<string, string> | undefined;
}

/** Typed view over `settings.tracker.options` for the Slack provider. */
export function slackTrackerOptions(settings: Settings): SlackTrackerOptions {
  const options = settings.tracker.options;
  const botUserId = stringOption(options, "botUserId");
  const emojiStates = emojiStatesValue(options.emojiStates);
  return {
    channels: stringListOption(options, "channels") ?? [],
    ...(botUserId !== undefined ? { botUserId } : {}),
    ...(emojiStates !== undefined ? { emojiStates } : {}),
  };
}

/** The Slack Web API base URL for the configured tracker (trailing slashes stripped). */
export function slackEndpoint(settings: Settings): string {
  return (settings.tracker.endpoint || SLACK_DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

export function emojiStatesValue(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new Error("tracker.emoji_states must be a mapping of emoji name to state name");
  }
  const out: Record<string, string> = {};
  // Sorted keys: nested option records are hashed in insertion order by the MCP auth scope, so
  // a semantically identical YAML reorder must not change the parsed identity.
  for (const [emoji, state] of Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (typeof state !== "string")
      throw new Error(`tracker.emoji_states.${emoji} must be a string`);
    out[emoji] = state;
  }
  return out;
}
