import type { Settings } from "@symphony/domain";

import { emojiForState, isBotMention, stateFromReactions, statusEmojiMap } from "./mapping.js";
import { slackTrackerOptions } from "./options.js";
import type { SlackMessage, SlackTransport } from "./transport.js";

/**
 * Outcome of a status swap. Failures carry the observed managed-reaction set when the message
 * may no longer rank to the original status, so callers never report a trustworthy "unchanged".
 */
export type SlackStatusUpdateOutcome =
  | { ok: true; status: string }
  | { ok: false; message: string; currentManagedReactions?: string[] };

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
 * and an existing message that is a tracked bot-mention. Throws with a caller-facing message
 * otherwise.
 */
export async function requireTrackedMessage(
  settings: Settings,
  transport: SlackTransport,
  channel: string,
  ts: string,
): Promise<SlackMessage> {
  const { channels } = slackTrackerOptions(settings);
  const botUserId = requireBotUserId(settings);
  if (!channels.includes(channel)) {
    throw new Error(`channel '${channel}' is not a configured tracker channel`);
  }
  const message = await transport.getMessage(channel, ts);
  if (!message) {
    throw new Error(`no tracked issue at ${channel}:${ts}`);
  }
  if (!isBotMention(message.text, botUserId)) {
    throw new Error("message is not a tracked bot-mention issue");
  }
  return message;
}

/**
 * Set a Slack issue's status by swapping its managed status-emoji reaction, treating the swap
 * as a transaction over the message's managed-reaction set.
 *
 * Add the target first (when absent), then remove every stale managed reaction. On ANY failure,
 * restore the ORIGINAL managed-reaction set best-effort so a partial failure preserves the OLD
 * status, never the wrong new status and never empty. The read path ranks reactions by category,
 * so a lingering higher-ranked stale reaction (or a half-removed set) would otherwise shadow the
 * target and mis-report. The effective end state is verified by re-fetching, never assumed.
 */
