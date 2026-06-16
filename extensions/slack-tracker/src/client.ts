import { defaultStateType, normalizeIssue } from "@lorenz/issue";
import type { Issue, IssueStateType, RuntimeTrackerClient, Settings } from "@lorenz/domain";

import {
  emojiForState,
  stateFromReactions,
  statusEmojiMap,
  stripLeadingMention,
} from "./mapping.js";
import { mirrorStatusReaction, requireTrackedMessage } from "./operations.js";
import { slackTrackerOptions } from "./options.js";
import { resolveThreadState, type ThreadState } from "./threadState.js";
import type { SlackChannelScan, SlackMessage, SlackTransport } from "./transport.js";

export function splitIssueId(id: string): [string, string] | null {
  const idx = id.indexOf(":");
  if (idx === -1) return null;
  return [id.slice(0, idx), id.slice(idx + 1)];
}

/**
 * Derive labels from hashtag tokens in `text`: match `#tag`, strip the leading `#`, lowercase,
 * and dedupe (preserving first-seen order). Lets Slack issues carry plain routing/filter labels.
 *
 * The `#` must be at a boundary (start of string or preceded by whitespace) so in-token `#`s -
 * a URL fragment (`http://x#frag`) or a hex color (`color:#fff`) - do not leak in as bogus labels.
 *
 * Every mrkdwn angle-bracket token is stripped first: channel references (`<#C0ABC|general>`)
 * and user mentions (`<@U123|alice>`) embed an id behind `#`/`@`, and links (`<url|caption>`)
 * can carry a `#hashtag` inside their display caption - none of those are author-intended tags,
 * and a leaked one could even become a dispatch route.
 */
