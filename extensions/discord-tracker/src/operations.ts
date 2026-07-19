import type { Settings } from "@lorenz/domain";

import {
  emojiForState,
  isAllowedAuthor,
  isBotMarked,
  isBotMention,
  statusEmojiMap,
  stripLeadingMention,
} from "./mapping.js";
import { discordTrackerOptions } from "./options.js";
import { BOT_STATUS_PREFIX, resolveStateName } from "./threadState.js";
import type { DiscordMessage, DiscordTransport } from "./transport.js";

export function requireBotUserId(settings: Settings): string {
  const botUserId = discordTrackerOptions(settings).botUserId;
  if (!botUserId || botUserId.trim() === "") {
    throw new Error(
      "discord tools are unavailable: tracker.bot_user_id (or DISCORD_BOT_USER_ID) is not configured",
    );
  }
  return botUserId;
}

export async function requireTrackedMessage(
  settings: Settings,
  transport: DiscordTransport,
  channelId: string,
  messageId: string,
): Promise<DiscordMessage> {
  const tracker = discordTrackerOptions(settings);
  const botUserId = requireBotUserId(settings);
  if (!tracker.channels.includes(channelId)) {
    throw new Error(`channel '${channelId}' is not a configured tracker channel`);
  }
  const message = await transport.getMessage(channelId, messageId);
  if (!message) throw new Error(`no tracked issue at ${channelId}:${messageId}`);
  if (message.channelId !== channelId || message.id !== messageId) {
    throw new Error(`Discord returned a mismatched message for ${channelId}:${messageId}`);
  }
  const newlyEligible = isBotMention(message, botUserId) && isAllowedAuthor(message, tracker.users);
  if (!newlyEligible && !isBotMarked(message, tracker.markerEmoji)) {
    throw new Error("message is not a tracked Discord issue");
  }
  return message;
}

export async function ensureIssueThread(
  transport: DiscordTransport,
  root: DiscordMessage,
): Promise<string> {
  const trackerTitle = stripLeadingMention(root.content, undefined, root.botRoleIds).replace(
    /^<@!?\d+>\s*/,
    "",
  );
  const title = trackerTitle.trim();
  return transport.ensureThread(root, title || `Lorenz issue ${root.id}`);
}

export type DiscordTrackOutcome =
  | { ok: true; root: DiscordMessage; threadId: string; alreadyTracked: boolean }
  | { ok: false; message: string };

export async function trackDiscordMessage(
  settings: Settings,
  transport: DiscordTransport,
  channelId: string,
  messageId: string,
): Promise<DiscordTrackOutcome> {
  const tracker = discordTrackerOptions(settings);
  if (!tracker.channels.includes(channelId)) {
    return { ok: false, message: "That message is outside the configured tracker channels." };
  }
  const root = await transport.getMessage(channelId, messageId);
  if (!root || root.channelId !== channelId || root.id !== messageId) {
    return { ok: false, message: "Discord could not resolve that source message." };
  }
  if (!isAllowedAuthor(root, tracker.users)) {
    return { ok: false, message: "That message's author is not allowed to create Lorenz work." };
  }

  const alreadyTracked =
    isBotMention(root, tracker.botUserId) || isBotMarked(root, tracker.markerEmoji);
  if (!isBotMarked(root, tracker.markerEmoji)) {
    await transport.addReaction(channelId, messageId, tracker.markerEmoji);
  }
  const threadId = await ensureIssueThread(transport, root);
  if (!alreadyTracked) {
    const firstActive = settings.tracker.activeStates[0] ?? "Todo";
    await transport.postThreadMessage(threadId, `${BOT_STATUS_PREFIX} ${firstActive}`);
  }
  return { ok: true, root, threadId, alreadyTracked };
}

export type DiscordStatusUpdateOutcome =
  | { ok: true; status: string; root: DiscordMessage; threadId: string }
  | { ok: false; message: string };

export async function updateDiscordStatus(
  settings: Settings,
  transport: DiscordTransport,
  channelId: string,
  messageId: string,
  status: string,
): Promise<DiscordStatusUpdateOutcome> {
  const canonical = resolveStateName(status, settings);
  if (canonical === null) {
    return {
      ok: false,
      message:
        `unknown status '${status}': use one of the workflow's active/terminal states ` +
        `(${[...settings.tracker.activeStates, ...settings.tracker.terminalStates].join(", ")})`,
    };
  }
  const root = await requireTrackedMessage(settings, transport, channelId, messageId);
  const threadId = await ensureIssueThread(transport, root);
  await transport.postThreadMessage(threadId, `${BOT_STATUS_PREFIX} ${canonical}`);
  await mirrorStatusReaction(settings, transport, root, canonical);
  return { ok: true, status: canonical, root, threadId };
}

export async function mirrorStatusReaction(
  settings: Settings,
  transport: DiscordTransport,
  root: DiscordMessage,
  state: string,
): Promise<void> {
  const map = statusEmojiMap(settings);
  const target = emojiForState(state, map);
  const owned = root.reactions.filter((reaction) => reaction.me).map((reaction) => reaction.emoji);
  for (const emoji of owned) {
    if (emoji === target || typeof map[emoji] !== "string") continue;
    try {
      await transport.removeReaction(root.channelId, root.id, emoji);
    } catch {
      // The thread reply is authoritative; the source-message reaction is only a visual mirror.
    }
  }
  if (target && !owned.includes(target)) {
    try {
      await transport.addReaction(root.channelId, root.id, target);
    } catch {
      // The thread reply is authoritative; the source-message reaction is only a visual mirror.
    }
  }
}
