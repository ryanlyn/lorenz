import type { Settings } from "@lorenz/domain";
import { defaultStateType } from "@lorenz/issue";

import {
  isAllowedAuthor,
  isBotMention,
  stateFromReactions,
  statusEmojiMap,
  stripLeadingMention,
} from "./mapping.js";
import { compareSlackTs } from "./ids.js";
import { slackTrackerOptions } from "./options.js";
import { STATUS_METADATA_EVENT, WORKPAD_METADATA_EVENT } from "./transport.js";
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
 * - The latest event by ts wins. Reactions remain a bot-owned visibility mirror. An unmarked
 *   root uses reaction-derived state; the dedicated tracking marker declares thread authority.
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

/**
 * True when the reply is an ASIDE: a first line starting with `!aside` (after an optional
 * leading bot mention). Asides are for humans talking near the issue without addressing it -
 * they are never a command, never a bare re-mention (so they cannot re-open a terminal issue),
 * and never delivered as steering context. They stay visible in the thread and in
 * `slack_read_thread`'s raw replies; the marker only opts them out of being PUSHED at the agent.
 */
export function isAsideText(text: string, botUserId: string | undefined): boolean {
  const stripped = stripLeadingMention(text.trim(), botUserId);
  const firstLine = (stripped.split("\n")[0] ?? "").trim();
  return /^!aside(?:\s|$)/i.test(firstLine);
}

/** One folded status transition: who moved the issue where, and when. */
export interface ThreadStatusEvent {
  ts: string;
  state: string;
  /** The transitioning author's user id (the bot's own id for `status:` replies). */
  actor?: string | undefined;
}

/** Derived status of one tracked thread plus, for reply-tracked threads, the request reply. */
export interface ThreadState {
  state: string;
  /** First bot-mention reply when the ROOT does not mention the bot (the actual request). */
  request?: { ts: string; text: string; user?: string | undefined } | undefined;
  /** The folded status transitions in ts order (the audit trail the session modal renders). */
  events: ThreadStatusEvent[];
  /** The bot's workpad message in this thread, when one exists (see workpad.ts). */
  workpad?: ThreadWorkpad | undefined;
}

/** The workpad reply's identity and its metadata-carried sections (the plan/note round-trip). */
export interface ThreadWorkpad {
  ts: string;
  plan?: string | undefined;
  note?: string | undefined;
}

/**
 * Fold a thread into its current state. Events (bot `status:` replies and human command
 * mentions) are applied in ts order and the latest wins. Unmarked roots use reaction-derived
 * fallback; a dedicated tracking marker identifies thread-authoritative roots across restarts.
 * A trailing bare bot mention re-opens a terminal state.
 */