export async function updateSlackStatus(
  settings: Settings,
  transport: SlackTransport,
  channel: string,
  ts: string,
  status: string,
): Promise<SlackStatusUpdateOutcome> {
  const map = statusEmojiMap(settings);
  const target = emojiForState(status, map);
  if (!target) {
    return { ok: false, message: `No emoji configured for status '${status}'.` };
  }
  const canonicalState = map[target] ?? status;
  // Trust-boundary check: the agent-supplied issueId must point at a watched channel and a
  // message that is actually a tracked bot-mention issue before we mutate it.
  const message = await requireTrackedMessage(settings, transport, channel, ts);
  const present = message.reactions.filter((r) => map[r]);
  let added = false;
  const removed: string[] = [];
  // Roll back to the original managed-reaction set: re-add every stale reaction we removed
  // and drop the target if we added it. Secondary errors are swallowed (best-effort).
  const rollback = async (): Promise<void> => {
    for (const reaction of removed) {
      try {
        await transport.addReaction(channel, ts, reaction);
      } catch {
        // Best-effort restore; keep the original failure as the reported outcome.
      }
    }
    if (added) {
      try {
        await transport.removeReaction(channel, ts, target);
      } catch {
        // Best-effort restore; keep the original failure as the reported outcome.
      }
    }
  };
  // Slack custom emoji aliases are returned under their canonical name. Treat any managed
  // reaction mapped to the requested state as the target so an alias such as `check_mark`
  // -> `green-check-mark` is not re-added and then removed as stale.
  if (!present.some((reaction) => sameState(map[reaction]!, canonicalState))) {
    try {
      await transport.addReaction(channel, ts, target);
      added = true;
    } catch (error) {
      // Adding the new status failed; leave every existing reaction untouched so the
      // prior status is preserved rather than erased. No removes were attempted.
      return { ok: false, message: (error as Error).message };
    }
  }
  const stale = present.filter((reaction) => !sameState(map[reaction]!, canonicalState));
  for (const reaction of stale) {
    try {
      await transport.removeReaction(channel, ts, reaction);
      removed.push(reaction);
    } catch {
      // Cleanup failed mid-swap. Restore the original managed-reaction set (re-add every
      // stale reaction already removed and drop the just-added target) so the message ranks
      // to the OLD status rather than a wrong/partial one.
      await rollback();
      // Do not assume the best-effort rollback succeeded: a rollback removeReaction/addReaction
      // can fail during a real outage, leaving the wrong (advanced) status in place. Re-fetch
      // the message and verify the current managed-reaction set equals the ORIGINAL one.
      const current = await currentManagedReactions(transport, channel, ts, map);
      if (current && sameSet(current, present)) {
        // The original managed set is intact -> the old status is preserved.
        return { ok: false, message: "status not changed" };
      }
      // Either the re-fetch failed or the managed set drifted from the original. The message
      // may now read as the wrong (e.g. advanced) status, so do NOT claim it is unchanged.
      // Surface the ACTUAL managed reactions so the runtime/operator does not trust the prior
      // status.
      const observed = current ?? [];
      return {
        ok: false,
        message:
          "status update failed and could not be fully rolled back; " +
          `current managed reactions: ${observed.join(", ") || "(unknown)"}`,
        currentManagedReactions: observed,
      };
    }
  }
  // Every write resolved without error, but Slack's reactions.remove returns "no_reaction"
  // (treated as success) when the requestor is not the reaction's author - e.g. a HUMAN added
  // a managed emoji, so the bot cannot remove it. A "successful" remove therefore does not
  // guarantee the stale reaction is gone. Verify the EFFECTIVE end state instead of trusting
  // our writes: re-fetch and recompute the ranked status. Only report success if it matches
  // the requested status; otherwise a lingering (e.g. human-authored) reaction still shadows
  // the target and the read path would mis-report the OLD/wrong status.
  //
  // Compare against the target emoji's CANONICAL mapped state (map[target]), not the raw
  // agent-supplied `status` string: emojiForState resolves `status` case-insensitively, so a
  // caller passing "done" instead of "Done" would otherwise fail this exact-string equality
  // check on the success path even though the swap took effect, falsely reporting that a
  // correctly-applied update did not take effect.
  const effective = await currentManagedReactions(transport, channel, ts, map);
  if (effective === null) {
    // Every write succeeded but the verification re-fetch failed, so the end state is UNKNOWN -
    // distinct from a verified mismatch. Stay fail-closed (a "success" here could mask a
    // human-authored shadowing reaction), but say what actually happened so the caller re-checks
    // instead of treating an applied update as a failed one.
    return {
      ok: false,
      message:
        `status update could not be verified: the reaction writes for '${status}' succeeded but ` +
        "the message could not be re-fetched; re-check the issue's current status before retrying",
      currentManagedReactions: [],
    };
  }
  if (sameState(stateFromReactions(effective, map, settings), canonicalState)) {
    return { ok: true, status: canonicalState };
  }
  return {
    ok: false,
    message:
      `status update did not take effect; requested '${status}' but current managed ` +
      `reactions resolve to '${stateFromReactions(effective, map, settings)}'; ` +
      `current managed reactions: ${effective.join(", ") || "(none)"}`,
    currentManagedReactions: effective,
  };
}

/**
 * Re-fetch the message and return its current managed-reaction set (those keyed in `map`).
 * Returns `null` if the message can no longer be fetched, so callers can distinguish a verified
 * empty set from an unknown one.
 */
async function currentManagedReactions(
  transport: SlackTransport,
  channel: string,
  ts: string,
  map: Record<string, string>,
): Promise<string[] | null> {
  let message: SlackMessage | null;
  try {
    message = await transport.getMessage(channel, ts);
  } catch {
    return null;
  }
  if (!message) return null;
  return message.reactions.filter((r) => map[r]);
}

/** Compare two state names case-insensitively, mirroring emojiForState's lookup semantics. */
function sameState(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Compare two reaction lists as sets (order- and duplicate-insensitive). */
function sameSet(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}
