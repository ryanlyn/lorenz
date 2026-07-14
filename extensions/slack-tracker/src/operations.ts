import type { Settings } from "@lorenz/domain";

import { emojiForState, isAllowedAuthor, isBotMention, statusEmojiMap } from "./mapping.js";
import { slackTrackerOptions } from "./options.js";
import { BOT_STATUS_PREFIX, resolveStateName } from "./threadState.js";
import type { SlackMessage, SlackTransport } from "./transport.js";

/**
 * The configured bot user id, or a clear configuration error. Every agent-facing read and
 * write requires it: without one the mention matcher would fall back to matching ANY user
 * mention, so the tools fail closed instead of operating on (or revealing) untracked messages.
 */
export function requireBotUserId(settings: Settings): string {
  const { botUserId } = slackTrackerOptions(settings);
  if (!botUserId || botUserId.trim() === "") {
    throw new Error(
      "slack tools are unavailable: tracker.bot_user_id (or SLACK_BOT_USER_ID) is not configured",
    );
  }
  return botUserId;
}

/**
 * Enforce the agent trust boundary: the issueId must reference a configured (watched) channel
 * and an existing message that is tracked - the root mentions the bot, the bot has marked it
 * (its own reaction), or a thread reply mentions the bot. Throws with a caller-facing message
 * otherwise.
 */
export async function requireTrackedMessage(
  settings: Settings,
  transport: SlackTransport,
  channel: string,
  ts: string,
): Promise<SlackMessage> {
  const { channels, users } = slackTrackerOptions(settings);
  const botUserId = requireBotUserId(settings);
  if (!channels.includes(channel)) {
    throw new Error(`channel '${channel}' is not a configured tracker channel`);
  }
  const message = await transport.getMessage(channel, ts);
  if (!message) {
    throw new Error(`no tracked issue at ${channel}:${ts}`);
  }
  // A root the bot already marked (its own reaction) stays tracked regardless of the author
  // allowlist: it was accepted on an earlier poll, so tightening `users` later must not orphan
  // an issue the agent is mid-flight on. New tracking honors the allowlist on the author.
  if (
    (isBotMention(message.text, botUserId) && isAllowedAuthor(message.user, users)) ||
    message.botReacted === true
  ) {
    return message;
  }
  // Reply-tracked thread: the request lives in a reply rather than the root. Last resort
  // because it costs a conversations.replies fetch.
  if ((message.replyCount ?? 0) > 0) {
    const replies = await transport.getThread(channel, ts);
    if (
      replies.some(
        (reply) => isBotMention(reply.text, botUserId) && isAllowedAuthor(reply.user, users),
      )
    )
      return message;
  }
  throw new Error("message is not a tracked bot-mention issue");
}

/** Outcome of a status transition; `root` is the tracked root fetched for the trust check. */
export type SlackStatusUpdateOutcome =
  | { ok: true; status: string; root: SlackMessage }
  | { ok: false; message: string };

/**
 * Set a Slack issue's status by posting the bot's authoritative `status: <Name>` thread reply.
 *
 * The thread is the source of truth (see threadState.ts): the posted reply is ts-ordered
 * against human commands and is acknowledged by Slack, so there is nothing to roll back or
 * verify. The bot then mirrors the state onto its OWN reactions best-effort for glanceability -
 * reactions are per-author in Slack, so the mirror never touches (and never depends on
 * removing) anyone else's reactions, and mirror failures never fail the transition.
 */
export async function updateSlackStatus(
  settings: Settings,
  transport: SlackTransport,
  channel: string,
  ts: string,
  status: string,
): Promise<SlackStatusUpdateOutcome> {
  const canonical = resolveStateName(status, settings);
  if (canonical === null) {
    return {
      ok: false,
      message:
        `unknown status '${status}': use one of the workflow's active/terminal states ` +
        `(${[...settings.tracker.activeStates, ...settings.tracker.terminalStates].join(", ")})`,
    };
  }
  // Trust-boundary check: the agent-supplied issueId must point at a watched channel and a
  // tracked message before we write into its thread.
  const root = await requireTrackedMessage(settings, transport, channel, ts);
  await transport.postReply(channel, ts, `${BOT_STATUS_PREFIX} ${canonical}`);
  await mirrorStatusReaction(settings, transport, channel, ts, canonical, root.reactions);
  return { ok: true, status: canonical, root };
}

/**
 * Best-effort visibility mirror: add the bot's reaction for the new state (when one is mapped)
 * and drop the bot's own other managed reactions. `reactions.remove` only removes the caller's
 * own reaction, so human-authored reactions are untouched by construction.
 *
 * `observed` is the reaction-name snapshot of the message (from the trust-check fetch or the
 * poll scan). Slack reads report every reaction NAME on a message (only the per-reaction user
 * lists are truncated), so an emoji absent from the snapshot is absent for every author,
 * including the bot - removing it is a guaranteed no-op. Intersecting the managed set with the
 * snapshot cuts a mirror update from one Tier-3 `reactions.remove` per managed emoji (a dozen
 * rate-limited calls each, multiplied across a cold startup heal pass) down to one per emoji
 * actually present; a mirror that is merely missing its target costs a single `reactions.add`.
 * When no snapshot is available, fall back to sweeping the full managed set.
 */
export async function mirrorStatusReaction(
  settings: Settings,
  transport: SlackTransport,
  channel: string,
  ts: string,
  state: string,
  observed?: readonly string[],
): Promise<void> {
  const map = statusEmojiMap(settings);
  const target = emojiForState(state, map);
  const managed = Object.keys(map);
  for (const emoji of managed) {
    if (emoji === target) continue;
    if (observed !== undefined && !observed.includes(emoji)) continue;
    try {
      await transport.removeReaction(channel, ts, emoji);
    } catch {
      // Mirror only; the thread reply already carries the authoritative state.
    }
  }
  if (target) {
    try {
      await transport.addReaction(channel, ts, target);
    } catch {
      // Mirror only; the thread reply already carries the authoritative state.
    }
  }
}
