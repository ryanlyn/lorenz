import { defaultStateType, normalizeIssue } from "@lorenz/issue";
import {
  boundTrackerIssueEventText,
  isRecord,
  trackerIssueEventsBytes,
  type Issue,
  type IssueStateType,
  type RuntimeTrackerClient,
  type Settings,
  type TrackerChange,
  type TrackerChangeStream,
  type TrackerIssueEvent,
  type TrackerIssueEventPage,
  type TrackerIssueEventQuery,
} from "@lorenz/domain";

import { compareSlackTs, isSlackTs, splitIssueId } from "./ids.js";
import { handleSlackInteraction } from "./interactions.js";
import {
  emojiForState,
  isAllowedAuthor,
  isBotMention,
  stateFromReactions,
  statusEmojiMap,
  stripLeadingMention,
} from "./mapping.js";
import { MirrorBackedSlackTransport } from "./mirror.js";
import { mirrorStatusReaction, requireTrackedMessage } from "./operations.js";
import { slackEndpoint, slackTrackerOptions } from "./options.js";
import { SlackSocketMode, type SlackSocketModeOptions } from "./socketMode.js";
import {
  isAsideText,
  parseStatusCommand,
  resolveThreadState,
  type ThreadState,
} from "./threadState.js";
import { registerSlackRuntimeTransport } from "./toolTransport.js";
import { isBotMarked } from "./transport.js";
import type {
  SlackChannelScan,
  SlackMessage,
  SlackThreadReply,
  SlackTransport,
} from "./transport.js";

// Re-exported here for API stability because package consumers and the tool pack import it from
// the client module.
export { splitIssueId };

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
    issue_event_cursor: context.request?.ts ?? "0",
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

/** Minimum gap between "already running" ephemerals for one issue+author pair. */
const BUSY_NOTICE_WINDOW_MS = 10 * 60_000;

/** Bound on Slack API pages inspected by one recovery request. */
const MAX_THREAD_RECOVERY_PAGES = 500;

export class SlackTrackerClient implements RuntimeTrackerClient {
  private scanCache: { at: number; key: string; scan: SlackChannelScan } | null = null;
  /** Last state the reaction mirror was reconciled to, per issue (see healStatusMirror). */
  private readonly mirroredStates = new Map<string, string>();
  /** Serialized background queue of pending reaction-mirror heals (see healStatusMirror). */
  private mirrorHealQueue: Promise<void> = Promise.resolve();
  /** Last "already running" ephemeral per issue+author, so a chatty thread is nudged once. */
  private readonly busyNoticeAt = new Map<string, number>();
  /**
   * Oldest thread activity (epoch seconds) considered when hunting for NEW reply-mention
   * requests in untracked threads. Once tracked, a thread is marked with the bot's reaction
   * and recognized regardless of age; the floor only bounds first discovery, so a reply
   * mention posted while the daemon was down longer than the lookback is not picked up.
   */
  private readonly replyFloor: number;
  /**
   * The effective transport. With an app token this is the event-fed channel mirror wrapping
   * the real transport (polls read memory; the scan becomes reconciliation); without one it is
   * the raw transport and every poll is a real scan.
   */
  private readonly transport: SlackTransport;
  private readonly channelMirror: MirrorBackedSlackTransport | null;

  constructor(
    private readonly settings: Settings,
    transport: SlackTransport,
    // Seam for tests: lets a fake Socket Mode (or one with an injected WebSocket) stand in.
    private readonly createSocketMode: (options: SlackSocketModeOptions) => SlackSocketMode = (
      options,
    ) => new SlackSocketMode(options),
  ) {
    const options = slackTrackerOptions(settings);
    const lookbackDays = options.replyLookbackDays ?? DEFAULT_REPLY_LOOKBACK_DAYS;
    this.replyFloor = Date.now() / 1000 - lookbackDays * 86_400;
    // The mirror is only worth constructing when a socket can feed it; it refuses to serve
    // until the socket reports healthy anyway (isFresh), so this is belt and braces.
    this.channelMirror =
      options.appToken !== undefined &&
      options.appToken.trim() !== "" &&
      options.channels.length > 0
        ? new MirrorBackedSlackTransport(transport, settings, {
            reconcileIntervalMs: options.reconcileIntervalMs,
          })
        : null;
    this.transport = this.channelMirror ?? transport;
    registerSlackRuntimeTransport(settings, this.transport);
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssuesByStates(this.settings.tracker.activeStates);
  }

