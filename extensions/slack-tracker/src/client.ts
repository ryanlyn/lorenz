import { defaultStateType, normalizeIssue } from "@lorenz/issue";
import type {
  Issue,
  IssueStateType,
  RuntimeTrackerClient,
  Settings,
  TrackerChange,
  TrackerChangeStream,
  TrackerIssueEvent,
} from "@lorenz/domain";

import {
  emojiForState,
  stateFromReactions,
  statusEmojiMap,
  stripLeadingMention,
} from "./mapping.js";
import { mirrorStatusReaction, requireTrackedMessage } from "./operations.js";
import { slackEndpoint, slackTrackerOptions } from "./options.js";
import { SlackSocketMode, type SlackSocketModeOptions } from "./socketMode.js";
import {
  isAsideText,
  parseStatusCommand,
  resolveThreadState,
  type ThreadState,
} from "./threadState.js";
import { isBotMarked } from "./transport.js";
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
    context.state ?? stateFromReactions(message.botReactions, statusEmojiMap(settings), settings);
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
 * Map a Slack root message onto a normalized tracker {@link Issue}, used by the runtime client
 * for candidate discovery. The identifier keeps the channel: Slack ts values are only unique per
 * channel, and workspace directories and cleanup are keyed by identifier downstream.
 */
function slackMessageToIssue(
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
  return [...scan.mentions, ...scan.threadedRoots.filter(isBotMarked)];
}

/**
 * One scan serves every read within a poll cycle: the runtime's by-id reconciliation forces a
 * fresh scan, and the candidate fetch that follows moments later reuses it instead of re-paging
 * channel history against a tightly rate-limited API. Comfortably shorter than any real poll
 * interval, so cross-poll staleness stays bounded.
 */
const SCAN_CACHE_TTL_MS = 10_000;

const DEFAULT_REPLY_LOOKBACK_DAYS = 2;

/** Entry cap for the per-issue mirror reconciliation cache (matches THREAD_STATE_CACHE_MAX). */
const MIRRORED_STATES_MAX = 5_000;

