import {
  emojiForState,
  isBotMention,
  SlackWebTransport,
  splitIssueId,
  statusEmojiMap,
  type SlackMessage,
  type SlackTransport,
} from "@symphony/slack-tracker";
import type { Settings } from "@symphony/domain";

import type { ToolResult, ToolSpec } from "../tools.js";

const TOOL_NAMES = ["slack_update_status", "slack_comment"] as const;

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
        // Add the target first (when absent), then roll back on a cleanup failure so a partial
        // failure preserves the OLD status: never the wrong new status, never empty. The read
        // path ranks reactions by category, so a lingering higher-ranked stale reaction would
        // otherwise shadow a newly added lower-ranked target and report a wrong status.
        let added = false;
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
          } catch {
            // Cleanup failed. If we added the target this call, roll it back (best-effort) so
            // the stale reactions still rank to the OLD status rather than the wrong new one.
            if (added) {
              try {
                await transport.removeReaction(channel, ts, target);
              } catch {
                // Best-effort rollback; keep the original failure as the reported outcome.
              }
            }
            return failure("status not changed");
          }
        }
        return { success: true, result: { ok: true, status } };
      }
      case "slack_comment": {
        // Same trust-boundary check as update_status: only reply on a watched, tracked issue.
        const message = await ensureTrackedMessage(settings, transport, channel, ts);
        if ("error" in message) return message.error;
        await transport.postReply(channel, ts, requireStr(args, "body"));
        return { success: true, result: { ok: true } };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`'${key}' is required`);
  return value;
}
