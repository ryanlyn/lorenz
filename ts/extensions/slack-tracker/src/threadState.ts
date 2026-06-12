import type { Settings } from "@symphony/domain";
import { defaultStateType } from "@symphony/issue";

import {
  isBotMention,
  stateFromReactions,
  statusEmojiMap,
  stripLeadingMention,
} from "./mapping.js";
import { slackTrackerOptions } from "./options.js";
import type { SlackMessage, SlackThreadReply, SlackTransport } from "./transport.js";

/**
 * Thread-command state model. Slack reactions are per-author (the bot cannot remove a human's
 * reaction and vice versa), so reactions cannot carry a jointly-edited status. The thread is the
 * shared, ts-ordered medium both sides can write to, so STATUS LIVES IN THE THREAD:
 *
 * - Humans transition status by mentioning the bot with a `!`-prefixed command reply:
 *   `@bot !done`, `@bot !cancel`, `@bot !reopen`, `@bot !status <Name>`. The bang keeps
 *   transitions unmistakable next to ordinary prompts addressed to the bot.
 * - The bot (agent/runtime) transitions status by posting a `status: <Name>` reply.
 * - A bot-mention reply with NO command re-opens a terminal issue to the default
 *   non-terminal state: mentioning the bot again always means "this needs attention".
 * - The latest event by ts wins. Reactions remain a bot-owned visibility mirror and the
 *   back-compat source for threads that have never seen a command or bot status reply.
 */

/** Recognized prefix of the bot's own authoritative status replies. */
export const BOT_STATUS_PREFIX = "status:";

const BOT_STATUS_RE = /^status:\s*(.+?)\s*$/i;

/** Standard state names recognized even when a workflow does not list them explicitly. */
const STANDARD_STATES = ["Todo", "In Progress", "Done", "Cancelled"];

/** Command keywords (the `!`-prefixed reply body after the mention, punctuation-insensitive). */
const COMMAND_STATES: Array<{ keywords: string[]; state: (settings: Settings) => string }> = [
  {
    keywords: ["done", "complete", "completed", "finished"],
    state: (settings) => resolveStateName("Done", settings) ?? "Done",
  },
  {
    keywords: ["cancel", "cancelled", "canceled", "stop"],
    state: (settings) => resolveStateName("Cancelled", settings) ?? "Cancelled",
  },
  { keywords: ["reopen", "rework", "retry"], state: (settings) => reopenState(settings) },
  {
    keywords: ["in progress", "start", "started", "wip"],
    state: (settings) => resolveStateName("In Progress", settings) ?? "In Progress",
  },
  {
    keywords: ["todo", "backlog"],
    state: (settings) => resolveStateName("Todo", settings) ?? "Todo",
  },
];

/**
 * Resolve a state name case-insensitively against the configured states (config casing wins)
 * and the standard names; `null` when unknown.
 */
export function resolveStateName(name: string, settings: Settings): string | null {
  const target = name.trim().toLowerCase();
  if (target === "") return null;
  const pool = [
    ...settings.tracker.activeStates,
    ...settings.tracker.terminalStates,
    ...STANDARD_STATES,
  ];
  return pool.find((state) => state.trim().toLowerCase() === target) ?? null;
}

/** The state a bare re-mention re-opens to: the first configured active state. */
function reopenState(settings: Settings): string {
  return settings.tracker.activeStates[0] ?? "Todo";
}

/** Terminal by configuration, or by the standard category when the name is a standard one. */
function isTerminalState(state: string, settings: Settings): boolean {
  const target = state.trim().toLowerCase();
  if (settings.tracker.terminalStates.some((s) => s.trim().toLowerCase() === target)) return true;
  const category = defaultStateType(state);
  return category === "completed" || category === "canceled";
}

/**
 * Parse a human status command: a reply that STARTS with the bot mention, followed by a
 * `!`-prefixed keyword or `!status <Name>` as the remaining first line. The explicit `!`
 * separates transitions from ordinary prompts: `@bot !done` transitions, while `@bot done`
 * (or any other phrasing) is a bare mention. Anything without the bang is a bare mention.
 */
export function parseStatusCommand(
  text: string,
  botUserId: string | undefined,
  settings: Settings,
): { state: string } | null {
  const trimmed = text.trim();
  const stripped = stripLeadingMention(trimmed, botUserId);
  if (stripped === trimmed) return null; // the mention is not leading: not a command form
  const firstLine = (stripped.split("\n")[0] ?? "").trim();
  if (!firstLine.startsWith("!")) return null; // no bang: an ordinary prompt, not a transition
  const body = firstLine
    .slice(1)
    .trim()
    .replace(/[.!?]+$/, "");
  const explicit = /^status:?\s+(.+)$/i.exec(body);
  if (explicit) {
    const state = resolveStateName(explicit[1]!, settings);
    return state ? { state } : null;
  }
  const lower = body.toLowerCase();
  for (const command of COMMAND_STATES) {
    if (command.keywords.includes(lower)) return { state: command.state(settings) };
  }
  return null;
}

