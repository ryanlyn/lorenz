import { errorMessage, isRecord, type Settings } from "@lorenz/domain";

import { compareSlackTs, isSlackTs } from "./ids.js";
import { isAllowedAuthor, isBotMention } from "./mapping.js";
import { slackTrackerOptions } from "./options.js";
import { parseStatusCommand, stateFromThread } from "./threadState.js";
import type {
  SlackChannelScan,
  SlackMessage,
  SlackMessageMetadata,
  SlackPostOptions,
  SlackThreadReply,
  SlackThreadReplyPage,
  SlackThreadReplyPageQuery,
  SlackTransport,
  SlackUser,
} from "./transport.js";
import { toMessageMetadata, type SlackTrackerLogger } from "./webTransport.js";

/**
 * Event-primary discovery: a transport wrapper that serves `scanChannels`/`getThread` from a
 * LOCAL, event-fed mirror of the watched channels, so the runtime's poll loop reads memory
 * instead of re-paging `conversations.history`/`conversations.replies` every cycle.
 *
 * The trust model is deliberately asymmetric:
 *
 * - Slack events are hints that keep the mirror current between real scans. They are applied
 *   idempotently (everything is keyed by `channel:ts`, so Slack's guaranteed duplicate
 *   deliveries - `app_mention` + `message` for one mention, redelivered envelopes - collapse
 *   into upserts).
 * - The REAL scan remains the substrate. It rebuilds a channel's mirror at bootstrap, after
 *   every socket reconnect (Slack replays nothing missed while disconnected), whenever an event
 *   cannot be applied cleanly (the channel is marked DIRTY rather than guessed at), and on a
 *   slow reconciliation interval as a standing repair pass. While the socket is unhealthy the
 *   mirror never serves at all, so a pull-only or degraded deployment uses the raw transport.
 *
 * The fold over thread events is idempotent, which is what makes this safe: a duplicated,
 * reordered, or re-scanned input re-derives the same state.
 */

/** Default standing-repair cadence while the socket is healthy (overridable per tracker). */
const DEFAULT_RECONCILE_INTERVAL_MS = 15 * 60_000;
const MIRROR_THREAD_CURSOR_PREFIX = "mirror:";
const API_THREAD_CURSOR_PREFIX = "api:";
const ROOT_CREATE_BARRIERS_MAX = 5_000;

interface MirrorReply {
  ts: string;
  text: string;
  subtype?: string | undefined;
  isBot?: boolean | undefined;
  edited: boolean;
  /**
   * Text at first observation. Command classification folds THIS (first-seen wins): a later
   * edit cannot retroactively rewrite a transition. Slack's API cannot return pre-edit text,
   * so the guarantee is per daemon session; a rebuild scan folds current text (documented).
   */
  firstSeenText: string;
  user?: string | undefined;
  metadata?: SlackMessageMetadata | undefined;
  /** Tombstone: deleted after observation. Keeps its folded role until the next real scan. */
  deleted: boolean;
}

interface MirrorRoot {
  ts: string;
  text: string;
  user?: string | undefined;
  /** All reaction names on the root (display), and the bot-authored subset (state-bearing). */
  reactions: string[];
  botReactions: string[];
  /**
   * reply_count/latest_reply as last reported by the API, used until the thread map becomes
   * authoritative (events keep the map current; these hints only seed the scan row).
   */
  replyCountHint: number;
  latestReplyHint?: string | undefined;
}

interface ChannelState {
  roots: Map<string, MirrorRoot>;
  threads: Map<string, Map<string, MirrorReply>>;
  /** Threads whose reply map is complete (API-fetched once, then event-maintained). */
  authoritativeThreads: Set<string>;
  /** reply ts -> root ts, so edits/deletes/reactions on replies find their thread. */
  replyIndex: Map<string, string>;
  /** Edited/deleted root timestamps that delayed duplicate create events must not overwrite. */
  rootCreateBarriers: Set<string>;
  /** Roots that have observed at least one thread-derived status transition. */
  rootsWithThreadEvents: Set<string>;
  /** Last successful real scan; null until bootstrapped. */
  syncedAt: number | null;
  /** Set on any doubt; forces the next scan to be a real one. */
  dirty: boolean;
}

export interface MirrorOptions {
  reconcileIntervalMs?: number | undefined;
  now?: (() => number) | undefined;
  logger?: SlackTrackerLogger | undefined;
}

export class MirrorBackedSlackTransport implements SlackTransport {
  private readonly channels = new Map<string, ChannelState>();
  private readonly botUserId: string | undefined;
  private readonly allowedUsers: string[];
  private readonly reconcileIntervalMs: number;
  private readonly now: () => number;
  private readonly logger: SlackTrackerLogger;
  private socketHealthy = false;
  /**
   * Serialized mirror mutation. Events, reconciliation snapshot installation, and fetched-thread
   * installation share this queue so an API response can never overwrite an event that arrived
   * while the request was in flight.
   */
  private mutationQueue: Promise<void> = Promise.resolve();
  /** Reply ts values whose ignored edit already produced a thread notice (one per message). */
  private readonly editNoticed = new Set<string>();