  /**
   * Push capability (see {@link RuntimeTrackerClient.watch}). When an app-level token is
   * configured, open a Slack Socket Mode connection. Watched events update the channel mirror
   * before nudging the poll path, eligible thread replies also carry structured steering input,
   * and interactive envelopes route workpad actions through the same connection. Returns `null`
   * when no app token is set or no channels are watched, leaving the tracker pull-only.
   */
  watch(onChange: (change?: TrackerChange) => void): TrackerChangeStream | null {
    const { channels, appToken } = slackTrackerOptions(this.settings);
    if (!appToken || appToken.trim() === "" || channels.length === 0) return null;
    const socket = this.createSocketMode({
      endpoint: slackEndpoint(this.settings),
      appToken,
      channels,
      onChange: (payload) => onChange(this.changeForSocketPayload(payload)),
      onEvent: (payload) => {
        this.channelMirror?.applyEvent(payload);
        this.scanCache = null;
        this.noticeIfBusyReply(payload);
      },
      onInteractive: (payload) => {
        void handleSlackInteraction(payload, {
          settings: this.settings,
          transport: this.transport,
          logger: { warn: (message) => console.warn(message) },
          nudge: () => onChange(),
        });
      },
      // Each accepted connection closes the gap after the preceding API snapshot; while
      // disconnected the mirror refuses to serve at all (connection-state gate).
      onReconnect: () => this.channelMirror?.markAllDirty("socket connection ready"),
      onConnectionState: (connected) => this.channelMirror?.setSocketHealthy(connected),
    });
    socket.start();
    return socket;
  }

