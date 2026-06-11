import { errorMessage, isRecord, type Settings } from "@symphony/domain";
import {
  applyQuery,
  parseQuerySpec,
  parseSelect,
  pickFields,
  toolFailure,
  toolSuccess,
  unsupportedToolFailure,
  type ToolProvider,
  type ToolResult,
  type ToolSpec,
} from "@symphony/tool-sdk";

import { slackMessageToRow, slackPermalink, splitIssueId } from "./client.js";
import { stateFromReactions, statusEmojiMap } from "./mapping.js";
import { requireBotUserId, requireTrackedMessage, updateSlackStatus } from "./operations.js";
import { slackTrackerOptions } from "./options.js";
import type { SlackTransport } from "./transport.js";
import { SlackWebTransport } from "./webTransport.js";

const TOOL_NAMES = [
  "slack_update_status",
  "slack_comment",
  "slack_read_thread",
  "slack_query",
] as const;

/** Default projection for `slack_query` when `select` is omitted. */
const DEFAULT_SLACK_SELECT = ["issueId", "title", "state", "labels"];
/** The only fields `expand` may request beyond the base row. */
const SLACK_EXPAND_FIELDS = new Set(["thread", "reactions"]);

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
    {
      name: "slack_query",
      description:
        "Query Slack issues, i.e. bot-mention messages in the configured channels (read-only). " +
        "Filter with a JSON predicate DSL, project fields, order, and page. Row fields: issueId, " +
        "channel, ts, title, state, stateType, labels, text. Use expand for 'thread' (replies) and " +
        "'reactions'. Args: channels? (intersected with the allow-list), where?, select?, expand?, " +
        "order_by?, limit?, offset?.",
      inputSchema: {
        type: "object",
        properties: {
          channels: { type: "array", items: { type: "string" } },
          where: { type: "object" },
          select: { type: "array", items: { type: "string" } },
          expand: { type: "array", items: { type: "string", enum: ["thread", "reactions"] } },
          order_by: { type: "array", items: { type: "object" } },
          limit: { type: "number" },
          offset: { type: "number" },
        },
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
    // slack_query scans a set of channels rather than acting on a single issueId, so it is handled
    // before the per-issue id split below.
    if (name === "slack_query") {
      return await executeSlackQuery(args, settings, transport);
    }
    if (!(TOOL_NAMES as readonly string[]).includes(name)) {
      return unsupportedToolFailure(name, TOOL_NAMES);
    }
    // Every remaining tool acts on one issue, so the id is parsed once here.
    const parts = splitIssueId(requireStr(args, "issueId"));
    if (!parts) throw new Error("issueId must be in '<channel>:<ts>' form");
    const [channel, ts] = parts;
    switch (name) {
      case "slack_update_status": {
        const status = requireStr(args, "status");
        const outcome = await updateSlackStatus(settings, transport, channel, ts, status);
        if (outcome.ok) return toolSuccess({ ok: true, status: outcome.status });
        return outcome.currentManagedReactions !== undefined
          ? toolFailure(outcome.message, {
              currentManagedReactions: outcome.currentManagedReactions,
            })
          : toolFailure(outcome.message);
      }
      case "slack_comment": {
        // Same trust-boundary check as update_status: only reply on a watched, tracked issue.
        await requireTrackedMessage(settings, transport, channel, ts);
        await transport.postReply(channel, ts, requireStr(args, "body"));
        return toolSuccess({ ok: true });
      }
      case "slack_read_thread": {
        // Same trust-boundary check as the write tools: only read a watched, tracked issue.
        const message = await requireTrackedMessage(settings, transport, channel, ts);
        const map = statusEmojiMap(settings);
        const base = await transport.teamUrl();
        return toolSuccess({
          issueId: `${channel}:${ts}`,
          status: stateFromReactions(message.reactions, map, settings),
          text: message.text,
          reactions: message.reactions,
          ...(base ? { permalink: slackPermalink(base, channel, ts) } : {}),
          replies: await transport.getThread(channel, ts),
        });
      }
      default:
        return unsupportedToolFailure(name, TOOL_NAMES);
    }
  } catch (error) {
    return toolFailure(errorMessage(error));
  }
}

/** The Slack tool pack: status, threaded comments, and reads over tracked bot-mention issues. */
export const slackToolProvider: ToolProvider = {
  name: "slack",
  toolSpecs: () => slackToolSpecs(),
  executeTool: async (name, input, context) =>
    executeSlackTool(
      name,
      input,
      context.settings,
      new SlackWebTransport(context.settings, context.fetchImpl),
    ),
};

/**
 * Read-only query over Slack issues. The trust boundary is enforced structurally: rows come only
 * from `transport.listMentions`, which returns bot-mention messages and fails closed on an empty
 * botUserId, and the scanned channels are always intersected with the configured allow-list. So
 * every row is already a tracked issue in a watched channel - the query cannot become an oracle
 * for arbitrary messages. Filtering/projection/paging then run in memory over those rows.
 */
async function executeSlackQuery(
  args: Record<string, unknown>,
  settings: Settings,
  transport: SlackTransport,
): Promise<ToolResult> {
  // Fail loudly on a missing bot user id: the transport would scan nothing (fail closed), and a
  // silent empty result would read as "no issues" rather than "misconfigured tracker".
  requireBotUserId(settings);
  const spec = parseQuerySpec(args);
  const select = parseSelect(args.select) ?? DEFAULT_SLACK_SELECT;
  const expand = parseSlackExpand(args.expand);
  const allow = slackTrackerOptions(settings).channels;
  const requested = parseStringArray(args.channels, "channels");
  const channels = requested ? requested.filter((c) => allow.includes(c)) : allow;
  const [messages, base] = await Promise.all([
    transport.listMentions(channels),
    transport.teamUrl(),
  ]);
  const records = messages.map(
    (m) => slackMessageToRow(m, settings, base) as unknown as Record<string, unknown>,
  );
  const { rows, total } = applyQuery(records, spec);
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const projected = pickFields(row, select);
    if (expand.includes("reactions")) projected.reactions = row.reactions;
    if (expand.includes("thread")) {
      projected.thread = await transport.getThread(String(row.channel), String(row.ts));
    }
    out.push(projected);
  }
  return toolSuccess({ rows: out, total });
}

/** Validate `expand`: an array drawn from {@link SLACK_EXPAND_FIELDS}, deduped; default empty. */
function parseSlackExpand(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("expand must be an array of 'thread' | 'reactions'");
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string" || !SLACK_EXPAND_FIELDS.has(item)) {
      throw new Error("expand items must be 'thread' or 'reactions'");
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function parseStringArray(input: unknown, label: string): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input) || !input.every((s) => typeof s === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return input;
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`'${key}' is required`);
  return value;
}