  constructor(
    private readonly inner: SlackTransport,
    private readonly settings: Settings,
    options: MirrorOptions = {},
  ) {
    const slackOptions = slackTrackerOptions(settings);
    this.botUserId = slackOptions.botUserId;
    this.allowedUsers = slackOptions.users;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? { warn: (message) => console.warn(message) };
  }

  // ------------------------------------------------------------------ socket-facing surface

  /** Socket connection state; the mirror only ever serves while the event feed is live. */
  setSocketHealthy(connected: boolean): void {
    this.socketHealthy = connected;
  }

  /** Force real scans everywhere (reconnect gaps, operator suspicion). */
  markAllDirty(reason: string): void {
    void this.enqueueMutation(() => {
      for (const state of this.channels.values()) state.dirty = true;
      if (this.channels.size > 0) {
        this.logger.warn(`slack mirror: marked all channels dirty (${reason})`);
      }
    });
  }

  /**
   * Apply one Events API payload. Synchronous by contract (called from the socket's message
   * handler); the actual work is queued so failures can only ever dirty the mirror, never break
   * the socket, and reads settle the queue before serving.
   */
  applyEvent(payload: Record<string, unknown>): void {
    void this.enqueueMutation(async () => {
      try {
        await this.applyEventNow(payload);
      } catch (error) {
        // An unapplied event means the mirror can no longer claim event-completeness for that
        // channel; fail to the scan rather than serving a mirror with a known hole.
        this.logger.warn(`slack mirror: event application failed: ${errorMessage(error)}`);
        const channel = eventChannel(payload);
        if (channel !== null) this.markDirty(channel, "event application failed");
        else this.markAllDirty("event application failed (unknown channel)");
      }
    });
  }

  // ------------------------------------------------------------------ SlackTransport reads

