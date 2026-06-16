import type { TrackerProvider } from "@lorenz/tracker-sdk";
import {
  rejectUnknownOptions,
  resolveEnvReference,
  stringListOption,
  stringOption,
} from "@lorenz/tracker-sdk";

import { SlackTrackerClient } from "./client.js";
import {
  emojiStatesValue,
  numberOption,
  SLACK_DEFAULT_ENDPOINT,
  slackTrackerOptions,
} from "./options.js";
import { slackToolOps } from "./toolOps.js";
import { SlackWebTransport } from "./webTransport.js";

/**
 * Slack tracker: an @-mention of the bot is an issue, the message's thread carries the status
 * (human `@bot` commands and bot `status:` replies, latest wins; reactions are a bot-owned
 * visibility mirror) and the progress discussion. Issues are polled from the watched channels
 * over the Slack Web API.
 */
export const slackTrackerProvider: TrackerProvider = {
  kind: "slack",
  configAliases: {
    bot_user_id: "botUserId",
    emoji_states: "emojiStates",
    marker_emoji: "markerEmoji",
    reply_lookback_days: "replyLookbackDays",
  },
  envFallbacks: { apiKey: "SLACK_BOT_TOKEN" },
  defaultEndpoint: SLACK_DEFAULT_ENDPOINT,
  parseOptions(options, context) {
    rejectUnknownOptions(
      options,
      ["channels", "botUserId", "emojiStates", "markerEmoji", "replyLookbackDays"],
      "slack",
    );
    // Channel entries resolve `$VAR` references like the documented bot_user_id one line below
    // them; an unresolved reference collapses to empty and is dropped, so an all-empty list
    // fails dispatch validation instead of polling a literal "$SLACK_CHANNEL_ID" forever.
    const channels = stringListOption(options, "channels")
      ?.map((channel) => resolveEnvReference(channel, context.env))
      .filter((channel) => channel !== "");
    const botUserId = context.resolveSecret?.(
      stringOption(options, "botUserId"),
      "SLACK_BOT_USER_ID",
    );
    const emojiStates = emojiStatesValue(options.emojiStates);
    const markerEmoji = stringOption(options, "markerEmoji");
    const replyLookbackDays = numberOption(options, "replyLookbackDays");
    return {
      ...(channels !== undefined && channels.length > 0 ? { channels } : {}),
      ...(botUserId !== undefined ? { botUserId } : {}),
      ...(emojiStates !== undefined ? { emojiStates } : {}),
      ...(markerEmoji !== undefined ? { markerEmoji } : {}),
      ...(replyLookbackDays !== undefined ? { replyLookbackDays } : {}),
    };
  },
  validateDispatch(settings) {
    if (!settings.tracker.apiKey) {
      throw new Error("tracker.api_key (or SLACK_BOT_TOKEN) is required for the slack tracker");
    }
    if (settings.tracker.assignee) {
      // Fail fast rather than silently dispatch everything: slack messages carry no assignee
      // concept, so an assignee-partitioned deployment would double-dispatch every mention.
      throw new Error(
        "tracker.assignee is not supported by the slack tracker; remove it (slack issues have " +
          "no assignee to filter on)",
      );
    }
    const { channels, botUserId } = slackTrackerOptions(settings);
    if (channels.length === 0) {
      throw new Error("tracker.channels is required for the slack tracker");
    }
    if (!botUserId || botUserId.trim() === "") {
      throw new Error(
        "tracker.bot_user_id (or SLACK_BOT_USER_ID) is required for the slack tracker so issue " +
          "creation is scoped to the bot's own mentions; without it any human-to-human mention " +
          "in a watched channel would spawn an agent",
      );
    }
  },
  createClient: (settings) => new SlackTrackerClient(settings, new SlackWebTransport(settings)),
  createToolOps: (settings, context) => slackToolOps(settings, context),
  defaultToolPacks: () => ["slack"],
  projectUrl(settings) {
    // slack.com/app_redirect opens the channel in whichever workspace the operator is signed
    // into - the only deterministic deep link available without an API round-trip.
    const channel = slackTrackerOptions(settings).channels[0];
    return channel
      ? `https://slack.com/app_redirect?channel=${encodeURIComponent(channel)}`
      : undefined;
  },
};