/** Derived status of one tracked thread plus, for reply-tracked threads, the request reply. */
export interface ThreadState {
  state: string;
  /** First bot-mention reply when the ROOT does not mention the bot (the actual request). */
  request?: { ts: string; text: string; user?: string | undefined } | undefined;
}

/**
 * Fold a thread into its current state. Events (bot `status:` replies and human command
 * mentions) are applied in ts order and the latest wins; with no events at all the state falls
 * back to the reaction-derived reading (back-compat for reaction-managed threads). A trailing
 * bare bot-mention re-opens a terminal state.
 */
export function stateFromThread(
  root: SlackMessage,
  replies: SlackThreadReply[],
  settings: Settings,
): ThreadState {
  const { botUserId } = slackTrackerOptions(settings);
  const ordered = [...replies].sort((a, b) => tsValue(a.ts) - tsValue(b.ts));
  const rootIsMention = isBotMention(root.text, botUserId);

  const events: Array<{ ts: string; state: string }> = [];
  const bareMentionTs: string[] = [];
  let request: ThreadState["request"];

  for (const reply of ordered) {
    if (botUserId !== undefined && reply.user === botUserId) {
      const status = BOT_STATUS_RE.exec(reply.text.trim());
      if (status) {
        const state = resolveStateName(status[1]!, settings);
        if (state) events.push({ ts: reply.ts, state });
      }
      continue;
    }
    if (!isBotMention(reply.text, botUserId)) continue;
    if (!rootIsMention && request === undefined) {
      // The first mention in a non-mention thread is the request itself, not a transition.
      request = { ts: reply.ts, text: reply.text, user: reply.user };
      continue;
    }
    const command = parseStatusCommand(reply.text, botUserId, settings);
    if (command) events.push({ ts: reply.ts, state: command.state });
    else bareMentionTs.push(reply.ts);
  }

  let state: string;
  let lastEventTs: number;
  const lastEvent = events[events.length - 1];
  if (lastEvent) {
    state = lastEvent.state;
    lastEventTs = tsValue(lastEvent.ts);
  } else if (rootIsMention) {
    state = stateFromReactions(root.reactions, statusEmojiMap(settings), settings);
    // Reactions carry no ordering, so any later bare mention may re-open a terminal reading.
    lastEventTs = Number.NEGATIVE_INFINITY;
  } else {
    state = "Todo";
    lastEventTs = Number.NEGATIVE_INFINITY;
  }

  if (isTerminalState(state, settings) && bareMentionTs.some((ts) => tsValue(ts) > lastEventTs)) {
    state = reopenState(settings);
  }

  return { state, ...(request !== undefined ? { request } : {}) };
}

function tsValue(ts: string): number {
  const value = Number.parseFloat(ts);
  return Number.isFinite(value) ? value : 0;
}

interface ThreadStateCacheEntry {
  latestReply: string;
  replyCount: number;
  reactionsKey: string;
  resolved: ThreadState;
}

/**
 * Cross-call cache: thread state only changes when the thread (or the root's reactions)
 * changes, and `conversations.history` reports `latest_reply`/`reply_count` on every scan, so
 * unchanged threads never pay a `conversations.replies` fetch. Module-level because the tool
 * packs construct a fresh transport per call.
 */
const threadStateCache = new Map<string, ThreadStateCacheEntry>();
const THREAD_STATE_CACHE_MAX = 5_000;

/** Resolve a tracked root's thread state, fetching replies only when the thread changed. */
export async function resolveThreadState(
  settings: Settings,
  transport: SlackTransport,
  root: SlackMessage,
): Promise<ThreadState> {
  const replyCount = root.replyCount ?? 0;
  if (replyCount === 0) {
    return stateFromThread(root, [], settings);
  }
  const key = `${root.channel}:${root.ts}`;
  const latestReply = root.latestReply ?? "";
  const reactionsKey = [...root.reactions].sort().join(",");
  const cached = threadStateCache.get(key);
  if (
    cached &&
    cached.latestReply === latestReply &&
    cached.replyCount === replyCount &&
    cached.reactionsKey === reactionsKey
  ) {
    return cached.resolved;
  }
  const replies = await transport.getThread(root.channel, root.ts);
  const resolved = stateFromThread(root, replies, settings);
  if (threadStateCache.size >= THREAD_STATE_CACHE_MAX) threadStateCache.clear();
  threadStateCache.set(key, { latestReply, replyCount, reactionsKey, resolved });
  return resolved;
}