  async scanChannels(channels: string[]): Promise<SlackChannelScan> {
    await this.settleEvents();
    const out: SlackChannelScan = { mentions: [], threadedRoots: [] };
    const stale = channels.filter((channel) => !this.isFresh(channel));
    // Stale channels re-scan CONCURRENTLY and independently, preserving the inner transport's
    // per-channel failure isolation: one unreadable channel keeps its old (dirty) mirror and is
    // skipped this poll; only an all-channels failure rejects, matching the poll_error contract.
    const results = await Promise.all(
      stale.map(async (channel) => {
        try {
          await this.rebuildChannel(channel);
          return { channel, ok: true as const };
        } catch (error) {
          return { channel, ok: false as const, failure: errorMessage(error) };
        }
      }),
    );
    // Events arriving during an API scan are queued behind snapshot installation. Settle them
    // before collecting so this poll includes both the snapshot and its concurrent live events.
    await this.settleEvents();
    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0 && failures.length === channels.length) {
      throw new Error(
        `slack conversations.history failed for all channels: ${failures
          .map((f) => `${f.channel}: ${f.failure}`)
          .join("; ")}`,
      );
    }
    for (const failure of failures) {
      this.logger.warn(
        `slack mirror: channel ${failure.channel} re-scan failed; serving nothing for it this ` +
          `poll: ${failure.failure}`,
      );
    }
    const failed = new Set(failures.map((f) => f.channel));
    for (const channel of channels) {
      if (failed.has(channel)) continue;
      const state = this.channels.get(channel);
      if (!state || state.syncedAt === null) continue;
      this.collectScan(channel, state, out);
    }
    return out;
  }

  async listMentions(channels: string[]): Promise<SlackMessage[]> {
    return (await this.scanChannels(channels)).mentions;
  }

  async getThread(
    channel: string,
    ts: string,
    abortSignal?: AbortSignal,
  ): Promise<SlackThreadReply[]> {
    abortSignal?.throwIfAborted();
    await this.settleEvents();
    abortSignal?.throwIfAborted();
    const state = this.channels.get(channel);
    if (state && this.isFresh(channel) && state.authoritativeThreads.has(ts)) {
      const thread = state.threads.get(ts);
      if (thread) {
        return [...thread.values()]
          .sort((a, b) => compareSlackTs(a.ts, b.ts))
          .map((reply) => toThreadReply(reply));
      }
    }
    const fetch = settlePromise(this.inner.getThread(channel, ts, abortSignal));
    await this.enqueueMutation(async () => {
      const result = await fetch;
      if (!result.ok) throw result.error;
      this.storeFetchedThread(channel, ts, result.value);
    });
    // A live event queued while the API read was in flight applies after the fetched snapshot.
    await this.settleEvents();
    const stored = this.channels.get(channel)?.threads.get(ts);
    return stored
      ? [...stored.values()]
          .sort((left, right) => compareSlackTs(left.ts, right.ts))
          .map(toThreadReply)
      : [];
  }

  async getThreadPage(
    channel: string,
    ts: string,
    query: SlackThreadReplyPageQuery,
  ): Promise<SlackThreadReplyPage> {
    query.abortSignal?.throwIfAborted();
    await this.settleEvents();
    query.abortSignal?.throwIfAborted();
    const cursor = parseThreadPageCursor(query.cursor);
    const state = this.channels.get(channel);
    const canReadMirror =
      cursor?.source !== "api" &&
      state !== undefined &&
      this.isFresh(channel) &&
      state.authoritativeThreads.has(ts);
    if (canReadMirror) {
      const afterTs =
        cursor?.source === "mirror" && compareSlackTs(cursor.afterTs, query.afterTs) > 0
          ? cursor.afterTs
          : query.afterTs;
      const replies = [...(state.threads.get(ts)?.values() ?? [])]
        .filter((reply) => compareSlackTs(reply.ts, afterTs) > 0)
        .sort((left, right) => compareSlackTs(left.ts, right.ts));
      const pageReplies = replies.slice(0, query.limit);
      return {
        replies: pageReplies.map((reply) => toThreadReply(reply)),
        ...(pageReplies.length < replies.length
          ? {
              nextCursor: `${MIRROR_THREAD_CURSOR_PREFIX}${pageReplies.at(-1)!.ts}`,
            }
          : {}),
      };
    }
    const delegatedAfterTs =
      cursor?.source === "mirror" && compareSlackTs(cursor.afterTs, query.afterTs) > 0
        ? cursor.afterTs
        : query.afterTs;
    const { cursor: _cursor, ...rest } = query;
    const page = await this.inner.getThreadPage(channel, ts, {
      ...rest,
      afterTs: delegatedAfterTs,
      ...(cursor?.source === "api" ? { cursor: cursor.cursor } : {}),
    });
    return {
      replies: page.replies.map((reply) => this.enrichFetchedReply(channel, ts, reply)),
      ...(page.nextCursor !== undefined
        ? { nextCursor: `${API_THREAD_CURSOR_PREFIX}${page.nextCursor}` }
        : {}),
    };
  }

  // ------------------------------------------------------------------ delegated reads

  async getMessage(channel: string, ts: string): Promise<SlackMessage | null> {
    // Point reads stay authoritative API reads: they back the tool trust boundary
    // (requireTrackedMessage) and the claimed-issue fallback, where staleness is not acceptable.
    const message = await this.inner.getMessage(channel, ts);
    if (message === null || !this.channels.get(channel)?.rootsWithThreadEvents.has(ts)) {
      return message;
    }
    return { ...message, threadEventsObserved: true };
  }

  async teamUrl(): Promise<string | null> {
    return this.inner.teamUrl();
  }

  async getUser(userId: string): Promise<SlackUser | null> {
    return this.inner.getUser(userId);
  }

  async listAround(
    channel: string,
    ts: string,
    window: { before: number; after: number },
  ): Promise<SlackMessage[]> {
    return this.inner.listAround(channel, ts, window);
  }

  // ------------------------------------------------------------------ writes (delegate + self-apply)

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    await this.inner.addReaction(channel, ts, name);
    // The bot's own reactions are state-bearing (marker + mirror), so reflect them immediately
    // rather than waiting for the reaction event to echo back.
    await this.enqueueMutation(() => {
      this.mutateRoot(channel, ts, (root) => {
        if (!root.reactions.includes(name)) root.reactions.push(name);
        if (!root.botReactions.includes(name)) root.botReactions.push(name);
      });
    });
  }

  async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    await this.inner.removeReaction(channel, ts, name);
    await this.enqueueMutation(() => {
      this.mutateRoot(channel, ts, (root) => {
        root.botReactions = root.botReactions.filter((r) => r !== name);
        // Display list keeps the name only if a human also reacted with it; we cannot know from
        // here, so drop it and let the next event/scan restore a human copy.
        root.reactions = root.reactions.filter((r) => r !== name);
      });
    });
  }

  async postReply(
    channel: string,
    threadTs: string,
    body: string,
    options?: SlackPostOptions,
  ): Promise<string> {
    const ts = await this.inner.postReply(channel, threadTs, body, options);
    // Self-apply the bot's own reply so the fold sees it instantly and deterministically - the
    // socket echo of the same ts then upserts a no-op. This matters most for `status:` replies,
    // where the next poll must observe the transition it just caused.
    if (ts !== "") {
      this.applyEvent({
        event: {
          type: "message",
          channel,
          ts,
          thread_ts: threadTs,
          text: body,
          ...(this.botUserId !== undefined ? { user: this.botUserId } : {}),
          ...(options?.metadata !== undefined
            ? {
                metadata: {
                  event_type: options.metadata.eventType,
                  event_payload: options.metadata.payload,
                },
              }
            : {}),
        },
      });
    }
    return ts;
  }

  async updateMessage(
    channel: string,
    ts: string,
    body: string,
    options?: SlackPostOptions,
  ): Promise<void> {
    await this.inner.updateMessage(channel, ts, body, options);
    // The bot's own edits (workpad refreshes) update the mirror text directly; they are display
    // mirrors, never folded commands, so first-seen protection deliberately does not apply.
    await this.enqueueMutation(() => {
      const state = this.channels.get(channel);
      const rootTs = state?.replyIndex.get(ts);
      if (state && rootTs !== undefined) {
        const reply = state.threads.get(rootTs)?.get(ts);
        if (reply) {
          reply.text = body;
          reply.firstSeenText = body;
          if (options?.metadata !== undefined) reply.metadata = options.metadata;
        }
      }
    });
  }

  async postEphemeral(
    channel: string,
    user: string,
    threadTs: string,
    body: string,
  ): Promise<void> {
    return this.inner.postEphemeral(channel, user, threadTs, body);
  }

  async openView(triggerId: string, view: Record<string, unknown>): Promise<string | null> {
    return this.inner.openView(triggerId, view);
  }

  async updateView(viewId: string, view: Record<string, unknown>): Promise<void> {
    return this.inner.updateView(viewId, view);
  }

  // ------------------------------------------------------------------ internals

  /** Reads await pending mirror mutations so a nudge-triggered poll sees its own event. */
  private async settleEvents(): Promise<void> {
    await this.mutationQueue;
  }

  /**
   * Append one mirror mutation while preserving the caller's result. A failed API-backed mutation
   * rejects its caller but is absorbed by the queue tail so later events continue to apply.
   */
  private async enqueueMutation<T>(mutation: () => T | Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(mutation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isFresh(channel: string): boolean {
    if (!this.socketHealthy) return false;
    if (this.botUserId === undefined || this.botUserId.trim() === "") return false;
    const state = this.channels.get(channel);
    if (!state || state.dirty || state.syncedAt === null) return false;
    return this.now() - state.syncedAt < this.reconcileIntervalMs;
  }

  private markDirty(channel: string, reason: string): void {
    const state = this.channels.get(channel);
    if (state && !state.dirty) {
      state.dirty = true;
      this.logger.warn(`slack mirror: channel ${channel} marked dirty (${reason})`);
    }
  }

  private channelState(channel: string): ChannelState {
    let state = this.channels.get(channel);
    if (!state) {
      state = {
        roots: new Map(),
        threads: new Map(),
        authoritativeThreads: new Set(),
        replyIndex: new Map(),
        rootCreateBarriers: new Set(),
        rootsWithThreadEvents: new Set(),
        syncedAt: null,
        dirty: false,
      };
      this.channels.set(channel, state);
    }
    return state;
  }

  /**
   * Rebuild one channel's roots from a real scan. Thread maps survive for roots still present,
   * but every real scan invalidates their authority so the next read can repair edits as well as
   * additions and deletions. Tombstones are dropped during reconciliation, while first-seen text
   * survives for replies the substrate still carries.
   */
  private async rebuildChannel(channel: string): Promise<void> {
    // Start reads concurrently across channels, then install each completed snapshot through the
    // mutation queue. Events received after this call are queued behind the snapshot and replayed
    // onto it, so the snapshot cannot erase them.
    const fetch = settlePromise(this.inner.scanChannels([channel]));
    await this.enqueueMutation(async () => {
      const result = await fetch;
      if (!result.ok) throw result.error;
      this.installChannelSnapshot(channel, result.value);
    });
  }

  private installChannelSnapshot(channel: string, scan: SlackChannelScan): void {
    const state = this.channelState(channel);
    const seen = new Set<string>();
    const previousRoots = state.roots;
    state.roots = new Map();
    for (const message of [...scan.mentions, ...scan.threadedRoots]) {
      seen.add(message.ts);
      this.storeRoot(state, message, true);
      const thread = state.threads.get(message.ts);
      if (thread) {
        for (const [ts, reply] of [...thread]) {
          if (reply.deleted) {
            thread.delete(ts);
            state.replyIndex.delete(ts);
          }
        }
      }
      // Reply counts and latest timestamps cannot reveal edits. A standing repair pass therefore
      // makes the next thread read authoritative even when those scan hints still agree.
      state.authoritativeThreads.delete(message.ts);
    }
    // Roots gone from the scan (deleted, edited away, or aged out of the scan window) drop out
    // of the mirror exactly as they drop out of a real scan; claimed issues still resolve via
    // the per-id fallback (an authoritative getMessage read).
    for (const ts of previousRoots.keys()) {
      if (seen.has(ts)) continue;
      state.threads.delete(ts);
      state.authoritativeThreads.delete(ts);
      for (const [replyTs, rootTs] of [...state.replyIndex]) {
        if (rootTs === ts) state.replyIndex.delete(replyTs);
      }
    }
    state.syncedAt = this.now();
    state.dirty = false;
  }

  private storeRoot(state: ChannelState, message: SlackMessage, authoritative = false): void {
    if (!authoritative && state.rootCreateBarriers.has(message.ts)) return;
    state.roots.set(message.ts, {
      ts: message.ts,
      text: message.text,
      user: message.user,
      reactions: [...message.reactions],
      botReactions: [...message.botReactions],
      replyCountHint: message.replyCount ?? 0,
      latestReplyHint: message.latestReply,
    });
  }

  private collectScan(channel: string, state: ChannelState, out: SlackChannelScan): void {
    for (const root of state.roots.values()) {
      const message = this.toScanMessage(channel, state, root);
      if (
        isBotMention(root.text, this.botUserId) &&
        isAllowedAuthor(root.user, this.allowedUsers)
      ) {
        out.mentions.push(message);
      } else if ((message.replyCount ?? 0) > 0) {
        out.threadedRoots.push(message);
      }
    }
  }

  private toScanMessage(channel: string, state: ChannelState, root: MirrorRoot): SlackMessage {
    const thread = state.authoritativeThreads.has(root.ts) ? state.threads.get(root.ts) : undefined;
    // Tombstones count: reply_count staying stable is what keeps the thread-state cache key
    // (and therefore the fold) stable for a deletion the mirror is deliberately riding out.
    const replyCount = thread ? thread.size : root.replyCountHint;
    const latestReply = thread ? latestTsOf(thread) : root.latestReplyHint;
    return {
      channel,
      ts: root.ts,
      text: root.text,
      reactions: [...root.reactions],
      botReactions: [...root.botReactions],
      ...(root.user !== undefined ? { user: root.user } : {}),
      ...(replyCount > 0 ? { replyCount } : {}),
      ...(latestReply !== undefined ? { latestReply } : {}),
      ...(state.rootsWithThreadEvents.has(root.ts) ? { threadEventsObserved: true } : {}),
    };
  }

  private storeFetchedThread(channel: string, rootTs: string, replies: SlackThreadReply[]): void {
    const state = this.channelState(channel);
    const previous = state.threads.get(rootTs);
    const thread = new Map<string, MirrorReply>();
    for (const reply of replies) {
      const existing = previous?.get(reply.ts);
      thread.set(reply.ts, {
        ts: reply.ts,
        text: reply.text,
        subtype: reply.subtype,
        isBot: reply.isBot,
        edited: reply.edited === true,
        // A re-fetch cannot recover pre-edit text; preserve the first observation when we have
        // one so the in-session first-seen guarantee survives the re-fetch.
        firstSeenText: existing?.firstSeenText ?? reply.text,
        user: reply.user,
        metadata: reply.metadata,
        deleted: false,
      });
      state.replyIndex.set(reply.ts, rootTs);
    }
    for (const ts of previous?.keys() ?? []) {
      if (!thread.has(ts)) state.replyIndex.delete(ts);
    }
    state.threads.set(rootTs, thread);
    // Only a synced channel can keep a thread current afterwards (events feed the same state).
    if (state.syncedAt !== null) state.authoritativeThreads.add(rootTs);
    const root = state.roots.get(rootTs);
    if (root) {
      root.replyCountHint = thread.size;
      root.latestReplyHint = latestTsOf(thread);
    }
    this.rememberThreadEvents(channel, rootTs);
  }

  private rememberThreadEvents(channel: string, rootTs: string): void {
    const state = this.channels.get(channel);
    const root = state?.roots.get(rootTs);
    const thread = state?.threads.get(rootTs);
    if (!state || !root || !thread || state.rootsWithThreadEvents.has(rootTs)) return;
    const replies = [...thread.values()]
      .sort((left, right) => compareSlackTs(left.ts, right.ts))
      .map(toThreadReply);
    const message: SlackMessage = {
      channel,
      ts: root.ts,
      text: root.text,
      reactions: [...root.reactions],
      botReactions: [...root.botReactions],
      ...(root.user !== undefined ? { user: root.user } : {}),
    };
    if (stateFromThread(message, replies, this.settings).events.length > 0) {
      state.rootsWithThreadEvents.add(rootTs);
    }
  }

  /** Overlay mirror-only fields (first-seen text) onto an API-served reply. */
  private enrichFetchedReply(
    channel: string,
    rootTs: string,
    reply: SlackThreadReply,
  ): SlackThreadReply {
    const stored = this.channels.get(channel)?.threads.get(rootTs)?.get(reply.ts);
    if (!stored) return reply;
    return {
      ...reply,
      ...(stored.firstSeenText !== reply.text ? { firstSeenText: stored.firstSeenText } : {}),
      ...(stored.edited ? { edited: true } : {}),
      ...(stored.deleted ? { deleted: true } : {}),
    };
  }

  private mutateRoot(channel: string, ts: string, mutate: (root: MirrorRoot) => void): void {
    const root = this.channels.get(channel)?.roots.get(ts);
    if (root) mutate(root);
  }

  private async applyEventNow(payload: Record<string, unknown>): Promise<void> {
    const event = payload.event;
    if (!isRecord(event)) return;
    const type = event.type;
    if (type === "reaction_added" || type === "reaction_removed") {
      this.applyReaction(event, type === "reaction_added");
      return;
    }
    if (type !== "message" && type !== "app_mention") return;
    const channel = typeof event.channel === "string" ? event.channel : null;
    if (channel === null) return;
    const subtype = typeof event.subtype === "string" ? event.subtype : undefined;
    if (subtype === "message_changed") {
      await this.applyEdit(channel, event);
      return;
    }
    if (subtype === "message_deleted") {
      this.applyDelete(channel, event);
      return;
    }
    // Everything else message-shaped (plain messages, app_mention, thread_broadcast,
    // file_share, bot_message) upserts; system subtypes (channel_join, ...) carry no ts/text
    // relevant to tracking and fall through the shape checks below harmlessly.
    if (
      subtype !== undefined &&
      subtype !== "thread_broadcast" &&
      subtype !== "file_share" &&
      subtype !== "bot_message"
    ) {
      return;
    }
    const ts = typeof event.ts === "string" ? event.ts : null;
    if (ts === null) return;
    const text = typeof event.text === "string" ? event.text : "";
    const user = typeof event.user === "string" ? event.user : undefined;
    const metadata = toMessageMetadata(isRecord(event.metadata) ? event.metadata : undefined);
    const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : undefined;
    if (threadTs !== undefined && threadTs !== ts) {
      await this.applyReplyUpsert(channel, threadTs, {
        ts,
        text,
        user,
        metadata,
        subtype,
        isBot:
          typeof event.bot_id === "string" ||
          subtype === "bot_message" ||
          (user !== undefined && user === this.botUserId),
      });
    } else {
      this.applyRootUpsert(channel, { ts, text, user });
    }
  }

  private applyRootUpsert(
    channel: string,
    message: { ts: string; text: string; user?: string | undefined },
  ): void {
    const state = this.channelState(channel);
    if (state.rootCreateBarriers.has(message.ts)) return;
    const existing = state.roots.get(message.ts);
    if (existing) {
      // Root text changes arrive as `message_changed`. A plain message/app_mention event for an
      // existing timestamp is a duplicate create and must not overwrite a later edit.
      if (message.user !== undefined) existing.user = message.user;
      return;
    }
    state.roots.set(message.ts, {
      ts: message.ts,
      text: message.text,
      user: message.user,
      reactions: [],
      botReactions: [],
      replyCountHint: 0,
    });
  }

  private async applyReplyUpsert(
    channel: string,
    rootTs: string,
    reply: {
      ts: string;
      text: string;
      user?: string | undefined;
      metadata?: SlackMessageMetadata | undefined;
      subtype?: string | undefined;
      isBot?: boolean | undefined;
    },
  ): Promise<void> {
    const state = this.channelState(channel);
    if (!state.roots.has(rootTs)) {
      const couldTrackRoot =
        reply.user === this.botUserId ||
        (reply.user !== undefined &&
          isAllowedAuthor(reply.user, this.allowedUsers) &&
          isBotMention(reply.text, this.botUserId));
      if (!couldTrackRoot) return;
      // A reply into a thread whose root the mirror does not carry (older than the scan window,
      // or a plain message receiving its first relevant reply) needs one authoritative point
      // read. Ordinary unknown-thread traffic is ignored above so it cannot block the serialized
      // event queue behind a rate-limited history call.
      const root = await this.inner.getMessage(channel, rootTs);
      if (root === null) {
        this.markDirty(channel, `reply ${reply.ts} references unknown root ${rootTs}`);
        return;
      }
      state.roots.set(rootTs, {
        ts: root.ts,
        text: root.text,
        user: root.user,
        reactions: [...root.reactions],
        botReactions: [...root.botReactions],
        replyCountHint: root.replyCount ?? 0,
        latestReplyHint: root.latestReply,
      });
    }
    let thread = state.threads.get(rootTs);
    if (!thread) {
      thread = new Map();
      state.threads.set(rootTs, thread);
      // A brand-new thread built purely from events is complete by construction - but only when
      // the root really had no earlier replies to miss.
      const root = state.roots.get(rootTs);
      if ((root?.replyCountHint ?? 0) === 0 && state.syncedAt !== null) {
        state.authoritativeThreads.add(rootTs);
      }
    }
    const existing = thread.get(reply.ts);
    if (existing) {
      // Duplicate delivery (app_mention + message, redelivered envelope): first one won.
      if (existing.metadata === undefined && reply.metadata !== undefined) {
        existing.metadata = reply.metadata;
        this.rememberThreadEvents(channel, rootTs);
      }
      return;
    }
    thread.set(reply.ts, {
      ts: reply.ts,
      text: reply.text,
      subtype: reply.subtype,
      isBot: reply.isBot,
      edited: false,
      firstSeenText: reply.text,
      user: reply.user,
      metadata: reply.metadata,
      deleted: false,
    });
    state.replyIndex.set(reply.ts, rootTs);
    const root = state.roots.get(rootTs);
    if (root) {
      root.replyCountHint = Math.max(root.replyCountHint + 1, thread.size);
      const latest = latestTsOf(thread);
      if (
        root.latestReplyHint === undefined ||
        (latest !== undefined && compareSlackTs(latest, root.latestReplyHint) > 0)
      ) {
        root.latestReplyHint = latest;
      }
    }
    this.rememberThreadEvents(channel, rootTs);
  }

  private async applyEdit(channel: string, event: Record<string, unknown>): Promise<void> {
    const edited = event.message;
    if (!isRecord(edited) || typeof edited.ts !== "string") return;
    const ts = edited.ts;
    const newText = typeof edited.text === "string" ? edited.text : "";
    const state = this.channelState(channel);
    const root = state.roots.get(ts);
    if (root) {
      // Root edits track current text: an edit that removes the mention untracks the issue at
      // the next fold, exactly as a re-scan would observe it (the documented contract).
      rememberBounded(state.rootCreateBarriers, ts, ROOT_CREATE_BARRIERS_MAX);
      root.text = newText;
      return;
    }
    const rootTs = state.replyIndex.get(ts);
    if (rootTs === undefined) {
      const threadTs = typeof edited.thread_ts === "string" ? edited.thread_ts : undefined;
      if (threadTs !== undefined && threadTs !== ts) {
        // The original reply event was not observed, so current text cannot establish first-seen
        // command semantics. Reconcile the channel instead of guessing.
        this.markDirty(channel, `edit ${ts} references an unknown reply in ${threadTs}`);
        return;
      }
      // A root outside the scan may become an issue when edited to mention the bot. Fetch its
      // authoritative shape and add it to the mirror before the event-triggered poll collects.
      const message = await this.inner.getMessage(channel, ts);
      if (message !== null) {
        this.storeRoot(state, message, true);
        rememberBounded(state.rootCreateBarriers, ts, ROOT_CREATE_BARRIERS_MAX);
      }
      return;
    }
    const reply = state.threads.get(rootTs)?.get(ts);
    if (!reply) return;
    const previous = reply.text;
    reply.text = newText;
    reply.edited = true;
    const metadata = toMessageMetadata(isRecord(edited.metadata) ? edited.metadata : undefined);
    if (metadata !== undefined) reply.metadata = metadata;
    if (reply.firstSeenText === newText || previous === newText) return;
    // First-seen wins for command classification; when the edit would have changed a command
    // (either rewriting one or smuggling one in), tell the thread it was ignored - once.
    const wasCommand = parseStatusCommand(reply.firstSeenText, this.botUserId, this.settings);
    const nowCommand = parseStatusCommand(newText, this.botUserId, this.settings);
    const commandBearing = wasCommand !== null || nowCommand !== null;
    if (!commandBearing || this.editNoticed.has(ts)) return;
    this.editNoticed.add(ts);
    this.logger.warn(
      `slack mirror: edited status command in ${channel}:${rootTs} (reply ${ts}) ignored; ` +
        "commands are first-seen - post a new command to change status",
    );
    void this.inner
      .postReply(
        channel,
        rootTs,
        "note: an edited `!` command was ignored - status commands are read as first posted. " +
          "Post a new command (e.g. `@bot !status <Name>`) to change status.",
      )
      .catch(() => {
        // The notice is best-effort; the log line above already records the decision.
      });
  }

  private applyDelete(channel: string, event: Record<string, unknown>): void {
    const deletedTs =
      typeof event.deleted_ts === "string"
        ? event.deleted_ts
        : isRecord(event.previous_message) && typeof event.previous_message.ts === "string"
          ? event.previous_message.ts
          : null;
    if (deletedTs === null) return;
    const state = this.channelState(channel);
    const previousMessage = isRecord(event.previous_message) ? event.previous_message : null;
    const previousThreadTs =
      previousMessage !== null && typeof previousMessage.thread_ts === "string"
        ? previousMessage.thread_ts
        : undefined;
    const knownReplyRoot = state.replyIndex.get(deletedTs);
    const rootDelete =
      state.roots.has(deletedTs) ||
      (knownReplyRoot === undefined &&
        (previousThreadTs === undefined || previousThreadTs === deletedTs));
    if (rootDelete) {
      // A deleted root is a deleted issue: it disappears exactly as it would from a re-scan,
      // and its mutation barrier rejects delayed duplicate create events. The runtime reconciles the
      // claim through the per-id fallback (getMessage -> null).
      rememberBounded(state.rootCreateBarriers, deletedTs, ROOT_CREATE_BARRIERS_MAX);
      state.roots.delete(deletedTs);
      state.threads.delete(deletedTs);
      state.authoritativeThreads.delete(deletedTs);
      for (const [replyTs, rootTs] of [...state.replyIndex]) {
        if (rootTs === deletedTs) state.replyIndex.delete(replyTs);
      }
      return;
    }
    const rootTs = knownReplyRoot;
    if (rootTs === undefined) return;
    const reply = state.threads.get(rootTs)?.get(deletedTs);
    if (!reply || reply.deleted) return;
    // Tombstone: the reply keeps its folded role until the next real scan, so deleting a
    // `!done` cannot silently re-open (or a `status:` reply silently regress) an issue mid-run.
    reply.deleted = true;
    this.logger.warn(
      `slack mirror: reply ${deletedTs} in ${channel}:${rootTs} was deleted; keeping its folded ` +
        "role until the next reconciliation scan",
    );
  }

  private applyReaction(event: Record<string, unknown>, added: boolean): void {
    const item = event.item;
    if (!isRecord(item) || typeof item.channel === "undefined") return;
    const channel = typeof item.channel === "string" ? item.channel : null;
    const ts = typeof item.ts === "string" ? item.ts : null;
    const name = typeof event.reaction === "string" ? event.reaction : null;
    const user = typeof event.user === "string" ? event.user : null;
    if (channel === null || ts === null || name === null) return;
    const state = this.channels.get(channel);
    const root = state?.roots.get(ts);
    if (!root) return; // reactions on replies/unknown messages carry no tracked state.
    if (added) {
      if (!root.reactions.includes(name)) root.reactions.push(name);
      if (user !== null && user === this.botUserId && !root.botReactions.includes(name)) {
        root.botReactions.push(name);
      }
    } else {
      if (user !== null && user === this.botUserId) {
        root.botReactions = root.botReactions.filter((r) => r !== name);
      }
      // Without per-user bookkeeping we cannot know whether ANOTHER author still holds this
      // reaction; drop it from the display list and let the next event/scan restore it.
      if (user === null || user === this.botUserId || !root.botReactions.includes(name)) {
        root.reactions = root.reactions.filter((r) => r !== name);
      }
    }
  }
}

function toThreadReply(reply: MirrorReply): SlackThreadReply {
  const out: SlackThreadReply = { ts: reply.ts, text: reply.text };
  if (reply.user !== undefined) out.user = reply.user;
  if (reply.subtype !== undefined) out.subtype = reply.subtype;
  if (reply.isBot !== undefined) out.isBot = reply.isBot;
  if (reply.edited) out.edited = true;
  if (reply.metadata !== undefined) out.metadata = reply.metadata;
  if (reply.firstSeenText !== reply.text) out.firstSeenText = reply.firstSeenText;
  if (reply.deleted) out.deleted = true;
  return out;
}

function latestTsOf(thread: Map<string, MirrorReply>): string | undefined {
  let latest: string | undefined;
  for (const reply of thread.values()) {
    if (latest === undefined || compareSlackTs(reply.ts, latest) > 0) latest = reply.ts;
  }
  return latest;
}

function rememberBounded(values: Set<string>, value: string, max: number): void {
  if (values.has(value)) return;
  while (values.size >= max) {
    const oldest = values.values().next().value;
    if (oldest === undefined) break;
    values.delete(oldest);
  }
  values.add(value);
}

function parseThreadPageCursor(
  cursor: string | undefined,
): { source: "mirror"; afterTs: string } | { source: "api"; cursor: string } | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.startsWith(MIRROR_THREAD_CURSOR_PREFIX)) {
    const afterTs = cursor.slice(MIRROR_THREAD_CURSOR_PREFIX.length);
    if (isSlackTs(afterTs)) return { source: "mirror", afterTs };
  }
  if (cursor.startsWith(API_THREAD_CURSOR_PREFIX)) {
    const apiCursor = cursor.slice(API_THREAD_CURSOR_PREFIX.length);
    if (apiCursor !== "") return { source: "api", cursor: apiCursor };
  }
  throw new Error(`invalid Slack thread page cursor: ${cursor}`);
}

/**
 * Observe an in-flight API read immediately while carrying its rejection into the mutation queue.
 * This keeps concurrent reads from producing an unhandled rejection while another queued
 * snapshot is still installing.
 */
async function settlePromise<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

/** Channel of an events_api payload, for scoping failure fallout. */
function eventChannel(payload: Record<string, unknown>): string | null {
  const event = payload.event;
  if (!isRecord(event)) return null;
  if (typeof event.channel === "string") return event.channel;
  const item = event.item;
  if (isRecord(item) && typeof item.channel === "string") return item.channel;
  return null;
}
