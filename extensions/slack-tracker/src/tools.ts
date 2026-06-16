import { errorMessage, isRecord, type Settings } from "@lorenz/domain";
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
} from "@lorenz/tool-sdk";

import { slackMessageToRow, slackPermalink, splitIssueId, trackedRootsOf } from "./client.js";
import { requireBotUserId, requireTrackedMessage, updateSlackStatus } from "./operations.js";
import { slackTrackerOptions } from "./options.js";
import { resolveThreadState, stateFromThread } from "./threadState.js";
import type { SlackTransport } from "./transport.js";
import { SlackWebTransport } from "./webTransport.js";

const TOOL_NAMES = [
  "slack_update_status",
  "slack_comment",
  "slack_read_thread",
  "slack_query",
  "slack_user_info",
  "slack_channel_context",
] as const;

/** Default projection for `slack_query` when `select` is omitted. */
const DEFAULT_SLACK_SELECT = ["issueId", "title", "state", "labels"];
/** The only fields `expand` may request beyond the base row. */
const SLACK_EXPAND_FIELDS = new Set(["thread", "reactions"]);
/** Bounds for the `slack_channel_context` window. */
const CONTEXT_DEFAULT = 10;
const CONTEXT_MAX = 50;

export function slackToolSpecs(): ToolSpec[] {
  return [
    {
      name: "slack_update_status",
      description:
        "Set a Slack issue's status by posting the bot's authoritative `status:` thread reply " +
        "(reactions are only a visibility mirror). Args: issueId, status (a configured " +
        "active/terminal state name).",
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
        "Read a Slack issue's authoritative state: its source message, thread-derived status " +
        "(human `@bot !` commands and bot `status:` replies, latest wins), reactions, permalink, " +
        "and the thread replies. Args: issueId.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
      },
    },
    {
      name: "slack_query",
      description:
        "Query tracked Slack issues (read-only): bot-mention roots plus bot-marked " +
        "reply-tracked threads in the configured channels, with thread-derived state. Filter " +
        "with a JSON predicate DSL, project fields, order, and page. Row fields: issueId, " +
        "channel, ts, title, state, stateType, labels, text, url. Use expand for 'thread' " +
        "(replies) and 'reactions'. Args: channels? (intersected with the allow-list), where?, " +
        "select?, expand?, order_by?, limit?, offset?.",
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
    {
      name: "slack_user_info",
      description:
        "Resolve a Slack user id (e.g. from a <@U...> mention or a thread reply's user field) " +
        "to its profile: name, real name, display name, bot flag. Args: userId.",
      inputSchema: {
        type: "object",
        properties: { userId: { type: "string" } },
        required: ["userId"],
      },
    },
    {
      name: "slack_channel_context",
      description:
        "Read the channel conversation around a tracked issue's source message (read-only): " +
        "up to `before` messages at-or-before it and `after` messages after it, ascending. " +
        "Args: issueId, before? (default 10, max 50), after? (default 10, max 50).",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          before: { type: "number" },
          after: { type: "number" },
        },
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
    // slack_query scans the configured channels rather than acting on a single issueId, so it
    // is handled before the per-issue id split below. slack_user_info takes a user id.
    if (name === "slack_query") {
      return await executeSlackQuery(args, settings, transport);
    }
    if (name === "slack_user_info") {
      requireBotUserId(settings);
      const userId = requireStr(args, "userId");
      const user = await transport.getUser(userId);
      if (!user) return toolFailure(`unknown slack user: ${userId}`);
      return toolSuccess({ user });
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
        return toolFailure(outcome.message);
      }
      case "slack_comment": {
        // Same trust-boundary check as update_status: only reply on a watched, tracked issue.
        await requireTrackedMessage(settings, transport, channel, ts);
        await transport.postReply(channel, ts, requireStr(args, "body"));
        return toolSuccess({ ok: true });
      }
      case "slack_read_thread": {
        // Same trust-boundary check as the write tools: only read a watched, tracked issue.
        const root = await requireTrackedMessage(settings, transport, channel, ts);
        const replies = await transport.getThread(channel, ts);
        const thread = stateFromThread(root, replies, settings);
        const base = await transport.teamUrl();
        return toolSuccess({
          issueId: `${channel}:${ts}`,
          status: thread.state,
          text: root.text,
          ...(thread.request !== undefined ? { request: thread.request } : {}),
          reactions: root.reactions,
          ...(base ? { permalink: slackPermalink(base, channel, ts) } : {}),
          replies,
        });
      }
      case "slack_channel_context": {
        // Context reads are scoped: anchored to a TRACKED issue in a watched channel, never a
        // free-roaming channel read.
        await requireTrackedMessage(settings, transport, channel, ts);
        const before = windowArg(args.before, "before");
        const after = windowArg(args.after, "after");
        const messages = await transport.listAround(channel, ts, { before, after });
        return toolSuccess({
          anchor: `${channel}:${ts}`,
          messages: messages.map((m) => ({
            ts: m.ts,
            ...(m.user !== undefined ? { user: m.user } : {}),
            text: m.text,
          })),
        });
      }
      default:
        return unsupportedToolFailure(name, TOOL_NAMES);
    }
  } catch (error) {
    return toolFailure(errorMessage(error));
  }
}

/** The Slack tool pack: status, threaded comments, reads, and scoped channel context. */
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
 * Read-only query over tracked Slack issues. The trust boundary is enforced structurally:
 * rows come only from the channel scan's tracked roots (bot-mention roots and bot-marked
 * threads; the scan fails closed without a bot user id), and the scanned channels are always
 * intersected with the configured allow-list - the query cannot become an oracle for arbitrary
 * messages. Filtering/projection/paging then run in memory over those rows.
 */
async function executeSlackQuery(
  args: Record<string, unknown>,
  settings: Settings,
  transport: SlackTransport,
): Promise<ToolResult> {
  // Fail loudly on a missing bot user id: the scan would return nothing (fail closed), and a
  // silent empty result would read as "no issues" rather than "misconfigured tracker".
  requireBotUserId(settings);
  const spec = parseQuerySpec(args);
  const select = parseSelect(args.select) ?? DEFAULT_SLACK_SELECT;
  const expand = parseSlackExpand(args.expand);
  const allow = slackTrackerOptions(settings).channels;
  const requested = parseStringArray(args.channels, "channels");
  const channels = requested ? requested.filter((c) => allow.includes(c)) : allow;
  const [scan, base] = await Promise.all([transport.scanChannels(channels), transport.teamUrl()]);
  const records: Array<Record<string, unknown>> = [];
  for (const root of trackedRootsOf(scan)) {
    const thread = await resolveThreadState(settings, transport, root);
    records.push(
      slackMessageToRow(root, settings, {
        permalinkBase: base,
        state: thread.state,
        request: thread.request,
      }) as unknown as Record<string, unknown>,
    );
  }
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

function windowArg(value: unknown, label: string): number {
  if (value === undefined || value === null) return CONTEXT_DEFAULT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`'${label}' must be a non-negative integer`);
  }
  return Math.min(value, CONTEXT_MAX);
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`'${key}' is required`);
  return value;
}