  /**
   * Return bounded, oldest-first steering events newer than `sinceTs`. With the channel mirror
   * active, the same transport contract is served from event-fed memory between reconciliations.
   */
  async fetchIssueEvents(
    issueId: string,
    sinceTs: string,
    query: TrackerIssueEventQuery,
  ): Promise<TrackerIssueEventPage> {
    if (!Number.isInteger(query.maxEvents) || query.maxEvents <= 0) {
      throw new Error("Slack issue-event maxEvents must be a positive integer");
    }
    if (!Number.isInteger(query.maxBytes) || query.maxBytes <= 0) {
      throw new Error("Slack issue-event maxBytes must be a positive integer");
    }
    if (!isSlackTs(sinceTs)) {
      throw new Error(`invalid Slack issue-event cursor: ${sinceTs}`);
    }
    const parts = splitIssueId(issueId);
    if (!parts) return { events: [], hasMore: false };
    const [channel, threadTs] = parts;
    query.abortSignal?.throwIfAborted();
    const events: TrackerIssueEvent[] = [];
    let bytes = 0;
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_THREAD_RECOVERY_PAGES; pageIndex += 1) {
      const page = await this.transport.getThreadPage(channel, threadTs, {
        afterTs: sinceTs,
        limit: 200,
        ...(cursor ? { cursor } : {}),
        ...(query.abortSignal ? { abortSignal: query.abortSignal } : {}),
      });
      for (let index = 0; index < page.replies.length; index += 1) {
        const event = steeringEventForReply(page.replies[index]!, this.settings);
        if (!event || compareSlackTs(event.ts, sinceTs) <= 0) continue;
        const bounded = boundTrackerIssueEventText(event, query.maxBytes);
        if (!bounded) {
          throw new Error(`Slack issue-event metadata exceeds the page byte limit: ${event.ts}`);
        }
        const eventBytes = trackerIssueEventsBytes([bounded]);
        if (bytes + eventBytes > query.maxBytes) {
          return { events, hasMore: true };
        }
        events.push(bounded);
        bytes += eventBytes;
        if (events.length >= query.maxEvents) {
          const hasUnexaminedReplies =
            page.replies.slice(index + 1).some((reply) => {
              const remaining = steeringEventForReply(reply, this.settings);
              return remaining !== null && compareSlackTs(remaining.ts, sinceTs) > 0;
            }) || page.nextCursor !== undefined;
          return { events, hasMore: hasUnexaminedReplies };
        }
      }
      cursor = page.nextCursor;
      if (!cursor) return { events, hasMore: false };
    }
    if (events.length === 0) {
      throw new Error(
        `Slack issue-event recovery exceeded ${MAX_THREAD_RECOVERY_PAGES} pages without progress`,
      );
    }
    return { events, hasMore: true };
  }

  private changeForSocketPayload(payload: Record<string, unknown> | undefined): TrackerChange {
    const event = payload?.event;
    if (!isRecord(event)) return {};
    const record = event;
    if (record.type !== "message" && record.type !== "app_mention") return {};
    const subtype = typeof record.subtype === "string" ? record.subtype : null;
    const channel = typeof record.channel === "string" ? record.channel : null;
    const ts = typeof record.ts === "string" ? record.ts : null;
    const threadTs = typeof record.thread_ts === "string" ? record.thread_ts : null;
    const text = typeof record.text === "string" ? record.text : null;
    const user = typeof record.user === "string" ? record.user : null;
    if (!channel || !ts || !threadTs || threadTs === ts || !text || !user) return {};
    const steeringEvent = steeringEventForReply(
      {
        ts,
        text,
        user,
        ...(subtype ? { subtype } : {}),
        isBot: typeof record.bot_id === "string",
      },
      this.settings,
    );
    if (!steeringEvent) return {};
    return {
      issueEvents: {
        issueId: `${channel}:${threadTs}`,
        events: [steeringEvent],
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
      this.healStatusMirror(root, thread);
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
  private healStatusMirror(root: SlackMessage, thread: ThreadState): void {
    const state = thread.state;
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
    const healReaction = staleManaged || missingTarget;
    this.mirrorHealQueue = this.mirrorHealQueue.then(async () => {
      try {
        if (healReaction) {
          await mirrorStatusReaction(this.settings, this.transport, channel, ts, state, observed);
        }
      } catch {
        // Defensive only: a rejection here would poison the serialized queue and silently skip
        // every later heal. Let the next poll reschedule this issue.
        this.mirroredStates.delete(key);
      }
    });
  }

  /**
   * Ephemeral "already running" notice: when a human posts a bare (command-less) bot-mention
   * reply on an issue that is already in a beyond-initial active state, tell THAT author -
   * quietly, once per issue+author per window - that replies queue as the agent's next turn
   * and how to stop it. A politeness surface, never a lock: dispatch concurrency is the
   * runtime's claim model.
   */
  private noticeIfBusyReply(payload: Record<string, unknown>): void {
    const event = payload.event;
    if (!isRecord(event)) return;
    if (event.type !== "message" && event.type !== "app_mention") return;
    if (typeof event.subtype === "string") return; // edits/deletes/system messages are not asks
    const channel = typeof event.channel === "string" ? event.channel : null;
    const ts = typeof event.ts === "string" ? event.ts : null;
    const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : null;
    const user = typeof event.user === "string" ? event.user : null;
    const text = typeof event.text === "string" ? event.text : "";
    if (channel === null || ts === null || threadTs === null || threadTs === ts) return;
    const { botUserId, users } = slackTrackerOptions(this.settings);
    if (user === null || botUserId === undefined || user === botUserId) return;
    if (!isAllowedAuthor(user, users)) return;
    if (!isBotMention(text, botUserId)) return;
    if (isAsideText(text, botUserId)) return;
    if (parseStatusCommand(text, botUserId, this.settings) !== null) return;
    const noticeKey = `${channel}:${threadTs}:${user}`;
    const now = Date.now();
    const last = this.busyNoticeAt.get(noticeKey);
    if (last !== undefined && now - last < BUSY_NOTICE_WINDOW_MS) return;
    this.busyNoticeAt.set(noticeKey, now);
    if (this.busyNoticeAt.size >= MIRRORED_STATES_MAX) this.busyNoticeAt.clear();
    void this.postBusyNotice(channel, threadTs, user).catch(() => {
      // Best-effort by definition; a failed notice must never surface anywhere.
    });
  }

  private async postBusyNotice(channel: string, threadTs: string, user: string): Promise<void> {
    const root = await this.transport.getMessage(channel, threadTs);
    if (!root) return;
    const thread = await resolveThreadState(this.settings, this.transport, root);
    const active = this.settings.tracker.activeStates;
    const stateLower = thread.state.trim().toLowerCase();
    const activeIndex = active.findIndex((s) => s.trim().toLowerCase() === stateLower);
    // Only states BEYOND the initial one read as "an agent is on this": Todo-like issues are
    // simply awaiting dispatch and a notice would be noise.
    if (activeIndex <= 0) return;
    await this.transport.postEphemeral(
      channel,
      user,
      threadTs,
      `Lorenz is already working on this issue (status: ${thread.state}). Replies reach the ` +
        "agent as its next queued turn; `@bot !cancel` (or the workpad's Cancel button) stops it.",
    );
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

function steeringEventForReply(
  reply: SlackThreadReply,
  settings: Settings,
): TrackerIssueEvent | null {
  const { botUserId, users } = slackTrackerOptions(settings);
  if (!isSlackTs(reply.ts) || compareSlackTs(reply.ts, "0") <= 0) return null;
  if (reply.subtype !== undefined && reply.subtype !== "thread_broadcast") return null;
  if (
    reply.user === undefined ||
    reply.isBot === true ||
    reply.edited === true ||
    reply.deleted === true ||
    reply.user === botUserId
  ) {
    return null;
  }
  if (!isAllowedAuthor(reply.user, users)) return null;
  const classificationText = reply.firstSeenText ?? reply.text;
  if (isAsideText(classificationText, botUserId)) return null;
  if (parseStatusCommand(classificationText, botUserId, settings) !== null) return null;
  return {
    authorizedForSteering: true,
    ts: reply.ts,
    author: reply.user,
    text: reply.text,
  };
}
