import {
  emojiForState,
  isBotMention,
  SlackWebTransport,
  splitIssueId,
  stateFromReactions,
  statusEmojiMap,
  type SlackMessage,
  type SlackTransport,
} from "@symphony/slack-tracker";
import type { Settings } from "@symphony/domain";

import type { ToolResult, ToolSpec } from "../tools.js";

const TOOL_NAMES = ["slack_update_status", "slack_comment", "slack_read_thread"] as const;

export function slackToolSpecs(): ToolSpec[] {
  return [
    {
      name: "slack_update_status",
      description:
        "Set a Slack issue's status by swapping its status emoji reaction. Args: issueId, status.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, status: { type: "string" } },
        required: ["issueId", "status"],
      },
    },
    {
      name: "slack_comment",
      description: "Reply in the Slack issue's thread. Args: issueId, body.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, body: { type: "string" } },
        required: ["issueId", "body"],
      },
    },
    {
      name: "slack_read_thread",
      description:
        "Read a Slack issue's source message (text, derived status, reactions) and its thread " +
        "replies. Args: issueId.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
      },
    },
  ];
}

export async function executeSlackTool(
  name: string,
  input: unknown,
  settings: Settings,
  transport: SlackTransport,
): Promise<ToolResult> {
  const args = isRecord(input) ? input : {};
  try {
    const parts = splitIssueId(requireStr(args, "issueId"));
    if (!parts) throw new Error("issueId must be in '<channel>:<ts>' form");
    const [channel, ts] = parts;
    switch (name) {
      case "slack_update_status": {
        const status = requireStr(args, "status");
        const map = statusEmojiMap(settings);
        const target = emojiForState(status, map);
        if (!target) {
          return failure(`No emoji configured for status '${status}'.`);
        }
        // Trust-boundary check: the agent-supplied issueId must point at a watched channel
        // and a message that is actually a tracked bot-mention issue before we mutate it.
        const message = await ensureTrackedMessage(settings, transport, channel, ts);
        if ("error" in message) return message.error;
        const present = message.reactions.filter((r) => map[r]);
        // Treat the swap as a transaction: add the target first (when absent), then remove every
        // stale managed reaction. On ANY failure, restore the ORIGINAL managed-reaction set
        // best-effort so a partial failure preserves the OLD status, never the wrong new status
        // and never empty. The read path ranks reactions by category, so a lingering higher-ranked
        // stale reaction (or a half-removed set) would otherwise shadow the target and mis-report.
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
        if (!present.includes(target)) {
          try {
            await transport.addReaction(channel, ts, target);
            added = true;
          } catch (error) {
            // Adding the new status failed; leave every existing reaction untouched so the
            // prior status is preserved rather than erased. No removes were attempted.
            return failure((error as Error).message);
          }
        }
        const stale = present.filter((r) => r !== target);
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
              return failure("status not changed");
            }
            // Either the re-fetch failed or the managed set drifted from the original. The message
            // may now read as the wrong (e.g. advanced) status, so do NOT claim it is unchanged.
            // Surface the ACTUAL managed reactions so the runtime/operator does not trust the prior
            // status.
            const observed = current ?? [];
            return {
              success: false,
              error:
                "status update failed and could not be fully rolled back; " +
                `current managed reactions: ${observed.join(", ") || "(unknown)"}`,
              result: {
                error: {
                  message:
                    "status update failed and could not be fully rolled back; " +
                    `current managed reactions: ${observed.join(", ") || "(unknown)"}`,
                  currentManagedReactions: observed,
                },
              },
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
        const canonicalState = map[target] ?? status;
        const effective = await currentManagedReactions(transport, channel, ts, map);
        if (effective && sameState(stateFromReactions(effective, map), canonicalState)) {
          return { success: true, result: { ok: true, status: canonicalState } };
        }
        const observed = effective ?? [];
        return {
          success: false,
          error:
            `status update did not take effect; requested '${status}' but current managed ` +
            `reactions resolve to '${effective ? stateFromReactions(effective, map) : "unknown"}'; ` +
            `current managed reactions: ${observed.join(", ") || "(unknown)"}`,
          result: {
            error: {
              message:
                `status update did not take effect; requested '${status}' but current managed ` +
                `reactions resolve to '${
                  effective ? stateFromReactions(effective, map) : "unknown"
                }'; current managed reactions: ${observed.join(", ") || "(unknown)"}`,
              currentManagedReactions: observed,
            },
          },
        };
      }
      case "slack_comment": {
        // Same trust-boundary check as update_status: only reply on a watched, tracked issue.
        const message = await ensureTrackedMessage(settings, transport, channel, ts);
        if ("error" in message) return message.error;
        await transport.postReply(channel, ts, requireStr(args, "body"));
        return { success: true, result: { ok: true } };
      }
      case "slack_read_thread": {
        // Same trust-boundary check as the write tools: only read a watched, tracked issue.
        const message = await ensureTrackedMessage(settings, transport, channel, ts);
        if ("error" in message) return message.error;
        const map = statusEmojiMap(settings);
        return {
          success: true,
          result: {
            issueId: `${channel}:${ts}`,
            status: stateFromReactions(message.reactions, map),
            text: message.text,
            reactions: message.reactions,
            replies: await transport.getThread(channel, ts),
          },
        };
      }
      default:
        return {
          success: false,
          error: "Unsupported tool.",
          result: { error: { message: "Unsupported tool.", supportedTools: [...TOOL_NAMES] } },
        };
    }
  } catch (error) {
    return failure((error as Error).message);
  }
}

export function slackTransportFor(
  settings: Settings,
  fetchImpl: typeof fetch,
  injected?: SlackTransport,
): SlackTransport {
  return injected ?? new SlackWebTransport(settings, fetchImpl);
}

/**
 * Enforce the agent trust boundary: the issueId must reference a configured (watched) channel
 * and an existing message that is a tracked bot-mention. Returns the message on success, or a
 * `{ error }` wrapper carrying the failure result to return to the caller.
 */
async function ensureTrackedMessage(
  settings: Settings,
  transport: SlackTransport,
  channel: string,
  ts: string,
): Promise<SlackMessage | { error: ToolResult }> {
  const channels = settings.tracker.channels ?? [];
  if (!channels.includes(channel)) {
    return { error: failure(`channel '${channel}' is not a configured tracker channel`) };
  }
  const message = await transport.getMessage(channel, ts);
  if (!message) {
    return { error: failure(`no tracked issue at ${channel}:${ts}`) };
  }
  if (!isBotMention(message.text, settings.tracker.botUserId)) {
    return { error: failure("message is not a tracked bot-mention issue") };
  }
  return message;
}

function failure(message: string): ToolResult {
  return { success: false, error: message, result: { error: { message } } };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`'${key}' is required`);
  return value;
}
