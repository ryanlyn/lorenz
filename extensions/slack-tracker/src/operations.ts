import type { Settings } from "@lorenz/domain";

import { emojiForState, isAllowedAuthor, isBotMention, statusEmojiMap } from "./mapping.js";
import { slackTrackerOptions } from "./options.js";
import {
  BOT_STATUS_PREFIX,
  resolveStateName,
  stateFromObservedThread,
  type ThreadState,
  type ThreadTracking,
} from "./threadState.js";
import { isBotMarked, STATUS_METADATA_EVENT, TRACKING_METADATA_EVENT } from "./transport.js";
import type { SlackMessage, SlackTransport } from "./transport.js";
import { makeMetadataSeq } from "./webTransport.js";

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
 * and an existing message that is tracked. Root mentions must still be eligible, or carry the
 * dedicated marker from an earlier accepted poll. Non-mention roots must retain an eligible
 * request reply, so a stale marker cannot keep an edited-away issue alive.
 */
export async function requireTrackedMessage(
  settings: Settings,
  transport: SlackTransport,
  channel: string,
  ts: string,
): Promise<SlackMessage> {
  const { channels, users, markerEmoji = "robot_face" } = slackTrackerOptions(settings);
  const botUserId = requireBotUserId(settings);
  if (!channels.includes(channel)) {
    throw new Error(`channel '${channel}' is not a configured tracker channel`);
  }
  const message = await transport.getMessage(channel, ts);
  if (!message) {
    throw new Error(`no tracked issue at ${channel}:${ts}`);
  }
  if (isBotMention(message.text, botUserId)) {
    // A dedicated marker records acceptance by an earlier poll. It keeps a root mention tracked
    // if the author allowlist is later tightened, while new issues still honor the allowlist.
    if (isAllowedAuthor(message.user, users) || isBotMarked(message, markerEmoji)) return message;
  }
  // Reply-tracked thread: reconstruct the accepted request from the thread. This check is also
  // what rejects a root mention edited away while the daemon was offline, even if its marker or
  // status mirror remains.
  if ((message.replyCount ?? 0) > 0) {
    const replies = await transport.getThread(channel, ts);
    if (stateFromObservedThread(message, replies, settings, transport).request !== undefined) {
      return message;
    }
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
  options: { attribution?: string; actor?: string } = {},
): Promise<SlackStatusUpdateOutcome> {
  const canonical = resolveStateName(status, settings);
  if (canonical === null) {
    return unknownStatusOutcome(status, settings);
  }
  // Trust-boundary check: the agent-supplied issueId must point at a watched channel and a
  // tracked message before we write into its thread.
  const root = await requireTrackedMessage(settings, transport, channel, ts);
  await ensureSlackTrackingRecord(settings, transport, root);
  // The reply text stays human-readable (`status: <Name>`, plus an optional attribution line for
  // e.g. button-initiated transitions), while the metadata is the machine-readable event the
  // fold prefers: only the posting app can attach metadata, so it cannot be forged, and the
  // unique `seq` lets an ambiguous outcome recover when the original reply is already visible in
  // the thread. If it is not visible yet, the post remains at-most-once and fails without retry.
  await postStatusReply(transport, channel, ts, canonical, options);
  await mirrorStatusReaction(settings, transport, channel, ts, canonical, root.botReactions);
  return { ok: true, status: canonical, root };
}

/**
 * Persist whether an accepted issue originated at its root or in a reply. The record lets later
 * reads preserve the original authorization decision and reject a root request whose mention was
 * edited away, without treating a later command or steering reply as a new request.
 */
export async function ensureSlackTrackingRecord(
  settings: Settings,
  transport: SlackTransport,
  root: SlackMessage,
  knownThread?: ThreadState,
): Promise<ThreadTracking | undefined> {
  const thread =
    knownThread ??
    stateFromObservedThread(
      root,
      await transport.getThread(root.channel, root.ts),
      settings,
      transport,
    );
  if (thread.tracking !== undefined) return thread.tracking;
  const botUserId = requireBotUserId(settings);
  const tracking: ThreadTracking | undefined = isBotMention(root.text, botUserId)
    ? { origin: "root" }
    : thread.request !== undefined
      ? { origin: "reply", requestTs: thread.request.ts }
      : undefined;
  if (tracking === undefined) return undefined;
  await transport.postReply(root.channel, root.ts, "Lorenz tracking record.", {
    metadata: {
      eventType: TRACKING_METADATA_EVENT,
      payload:
        tracking.origin === "root"
          ? { origin: "root" }
          : { origin: "reply", request_ts: tracking.requestTs },
    },
  });
  return tracking;
}

/**
 * Post a status selected from a workpad action.
 *
 * The action value comes from a bot-authored block delivered over authenticated Socket Mode, so
 * it does not need an API read to re-establish the tool trust boundary. The configured channel
 * and status are still validated before the append-only reply is posted. Reaction healing starts
 * in the background because it is display-only and can wait behind Slack rate limits without
 * delaying cancellation.
 */
export async function updateSlackStatusFromWorkpad(
  settings: Settings,
  transport: SlackTransport,
  channel: string,
  ts: string,
  status: string,
  options: { attribution?: string; actor?: string; onPosted?: () => void } = {},
): Promise<{ ok: true; status: string } | { ok: false; message: string }> {
  const canonical = resolveStateName(status, settings);
  if (canonical === null) {
    return unknownStatusOutcome(status, settings);
  }
  requireBotUserId(settings);
  if (!slackTrackerOptions(settings).channels.includes(channel)) {
    return { ok: false, message: `channel '${channel}' is not a configured tracker channel` };
  }
  const { onPosted, ...postOptions } = options;
  await postStatusReply(transport, channel, ts, canonical, postOptions);
  onPosted?.();
  void healStatusReactionFromCurrentRoot(settings, transport, channel, ts, canonical).catch(() => {
    // Display-only healing retries during normal tracker reconciliation.
  });
  return { ok: true, status: canonical };
}

function unknownStatusOutcome(status: string, settings: Settings): { ok: false; message: string } {
  return {
    ok: false,
    message:
      `unknown status '${status}': use one of the workflow's active/terminal states ` +
      `(${[...settings.tracker.activeStates, ...settings.tracker.terminalStates].join(", ")})`,
  };
}

async function postStatusReply(
  transport: SlackTransport,
  channel: string,
  ts: string,
  canonical: string,
  options: { attribution?: string; actor?: string },
): Promise<void> {
  const body =
    options.attribution === undefined
      ? `${BOT_STATUS_PREFIX} ${canonical}`
      : `${BOT_STATUS_PREFIX} ${canonical}\n${options.attribution}`;
  await transport.postReply(channel, ts, body, {
    metadata: {
      eventType: STATUS_METADATA_EVENT,
      payload: {
        issue: `${channel}:${ts}`,
        state: canonical,
        seq: makeMetadataSeq(),
        ...(options.actor !== undefined ? { actor: options.actor } : {}),
      },
    },
  });
}

async function healStatusReactionFromCurrentRoot(
  settings: Settings,
  transport: SlackTransport,
  channel: string,
  ts: string,
  state: string,
): Promise<void> {
  const root = await transport.getMessage(channel, ts);
  if (root === null) return;
  await mirrorStatusReaction(settings, transport, channel, ts, state, root.botReactions);
}

/**
 * Best-effort visibility mirror: add the bot's reaction for the new state (when one is mapped)
 * and drop the bot's other managed reactions. `reactions.remove` only removes the caller's own
 * reaction, so human-authored reactions are untouched by construction.
 *
 * `observed` is the snapshot of the BOT's own reactions on the message (from the trust-check
 * fetch or the poll scan). Only those can need removing, and reaction methods are Tier-3
 * rate-limited, so removals are the intersection of the managed set with the snapshot: a mirror
 * that is merely missing its target costs a single `reactions.add`, and a stale one costs one
 * remove per stale emoji rather than one per managed emoji.
 */
export async function mirrorStatusReaction(
  settings: Settings,
  transport: SlackTransport,
  channel: string,
  ts: string,
  state: string,
  observed: readonly string[],
): Promise<void> {
  const map = statusEmojiMap(settings);
  const target = emojiForState(state, map);
  const markerEmoji = slackTrackerOptions(settings).markerEmoji ?? "robot_face";
  if (!observed.includes(markerEmoji)) {
    try {
      await transport.addReaction(channel, ts, markerEmoji);
    } catch {
      // The status reply remains authoritative; the next poll retries the marker.
    }
  }
  for (const emoji of observed) {
    if (emoji === target || typeof map[emoji] !== "string") continue;
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
