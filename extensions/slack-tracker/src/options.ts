import type { Settings } from "@lorenz/domain";
import { isRecord } from "@lorenz/domain";
import { stringListOption, stringOption } from "@lorenz/tracker-sdk";

export const SLACK_DEFAULT_ENDPOINT = "https://slack.com/api";

/** Slack-specific keys of the selected tracker bundle, validated by the provider. */
export interface SlackTrackerOptions {
  /**
   * Slack conversation IDs to watch for mentions. Public/private channels (`C…`/`G…`) and
   * direct-message channels (`D…`) are treated identically: the bot-mention requirement applies
   * to all of them, so a DM is watched by listing its `D…` id here.
   */
  channels: string[];
  /**
   * Slack user id of the bot/worker identity (e.g. `"U0123ABCD"`). Only messages that
   * mention this user become candidate issues; the production transport fails closed
   * (matches nothing) when it is unset.
   */
  botUserId?: string | undefined;
  /**
   * Slack app-level token (`xapp-...`) with the `connections:write` scope, enabling Socket Mode
   * push: the client opens a WebSocket to Slack and re-polls the instant a watched mention or
   * thread reply arrives, instead of waiting out `polling.intervalMs`. Optional; when unset the
   * tracker is pull-only (interval polling), exactly as before. Bot-token reads/writes are
   * unaffected either way - this token is used ONLY to open the events socket.
   */
  appToken?: string | undefined;
  /**
   * Optional allowlist of Slack user ids (e.g. `"U0123ABCD"`) whose messages may create issues.
   * Empty means no author constraint (any author, as long as the bot is mentioned). When
   * non-empty, only these users' bot-mentions become issues - the way to constrain dispatch to a
   * known set of requesters, which is what makes a watched DM channel (anyone can DM the bot)
   * safe. It only narrows dispatch; the bot-mention requirement still applies on top of it.
   */
  users: string[];
  /** Slack emoji-name → workflow-state overrides (merged over the defaults). */
  emojiStates?: Record<string, string> | undefined;
  /** Emoji the bot reacts with to mark a reply-tracked thread root (default `robot_face`). */
  markerEmoji?: string | undefined;
  /**
   * How far back (days) untracked threads are inspected for new reply-mention requests
   * (default 2). Already-tracked threads are recognized by the marker regardless of age.
   */
  replyLookbackDays?: number | undefined;
}

/** Typed view over `settings.tracker.options` for the Slack provider. */
export function slackTrackerOptions(settings: Settings): SlackTrackerOptions {
  const options = settings.tracker.options;
  const botUserId = stringOption(options, "botUserId");
  const appToken = stringOption(options, "appToken");
  const emojiStates = emojiStatesValue(options.emojiStates);
  const markerEmoji = stringOption(options, "markerEmoji");
  const replyLookbackDays = numberOption(options, "replyLookbackDays");
  return {
    channels: stringListOption(options, "channels") ?? [],
    users: stringListOption(options, "users") ?? [],
    ...(botUserId !== undefined ? { botUserId } : {}),
    ...(appToken !== undefined ? { appToken } : {}),
    ...(emojiStates !== undefined ? { emojiStates } : {}),
    ...(markerEmoji !== undefined ? { markerEmoji } : {}),
    ...(replyLookbackDays !== undefined ? { replyLookbackDays } : {}),
  };
}

/** Read an optional non-negative number option; throws when present but malformed. */
export function numberOption(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`tracker.${key} must be a non-negative number`);
  }
  return value;
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