export function stateFromThread(
  root: SlackMessage,
  replies: SlackThreadReply[],
  settings: Settings,
): ThreadState {
  const { botUserId, users, markerEmoji = "robot_face" } = slackTrackerOptions(settings);
  const ordered = [...replies].sort((a, b) => compareSlackTs(a.ts, b.ts));
  const rootIsMention = isBotMention(root.text, botUserId);

  type FoldInput =
    | { kind: "status"; event: ThreadStatusEvent }
    | { kind: "bare"; ts: string; actor?: string | undefined };
  const foldInputs: FoldInput[] = [];
  const events: ThreadStatusEvent[] = [];
  let request: ThreadState["request"];
  let workpad: ThreadWorkpad | undefined;

  for (const reply of ordered) {
    // FIRST-SEEN text classifies a reply when the mirror recorded one: an edit must not
    // retroactively rewrite a folded transition (post a new command instead). Tombstoned
    // (deleted) replies keep their folded role for the same reason - both are the mirror's
    // in-session guarantee; API-served replies can only ever carry the current text.
    const classificationText = reply.firstSeenText ?? reply.text;
    if (botUserId !== undefined && reply.user === botUserId) {
      // Metadata is the machine-readable form of the bot's own writes: only the posting app can
      // attach it, so a metadata-bearing status reply needs no text parsing (and its text is
      // free to carry extra lines, e.g. a button-click attribution).
      const metadata = reply.metadata;
      if (metadata?.eventType === WORKPAD_METADATA_EVENT) {
        // The metadata payload round-trips the editable sections, so a partial tool update can
        // preserve omitted content without parsing rendered blocks.
        const plan = metadata.payload.plan;
        const note = metadata.payload.note;
        workpad = {
          ts: reply.ts,
          ...(typeof plan === "string" ? { plan } : {}),
          ...(typeof note === "string" ? { note } : {}),
        };
        continue;
      }
      if (metadata?.eventType === STATUS_METADATA_EVENT) {
        const raw = metadata.payload.state;
        const state = typeof raw === "string" ? resolveStateName(raw, settings) : null;
        if (state) {
          const actor =
            typeof metadata.payload.actor === "string" ? metadata.payload.actor : botUserId;
          foldInputs.push({
            kind: "status",
            event: { ts: reply.ts, state, actor },
          });
          continue;
        }
        // An unresolvable metadata state falls through to the text parse rather than being
        // silently dropped: the reply may still carry a valid `status:` line.
      }
      const status = BOT_STATUS_RE.exec(reply.text.trim());
      if (status) {
        const state = resolveStateName(status[1]!, settings);
        if (state) {
          foldInputs.push({
            kind: "status",
            event: { ts: reply.ts, state, actor: botUserId },
          });
        }
      }
      continue;
    }
    // Asides opt out of the fold entirely: not a command, and - crucially - not a bare mention,
    // so `@bot !aside fyi...` on a Done issue does not re-open it.
    if (isAsideText(classificationText, botUserId)) continue;
    if (!isBotMention(classificationText, botUserId)) continue;
    if (!rootIsMention && request === undefined) {
      // The first bot-mention reply from an allowed author in a non-mention thread is the request
      // itself, not a transition. A reply from a non-allowed author is skipped so a later allowed
      // reply can still become the request (the author allowlist narrows who can create issues).
      if (isAllowedAuthor(reply.user, users)) {
        request = { ts: reply.ts, text: reply.text, user: reply.user };
      }
      continue;
    }
    const command = parseStatusCommand(classificationText, botUserId, settings);
    if (command) {
      foldInputs.push({
        kind: "status",
        event: {
          ts: reply.ts,
          state: command.state,
          ...(reply.user !== undefined ? { actor: reply.user } : {}),
        },
      });
    } else {
      foldInputs.push({
        kind: "bare",
        ts: reply.ts,
        ...(reply.user !== undefined ? { actor: reply.user } : {}),
      });
    }
  }

  const hasExplicitStatus = foldInputs.some((input) => input.kind === "status");
  // Reactions are an unordered fallback only for unmarked roots. Once marked, the thread remains
  // authoritative across daemon restarts, including when the latest status event is deleted and
  // a derived visibility reaction remains.
  let state = rootIsMention
    ? root.botReactions.includes(markerEmoji)
      ? reopenState(settings)
      : stateFromReactions(root.botReactions, statusEmojiMap(settings), settings)
    : "Todo";
  let explicitStatusSeen = !hasExplicitStatus;
  for (const input of foldInputs) {
    if (input.kind === "status") {
      state = input.event.state;
      events.push(input.event);
      explicitStatusSeen = true;
      continue;
    }
    if (!explicitStatusSeen || !isTerminalState(state, settings)) continue;
    state = reopenState(settings);
    events.push({
      ts: input.ts,
      state,
      ...(input.actor !== undefined ? { actor: input.actor } : {}),
    });
  }

  return {
    state,
    events,
    ...(request !== undefined ? { request } : {}),
    ...(workpad !== undefined ? { workpad } : {}),
  };
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
  // Only bot-authored reactions can change the derived state, so only they invalidate.
  const reactionsKey = [...root.botReactions].sort().join(",");
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
