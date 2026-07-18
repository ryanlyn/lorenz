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

import {
  discordMessageToRow,
  discordPermalink,
  isDiscordSnowflake,
  splitIssueId,
} from "./client.js";
import {
  ensureIssueThread,
  requireBotUserId,
  requireTrackedMessage,
  updateDiscordStatus,
} from "./operations.js";
import { discordTrackerOptions } from "./options.js";
import { chunkDiscordText, DiscordRestTransport } from "./restTransport.js";
import { botStatusRecord, stateFromThread } from "./threadState.js";
import type { DiscordTransport } from "./transport.js";

const TOOL_NAMES = [
  "discord_update_status",
  "discord_comment",
  "discord_read_thread",
  "discord_query",
  "discord_user_info",
  "discord_channel_context",
] as const;

const DEFAULT_DISCORD_SELECT = ["issueId", "title", "state", "labels"];
const DISCORD_EXPAND_FIELDS = new Set(["thread", "reactions"]);
const CONTEXT_DEFAULT = 10;
const CONTEXT_MAX = 50;

export function discordToolSpecs(): ToolSpec[] {
  return [
    {
      name: "discord_update_status",
      description:
        "Set a Discord issue's status by posting the bot's authoritative `status:` message in " +
        "the issue thread. The source-message reaction is only a visual mirror. Args: issueId, " +
        "status (a configured active/terminal state name).",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, status: { type: "string" } },
        required: ["issueId", "status"],
      },
    },
    {
      name: "discord_comment",
      description: "Post a message in the Discord issue's native thread. Args: issueId, body.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, body: { type: "string" } },
        required: ["issueId", "body"],
      },
    },
    {
      name: "discord_read_thread",
      description:
        "Read a Discord issue's source message, thread-derived status, bot-owned reaction " +
        "mirror, permalink, and native-thread messages. Args: issueId.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
      },
    },
    {
      name: "discord_query",
      description:
        "Query tracked Discord issues in configured channels. Filter with a JSON predicate DSL, " +
        "project fields, order, and page. Args: channels?, where?, select?, expand? (thread, " +
        "reactions), order_by?, limit?, offset?.",
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
      name: "discord_user_info",
      description: "Resolve a Discord user id to its username, global name, and bot flag.",
      inputSchema: {
        type: "object",
        properties: { userId: { type: "string" } },
        required: ["userId"],
      },
    },
    {
      name: "discord_channel_context",
      description:
        "Read messages around a tracked issue's source message. Args: issueId, before? " +
        "(default 10, max 50), after? (default 10, max 50).",
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

export async function executeDiscordTool(
  name: string,
  input: unknown,
  settings: Settings,
  transport: DiscordTransport,
): Promise<ToolResult> {
  const args = isRecord(input) ? input : {};
  try {
    if (name === "discord_query") return await executeDiscordQuery(args, settings, transport);
    if (name === "discord_user_info") {
      requireBotUserId(settings);
      const userId = requireStr(args, "userId");
      if (!isDiscordSnowflake(userId)) throw new Error("userId must be a Discord snowflake");
      const user = await transport.getUser(userId);
      return user ? toolSuccess({ user }) : toolFailure(`unknown discord user: ${userId}`);
    }
    if (!(TOOL_NAMES as readonly string[]).includes(name)) {
      return unsupportedToolFailure(name, TOOL_NAMES);
    }

    const parts = splitIssueId(requireStr(args, "issueId"));
    if (!parts) {
      throw new Error("issueId must be '<channel>:<message>' with two Discord snowflakes");
    }
    const [channelId, messageId] = parts;
    switch (name) {
      case "discord_update_status": {
        const outcome = await updateDiscordStatus(
          settings,
          transport,
          channelId,
          messageId,
          requireStr(args, "status"),
        );
        return outcome.ok
          ? toolSuccess({ ok: true, status: outcome.status })
          : toolFailure(outcome.message);
      }
      case "discord_comment": {
        const body = requireStr(args, "body");
        if (chunkDiscordText(body).some((chunk) => botStatusRecord(chunk) !== null)) {
          throw new Error(
            "discord_comment cannot post the reserved 'status:' record; use discord_update_status",
          );
        }
        const root = await requireTrackedMessage(settings, transport, channelId, messageId);
        const threadId = await ensureIssueThread(transport, root);
        await transport.postThreadMessage(threadId, body);
        return toolSuccess({ ok: true });
      }
      case "discord_read_thread": {
        const root = await requireTrackedMessage(settings, transport, channelId, messageId);
        const messages = root.hasThread ? await transport.getThread(root.id) : [];
        const tracker = discordTrackerOptions(settings);
        return toolSuccess({
          issueId: `${channelId}:${messageId}`,
          status: stateFromThread(root, messages, settings),
          text: root.content,
          reactions: root.reactions.map((reaction) => ({
            emoji: reaction.emoji,
            ownedByBot: reaction.me,
          })),
          permalink: discordPermalink(tracker.guildId ?? "@me", channelId, messageId),
          messages,
        });
      }
      case "discord_channel_context": {
        await requireTrackedMessage(settings, transport, channelId, messageId);
        const messages = await transport.listAround(channelId, messageId, {
          before: windowArg(args.before, "before"),
          after: windowArg(args.after, "after"),
        });
        return toolSuccess({
          anchor: `${channelId}:${messageId}`,
          messages: messages.map((message) => ({
            id: message.id,
            ...(message.authorId !== undefined ? { authorId: message.authorId } : {}),
            ...(message.authorName !== undefined ? { authorName: message.authorName } : {}),
            text: message.content,
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

export const discordToolProvider: ToolProvider = {
  name: "discord",
  toolSpecs: () => discordToolSpecs(),
  executeTool: async (name, input, context) =>
    executeDiscordTool(
      name,
      input,
      context.settings,
      new DiscordRestTransport(context.settings, context.fetchImpl),
    ),
};

async function executeDiscordQuery(
  args: Record<string, unknown>,
  settings: Settings,
  transport: DiscordTransport,
): Promise<ToolResult> {
  requireBotUserId(settings);
  const spec = parseQuerySpec(args);
  const select = parseSelect(args.select) ?? DEFAULT_DISCORD_SELECT;
  const expand = parseExpand(args.expand);
  const allowedChannels = discordTrackerOptions(settings).channels;
  const requestedChannels = parseStringArray(args.channels, "channels");
  const channels = requestedChannels
    ? requestedChannels.filter((channel) => allowedChannels.includes(channel))
    : allowedChannels;
  const scan = await transport.scanChannels(channels);
  const records: Array<Record<string, unknown>> = [];
  const threads = new Map<string, Awaited<ReturnType<DiscordTransport["getThread"]>>>();
  for (const root of scan.mentions) {
    const thread = root.hasThread ? await transport.getThread(root.id) : [];
    threads.set(root.id, thread);
    const state = stateFromThread(root, thread, settings);
    records.push(discordMessageToRow(root, settings, state) as unknown as Record<string, unknown>);
  }
  const { rows, total } = applyQuery(records, spec);
  const projectedRows = rows.map((row) => {
    const projected = pickFields(row, select);
    if (expand.includes("reactions")) projected.reactions = row.reactions;
    if (expand.includes("thread")) projected.thread = threads.get(String(row.messageId)) ?? [];
    return projected;
  });
  return toolSuccess({ rows: projectedRows, total });
}

function parseExpand(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("expand must be an array of 'thread' | 'reactions'");
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string" || !DISCORD_EXPAND_FIELDS.has(item)) {
      throw new Error("expand items must be 'thread' or 'reactions'");
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function parseStringArray(input: unknown, label: string): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input) || !input.every((value) => typeof value === "string")) {
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
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`'${key}' is required`);
  }
  return value;
}