function deriveLabels(text: string): string[] {
  const stripped = text.replace(/<[^>]*>/g, " ");
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const match of stripped.matchAll(/(?<=^|\s)#([a-z0-9][a-z0-9_-]*)/gi)) {
    const label = match[1]!.toLowerCase();
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

/**
 * A flat, agent-facing view of a Slack issue derived from its source message. Shared by the
 * read tooling (`slack_query`) and the runtime client so the two never drift on how a message
 * maps to a title/state/labels.
 */
export interface SlackIssueRow {
  /** `<channel>:<ts>` - the canonical Slack issue id (always the thread ROOT). */
  issueId: string;
  channel: string;
  ts: string;
  /** First line of the request with the leading bot mention stripped (falls back to the ts). */
  title: string;
  /** Workflow state: thread-derived when known, else reaction-derived, else "Todo". */
  state: string;
  stateType: IssueStateType;
  labels: string[];
  /** Full root message text. */
  text: string;
  reactions: string[];
  /** Permalink to the source message, when the workspace URL is known. */
  url?: string | undefined;
}

/** Context a caller already resolved for the row: permalink base and thread-derived state. */
export interface SlackIssueContext {
  permalinkBase?: string | null | undefined;
  /** Thread-derived state; when omitted the row falls back to the reaction-derived reading. */
  state?: string | undefined;
  /** The request reply for threads whose root does not mention the bot. */
  request?: ThreadState["request"];
}

/**
 * Permalink to a message: `<workspace base>/archives/<channel>/p<ts without the dot>` - the
 * same shape Slack's own "copy link" produces.
 */
export function slackPermalink(base: string, channel: string, ts: string): string {
  return `${base.replace(/\/+$/, "")}/archives/${encodeURIComponent(channel)}/p${ts.replace(".", "")}`;
}

/**
 * Map a Slack root message onto the flat {@link SlackIssueRow} view. Pure; performs no IO -
 * thread-derived state and the workspace base URL come in via {@link SlackIssueContext}.
 */
export function slackMessageToRow(
  message: SlackMessage,
  settings: Settings,
  context: SlackIssueContext = {},
): SlackIssueRow {
  const state =
    context.state ?? stateFromReactions(message.reactions, statusEmojiMap(settings), settings);
  // For reply-tracked threads the request reply carries the ask; the root is surrounding
  // conversation. Title (and routing hashtags) come from the request, labels from both.
  const requestText = context.request?.text;
  const titleSource = requestText ?? message.text;
  const firstLine = (titleSource.split("\n")[0] ?? "").trim();
  const title =
    stripLeadingMention(firstLine, slackTrackerOptions(settings).botUserId).trim() || message.ts;
  // normalizeIssue requires a stateType. Fall back to "backlog" for custom emoji_states mappings
  // whose state name is not a known category, so an unknown status never crashes the read.
  const stateType = defaultStateType(state) ?? "backlog";
  const base = context.permalinkBase;
  return {
    issueId: `${message.channel}:${message.ts}`,
    channel: message.channel,
    ts: message.ts,
    title,
    state,
    stateType,
    labels: deriveLabels(requestText ? `${message.text}\n${requestText}` : message.text),
    text: message.text,
    reactions: [...message.reactions],
    ...(base ? { url: slackPermalink(base, message.channel, message.ts) } : {}),
  };
}

/**
 * Map a Slack root message onto a normalized tracker {@link Issue}. Shared by the runtime
 * client and the tracker tool operations so candidate discovery and agent tools never drift on
 * how a message becomes an issue. The identifier keeps the channel: Slack ts values are only
 * unique per channel, and workspace directories and cleanup are keyed by identifier downstream.
 */
export function slackMessageToIssue(
  message: SlackMessage,
  settings: Settings,
  context: SlackIssueContext = {},
): Issue {
  const row = slackMessageToRow(message, settings, context);
  const createdAtMs = Math.floor(Number.parseFloat(message.ts) * 1000);
  const description = context.request
    ? `${context.request.text}\n\n(thread root) ${message.text}`
    : message.text;
  return normalizeIssue({
    id: row.issueId,
    identifier: `SLK-${message.channel}-${message.ts.replace(/\./g, "-")}`,
    title: row.title,
    description,
    state: row.state,
    state_type: row.stateType,
    labels: row.labels,
    ...(row.url !== undefined ? { url: row.url } : {}),
    ...(Number.isFinite(createdAtMs) ? { created_at: new Date(createdAtMs).toISOString() } : {}),
    raw: message,
  });
}

/**
 * Tracked roots of one scan: every bot-mention root, plus every threaded root the bot has
 * marked with its own reaction (reply-tracked issues recognized across restarts without
 * re-reading their threads).
 */
export function trackedRootsOf(scan: SlackChannelScan): SlackMessage[] {
  return [...scan.mentions, ...scan.threadedRoots.filter((root) => root.botReacted === true)];
}

/**
 * One scan serves every read within a poll cycle: the runtime triggers two back-to-back full
 * scans per cycle (terminal-state reconciliation, then candidates), and each scan pages the
 * full channel history against a tightly rate-limited API. Comfortably shorter than any real
 * poll interval, so cross-poll staleness stays bounded.
 */
const SCAN_CACHE_TTL_MS = 10_000;

const DEFAULT_REPLY_LOOKBACK_DAYS = 2;

export class SlackTrackerClient implements RuntimeTrackerClient {
  private scanCache: { at: number; key: string; scan: SlackChannelScan } | null = null;
  /** Last state the reaction mirror was reconciled to, per issue (see healStatusMirror). */
  private readonly mirroredStates = new Map<string, string>();
  /**
   * Oldest thread activity (epoch seconds) considered when hunting for NEW reply-mention
   * requests in untracked threads. Once tracked, a thread is marked with the bot's reaction
   * and recognized regardless of age; the floor only bounds first discovery, so a reply
   * mention posted while the daemon was down longer than the lookback is not picked up.
   */
  private readonly replyFloor: number;

  constructor(
    private readonly settings: Settings,
    private readonly transport: SlackTransport,
  ) {
    const lookbackDays =
      slackTrackerOptions(settings).replyLookbackDays ?? DEFAULT_REPLY_LOOKBACK_DAYS;
    this.replyFloor = Date.now() / 1000 - lookbackDays * 86_400;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssuesByStates(this.settings.tracker.activeStates);
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const base = await this.transport.teamUrl();
    const out: Issue[] = [];
    for (const id of ids) {
      const parts = splitIssueId(id);
      if (!parts) continue;
      const [channel, ts] = parts;
      // Apply the same tracked-message predicate as candidate discovery and the Slack write
      // tools. If a human edits the request away, the issue reconciles as gone, not live.
      let root: SlackMessage;
      try {
        root = await requireTrackedMessage(this.settings, this.transport, channel, ts);
      } catch {
        continue;
      }
      const thread = await resolveThreadState(this.settings, this.transport, root);
      out.push(
        slackMessageToIssue(root, this.settings, {
          permalinkBase: base,
          state: thread.state,
          request: thread.request,
        }),
      );
    }
    return out;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const wanted = new Set(states.map((s) => s.trim().toLowerCase()));
    const issues = await this.trackedIssues();
    return issues.filter((i) => wanted.has(i.state.trim().toLowerCase()));
  }

  private async trackedIssues(): Promise<Issue[]> {
    const [scan, base] = await Promise.all([this.scanCached(), this.transport.teamUrl()]);
    const roots = trackedRootsOf(scan);
    // Hunt for NEW reply-mention requests: untracked threads with activity inside the lookback
    // window. A thread is tracked once a reply mentions the bot; the bot then marks the root
    // with its own reaction so later polls (and restarts) recognize it from the scan alone.
    for (const root of scan.threadedRoots) {
      if (root.botReacted === true) continue;
      if (tsValue(root.latestReply) <= this.replyFloor) continue;
      const thread = await resolveThreadState(this.settings, this.transport, root);
      if (!thread.request) continue;
      roots.push(root);
      try {
        await this.transport.addReaction(root.channel, root.ts, this.markerEmoji());
      } catch {
        // Tracking still works this poll; the marker retries on the next discovery pass.
      }
    }
    const issues: Issue[] = [];
    for (const root of roots) {
      const thread = await resolveThreadState(this.settings, this.transport, root);
      await this.healStatusMirror(root, thread.state);
      issues.push(
        slackMessageToIssue(root, this.settings, {
          permalinkBase: base,
          state: thread.state,
          request: thread.request,
        }),
      );
    }
    return issues;
  }

  /**
   * Self-healing reaction mirror: when a HUMAN transitions status (`@bot !done`, a bare
   * re-mention re-open), the bot's reaction still shows the previous state until the bot acts
   * again. Reconcile the mirror to the thread-derived state during the poll, attempted once
   * per state change per issue - a stale HUMAN-authored reaction is not removable by the bot
   * (reactions are per-author), so retrying every poll would only churn the API.
   */
  private async healStatusMirror(root: SlackMessage, state: string): Promise<void> {
    const key = `${root.channel}:${root.ts}`;
    if (this.mirroredStates.get(key) === state) return;
    const map = statusEmojiMap(this.settings);
    const target = emojiForState(state, map);
    const staleManaged = root.reactions.some(
      (reaction) => typeof map[reaction] === "string" && reaction !== target,
    );
    const missingTarget = target !== null && !root.reactions.includes(target);
    if (staleManaged || missingTarget) {
      await mirrorStatusReaction(this.settings, this.transport, root.channel, root.ts, state);
    }
    this.mirroredStates.set(key, state);
  }

  private async scanCached(): Promise<SlackChannelScan> {
    const key = this.channels().join(",");
    const now = Date.now();
    if (
      this.scanCache &&
      this.scanCache.key === key &&
      now - this.scanCache.at < SCAN_CACHE_TTL_MS
    ) {
      return this.scanCache.scan;
    }
    const scan = await this.transport.scanChannels(this.channels());
    this.scanCache = { at: Date.now(), key, scan };
    return scan;
  }

  private channels(): string[] {
    return slackTrackerOptions(this.settings).channels;
  }

  private markerEmoji(): string {
    return slackTrackerOptions(this.settings).markerEmoji ?? "robot_face";
  }
}

function tsValue(ts: string | undefined): number {
  if (ts === undefined) return 0;
  const value = Number.parseFloat(ts);
  return Number.isFinite(value) ? value : 0;
}