export class SlackTrackerClient implements RuntimeTrackerClient {
  private scanCache: { at: number; key: string; scan: SlackChannelScan } | null = null;
  /** Last state the reaction mirror was reconciled to, per issue (see healStatusMirror). */
  private readonly mirroredStates = new Map<string, string>();
  /** Serialized background queue of pending reaction-mirror heals (see healStatusMirror). */
  private mirrorHealQueue: Promise<void> = Promise.resolve();
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
    // Seam for tests: lets a fake Socket Mode (or one with an injected WebSocket) stand in.
    private readonly createSocketMode: (options: SlackSocketModeOptions) => SlackSocketMode = (
      options,
    ) => new SlackSocketMode(options),
  ) {
    const lookbackDays =
      slackTrackerOptions(settings).replyLookbackDays ?? DEFAULT_REPLY_LOOKBACK_DAYS;
    this.replyFloor = Date.now() / 1000 - lookbackDays * 86_400;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssuesByStates(this.settings.tracker.activeStates);
  }

  /**
   * Push capability (see {@link RuntimeTrackerClient.watch}). When an app-level token is
   * configured, open a Slack Socket Mode connection so a watched mention/reply/reaction nudges the
   * runtime to re-poll immediately - the dispatch path stays the pull-based scan, this only
   * collapses the up-to-`polling.intervalMs` wait to ~instant. Returns `null` (pull-only, as
   * before) when no app token is set or no channels are watched, so push is strictly opt-in and
   * never changes behavior for existing single-token deployments.
   */
  watch(onChange: (change?: TrackerChange) => void): TrackerChangeStream | null {
    const { channels, appToken } = slackTrackerOptions(this.settings);
    if (!appToken || appToken.trim() === "" || channels.length === 0) return null;
    const socket = this.createSocketMode({
      endpoint: slackEndpoint(this.settings),
      appToken,
      channels,
      onChange: (payload) => onChange(this.changeForSocketPayload(payload)),
    });
    socket.start();
    return socket;
  }

  async fetchIssueEvents(issueId: string, sinceTs: string): Promise<TrackerIssueEvent[]> {
    const parts = splitIssueId(issueId);
    if (!parts) return [];
    const [channel, threadTs] = parts;
    const { botUserId } = slackTrackerOptions(this.settings);
    const floor = tsValue(sinceTs);
    return (await this.transport.getThread(channel, threadTs))
      .filter((reply) => {
        if (tsValue(reply.ts) <= floor) return false;
        if (reply.user === undefined || reply.user === botUserId) return false;
        if (isAsideText(reply.text, botUserId)) return false;
        return parseStatusCommand(reply.text, botUserId, this.settings) === null;
      })
      .sort((left, right) => tsValue(left.ts) - tsValue(right.ts))
      .map((reply) => ({
        ts: reply.ts,
        text: reply.text,
        ...(reply.user !== undefined ? { author: reply.user } : {}),
      }));
  }

  private changeForSocketPayload(payload: Record<string, unknown> | undefined): TrackerChange {
    const event = payload?.event;
    if (!event || typeof event !== "object" || Array.isArray(event)) return {};
    const record = event as Record<string, unknown>;
    if (record.type !== "message" && record.type !== "app_mention") return {};
    if (typeof record.subtype === "string") return {};
    const channel = typeof record.channel === "string" ? record.channel : null;
    const ts = typeof record.ts === "string" ? record.ts : null;
    const threadTs = typeof record.thread_ts === "string" ? record.thread_ts : null;
    const text = typeof record.text === "string" ? record.text : null;
    const user = typeof record.user === "string" ? record.user : null;
    if (!channel || !ts || !threadTs || threadTs === ts || !text || !user) return {};
    const { botUserId } = slackTrackerOptions(this.settings);
    if (user === botUserId || isAsideText(text, botUserId)) return {};
    if (parseStatusCommand(text, botUserId, this.settings) !== null) return {};
    return {
      issueEvents: {
        issueId: `${channel}:${threadTs}`,
        events: [{ ts, author: user, text }],
      },
    };
  }

  /** Resolve a tracked root's thread state and map it to a normalized issue. */
  private async issueFromRoot(root: SlackMessage, base: string | null): Promise<Issue> {
    const thread = await resolveThreadState(this.settings, this.transport, root);
    return slackMessageToIssue(root, this.settings, {
      permalinkBase: base,
      state: thread.state,
      request: thread.request,
    });
  }

  /**
   * The by-id refresh is driven by one fresh channel scan: every id whose root is in the scan is
   * resolved from it with no per-id read, and the scan warms the cache for the candidate fetch
   * that follows in the same poll cycle - so a poll costs one scan, not a scan plus a read per
   * tracked issue. Ids outside the scan (roots older than any configured scan window) fall back
   * to authoritative per-id reads, so a still-valid root is never reported gone (the runtime
   * would release its claim). The fresh scan (not the cached one) keeps this path as current as
   * the per-id reads it replaces: the runtime aborts and releases runs based on these states.
   */
  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const parsed = ids.flatMap((id) => {
      const parts = splitIssueId(id);
      return parts ? [[id, parts] as const] : [];
    });
    if (parsed.length === 0) return [];
    const [scan, base] = await Promise.all([
      this.scanCached({ forceRefresh: true }),
      this.transport.teamUrl(),
    ]);
    const scannedById = new Map<string, SlackMessage>(
      trackedRootsOf(scan).map((root) => [`${root.channel}:${root.ts}`, root]),
    );
    const out: Issue[] = [];
    for (const [id, parts] of parsed) {
      let root = scannedById.get(id);
      if (!root) {
        // Apply the same tracked-message predicate as candidate discovery and the Slack write
        // tools. If a human edits the request away, the issue reconciles as gone, not live.
        try {
          root = await requireTrackedMessage(this.settings, this.transport, parts[0], parts[1]);
        } catch {
          continue;
        }
      }
      out.push(await this.issueFromRoot(root, base));
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
      if (isBotMarked(root)) continue;
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
      this.healStatusMirror(root, thread.state);
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
   * per state change per issue - the guard keeps a heal that cannot fully converge (e.g. a
   * mapped emoji missing from the workspace) from churning the API every poll.
   *
   * Scheduling is synchronous but the reaction writes run in a BACKGROUND queue: reactions are
   * Slack Tier-3 methods, so a heal pass over a cold backlog (restart, newly watched channel)
   * can spend minutes in 429 backoff. That wait must not sit inside trackedIssues() - it would
   * starve candidate discovery and dispatch of issues that are already fully resolved. The queue
   * is serialized so heals never compete with each other for the rate limit, and it is bounded:
   * `mirroredStates` marks the issue at schedule time, so one heal is queued per state change
   * per issue no matter how many polls elapse while the queue drains.
   */
  private healStatusMirror(root: SlackMessage, state: string): void {
    const key = `${root.channel}:${root.ts}`;
    if (this.mirroredStates.get(key) === state) return;
    // Bounded like threadStateCache: a clear only lets already-converged mirrors re-check (the
    // stale/missing gate blocks them) and non-convergent ones retry once more.
    if (this.mirroredStates.size >= MIRRORED_STATES_MAX) this.mirroredStates.clear();
    this.mirroredStates.set(key, state);
    const map = statusEmojiMap(this.settings);
    const target = emojiForState(state, map);
    // Only the bot's own reactions constitute the mirror: a human's managed emoji is neither
    // state-bearing nor removable by the bot, so it never triggers (or blocks) a heal.
    const staleManaged = root.botReactions.some(
      (reaction) => typeof map[reaction] === "string" && reaction !== target,
    );
    const missingTarget = target !== null && !root.botReactions.includes(target);
    if (!staleManaged && !missingTarget) return;
    // Capture only what the heal needs: the queued closure can outlive minutes of 429 backoff,
    // and holding `root` would pin every backlogged message body in memory until the queue drains.
    const { channel, ts } = root;
    const observed = [...root.botReactions];
    this.mirrorHealQueue = this.mirrorHealQueue.then(async () => {
      try {
        await mirrorStatusReaction(this.settings, this.transport, channel, ts, state, observed);
      } catch {
        // Defensive only (mirror writes already swallow their own failures): a rejection here
        // would poison the serialized queue and silently skip every later heal.
      }
    });
  }

  /**
   * Resolves once every mirror heal scheduled SO FAR has finished. Deterministic settling point
   * for tests and for callers that want the mirror visibly converged (e.g. before shutdown).
   */
  async flushStatusMirrorHeals(): Promise<void> {
    await this.mirrorHealQueue;
  }

  private async scanCached(options: { forceRefresh?: boolean } = {}): Promise<SlackChannelScan> {
    const key = this.channels().join(",");
    const now = Date.now();
    if (
      options.forceRefresh !== true &&
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
