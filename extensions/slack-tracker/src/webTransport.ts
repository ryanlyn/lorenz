import { errorMessage, isRecord, type Settings } from "@lorenz/domain";

import { isAllowedAuthor, isBotMention } from "./mapping.js";
import { slackEndpoint, slackTrackerOptions } from "./options.js";
import { stripBroadcastMentions } from "./sanitize.js";
import type {
  SlackChannelScan,
  SlackMessage,
  SlackMessageMetadata,
  SlackPostOptions,
  SlackThreadReply,
  SlackTransport,
  SlackUser,
} from "./transport.js";

interface RawSlackMessage {
  ts?: string;
  text?: string;
  user?: string;
  reply_count?: number;
  latest_reply?: string;
  reactions?: Array<{ name?: string; users?: string[] }>;
  metadata?: { event_type?: string; event_payload?: unknown };
}

// Generous safety cap on conversations.history pages. The normal terminal condition is Slack
// returning no next_cursor (full history exhausted). This cap only exists to bound a pathological
// non-terminating cursor; reaching it while a cursor is STILL present is an anomaly we surface as a
// loud truncation warning rather than silently dropping older mentions. At limit=200 this covers
// ~100k messages per channel per poll.
const MAX_HISTORY_PAGES = 500;
const MAX_RETRIES = 4;
const SECONDS_PER_DAY = 86_400;
/**
 * Upper bound on a single retry sleep, including Retry-After-driven ones. Slack's real
 * Retry-After values are short; an unbounded header (or a far-future HTTP-date injected by an
 * intermediary) must not park the poll loop or an agent tool call on an un-abortable timer.
 */
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Workspace base URLs (auth.test `url`) keyed by endpoint+token and shared across transport
 * instances: the tool packs construct a fresh transport per call, and the workspace URL never
 * changes over a token's lifetime.
 */
const teamUrlByAuth = new Map<string, string | null>();

type Sleep = (delayMs: number) => Promise<void>;

const defaultSleep: Sleep = async (delayMs) =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

/** Minimal logging surface so a skipped (unreadable) channel is surfaced (default: console.warn). */
export interface SlackTrackerLogger {
  warn(message: string): void;
}

/** Optional knobs for tests; production callers use the generous defaults. */
export interface SlackWebTransportOptions {
  /** Safety cap on conversations.history pages per channel per poll (default: MAX_HISTORY_PAGES). */
  maxHistoryPages?: number;
  /**
   * Trailing history window (days) for the candidate scan; overrides the configured
   * `scanLookbackDays`. Omitted, `0`, or negative disables the `oldest` bound entirely
   * (full history).
   */
  scanLookbackDays?: number;
  /** Wall-clock source for the trailing `oldest` watermark (default `Date.now`); injectable for tests. */
  now?: () => number;
}

export class SlackWebTransport implements SlackTransport {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly botUserId: string | undefined;
  private readonly allowedUsers: string[];
  private readonly maxHistoryPages: number;
  private readonly scanLookbackDays: number;
  private readonly now: () => number;
  private warnedNoBotUserId = false;

  constructor(
    settings: Settings,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: Sleep = defaultSleep,
    private readonly logger: SlackTrackerLogger = { warn: (message) => console.warn(message) },
    options: SlackWebTransportOptions = {},
  ) {
    this.endpoint = slackEndpoint(settings);
    this.token = settings.tracker.apiKey ?? "";
    const slackOptions = slackTrackerOptions(settings);
    this.botUserId = slackOptions.botUserId;
    this.allowedUsers = slackOptions.users;
    this.maxHistoryPages = options.maxHistoryPages ?? MAX_HISTORY_PAGES;
    this.scanLookbackDays = options.scanLookbackDays ?? slackOptions.scanLookbackDays ?? 0;
    this.now = options.now ?? Date.now;
  }

  /**
   * The `oldest` epoch-seconds watermark for this poll's candidate scan, or `undefined` to leave
   * the scan unbounded. Recomputed per call: a FIXED trailing window (now - scanLookbackDays), not
   * an advancing persisted cursor, so every issue with activity inside the window keeps
   * re-surfacing each poll.
   */
  private historyOldest(): string | undefined {
    if (!(this.scanLookbackDays > 0)) return undefined;
    return String(Math.floor(this.now() / 1000 - this.scanLookbackDays * SECONDS_PER_DAY));
  }

  async listMentions(channels: string[]): Promise<SlackMessage[]> {
    return (await this.scanChannels(channels)).mentions;
  }

  async scanChannels(channels: string[]): Promise<SlackChannelScan> {
    // A positive scanLookbackDays is a fixed trailing window, not an advancing cursor; each poll
    // still re-scans the window so undispatched active issues inside it keep re-surfacing.
    const oldest = this.historyOldest();
    //
    // Fail closed: with no bot user id configured, the any-mention fallback would treat every
    // human-to-human <@U...> mention in a watched channel as an issue and expose that text to
    // workers. The production transport must never do that, so match nothing and warn once.
    if (!this.botUserId || this.botUserId.trim() === "") {
      if (!this.warnedNoBotUserId) {
        this.warnedNoBotUserId = true;
        this.logger.warn(
          "slack tracker: bot_user_id (SLACK_BOT_USER_ID) is not set; refusing to scan mentions " +
            "(fail closed). Set tracker.bot_user_id so only the bot's own mentions create issues.",
        );
      }
      return { mentions: [], threadedRoots: [] };
    }
    // Channels are scanned CONCURRENTLY: Slack rate-limits conversations.history per channel,
    // and the per-channel isolation below makes the scans independent, so poll wall-time is the
    // slowest single channel rather than the sum of every channel's pagination and backoff.
    const results = await Promise.all(
      channels.map(async (channel) => {
        // Isolate per-channel failures: a single unreadable channel (e.g. not_in_channel,
        // missing_scope, or a persistent 429) must not blind candidate discovery across the
        // other channels. Skip-and-log the bad channel and keep the rest.
        //
        // Crucially, a channel's results are buffered and only merged once that channel's scan
        // COMPLETES (Slack exhausts its history, or we hit the page-cap truncation bound which is
        // loudly surfaced in the scan). If pagination fails partway through, the partial buffer
        // is DISCARDED: a partial scan must never masquerade as a complete one, because every
        // mention beyond the failed page would otherwise vanish silently from candidate discovery
        // and terminal cleanup.
        try {
          return { channel, scan: await this.scanChannel(channel, oldest) };
        } catch (error) {
          // A page failed after the transport's own retries: treat the whole channel as failed
          // and discard its partial buffer. One bad channel must not abort the others.
          const message = errorMessage(error);
          this.logger.warn(
            `slack tracker: channel ${channel} scan failed before completing; discarding its ` +
              `partial results this poll: ${message}`,
          );
          return { channel, failure: message };
        }
      }),
    );
    const out: SlackChannelScan = { mentions: [], threadedRoots: [] };
    const failures: string[] = [];
    for (const result of results) {
      if ("scan" in result) {
        out.mentions.push(...result.scan.mentions);
        out.threadedRoots.push(...result.scan.threadedRoots);
      } else {
        failures.push(`${result.channel}: ${result.failure}`);
      }
    }
    // If there were channels to scan but NONE completed, surface the failure (preserving the
    // reject contract the runtime relies on for poll_error) rather than silently reporting a
    // healthy-looking partial/empty result.
    if (failures.length > 0 && failures.length === channels.length) {
      throw new Error(
        `slack conversations.history failed for all channels: ${failures.join("; ")}`,
      );
    }
    return out;
  }

  /**
   * Scan one channel's recent root-message history (bounded by the trailing `oldest` watermark
   * when set); throws when pagination fails partway.
   */
  private async scanChannel(channel: string, oldest?: string): Promise<SlackChannelScan> {
    const buffer: SlackChannelScan = { mentions: [], threadedRoots: [] };
    let cursor: string | undefined;
    // Page until Slack stops returning a next_cursor (full exhaustion of the window) - the normal
    // terminal condition. The page count only guards against a pathological non-terminating cursor.
    for (let page = 0; page < this.maxHistoryPages; page += 1) {
      const params: Record<string, string> = { channel, limit: "200" };
      // Bound the scan to the trailing window: Slack only returns messages at or after `oldest`,
      // so a channel's ancient backlog is not re-paged every poll.
      if (oldest !== undefined) params.oldest = oldest;
      if (cursor) params.cursor = cursor;
      const body = await this.get("conversations.history", params);
      const messages = Array.isArray(body.messages) ? (body.messages as RawSlackMessage[]) : [];
      for (const m of messages) {
        if (typeof m.ts !== "string") continue;
        if (
          isBotMention(m.text ?? "", this.botUserId) &&
          isAllowedAuthor(m.user, this.allowedUsers)
        ) {
          buffer.mentions.push(toMessage(channel, m, this.botUserId));
        } else if ((m.reply_count ?? 0) > 0) {
          // Non-mention roots (and root mentions from a non-allowed author) that carry a thread:
          // candidates for reply-mention tracking. A reply from an allowed user mentioning the bot
          // can still make the thread an issue; resolveThreadState applies the same author gate.
          buffer.threadedRoots.push(toMessage(channel, m, this.botUserId));
        }
      }
      cursor = nextCursor(body);
      if (!cursor) break;
    }
    // Hitting the safety cap with a cursor STILL present means we stopped before exhausting the
    // channel's history. Older bot mentions beyond this point are silently invisible to candidate
    // discovery and terminal cleanup, so make the truncation loud rather than dropping them
    // quietly. Truncation is an intentional, surfaced bound, so the scan still counts as
    // complete-enough: we keep the buffer collected up to the cap.
    if (cursor) {
      this.logger.warn(
        `slack tracker: channel ${channel} history scan hit the ${this.maxHistoryPages}-page ` +
          "safety cap with more pages remaining; truncating scan. Older bot mentions in this " +
          "channel may be missed this poll.",
      );
    }
    return buffer;
  }

  async teamUrl(): Promise<string | null> {
    const cacheKey = `${this.endpoint} ${this.token}`;
    const cached = teamUrlByAuth.get(cacheKey);
    if (cached !== undefined) return cached;
    try {
      const body = await this.get("auth.test", {});
      const url =
        typeof body.url === "string" && body.url !== "" ? body.url.replace(/\/+$/, "") : null;
      teamUrlByAuth.set(cacheKey, url);
      return url;
    } catch {
      // Permalinks are decoration: never let a transient auth.test failure break a read path,
      // and don't cache the failure so a later call can succeed.
      return null;
    }
  }

  async getMessage(channel: string, ts: string): Promise<SlackMessage | null> {
    const body = await this.get("conversations.history", {
      channel,
      latest: ts,
      inclusive: "true",
      limit: "1",
    });
    const messages = Array.isArray(body.messages) ? (body.messages as RawSlackMessage[]) : [];
    const found = messages.find((m) => m.ts === ts);
    return found ? toMessage(channel, found, this.botUserId) : null;
  }

  async getUser(userId: string): Promise<SlackUser | null> {
    let body: Record<string, unknown>;
    try {
      body = await this.get("users.info", { user: userId });
    } catch {
      // An unknown or unreadable user resolves to null rather than failing the caller's read.
      return null;
    }
    const user = body.user;
    if (!isRecord(user) || typeof user.id !== "string") return null;
    const profile = isRecord(user.profile) ? user.profile : {};
    return {
      id: user.id,
      ...(typeof user.name === "string" ? { name: user.name } : {}),
      ...(typeof user.real_name === "string" ? { realName: user.real_name } : {}),
      ...(typeof profile.display_name === "string" && profile.display_name !== ""
        ? { displayName: profile.display_name }
        : {}),
      ...(typeof user.is_bot === "boolean" ? { isBot: user.is_bot } : {}),
    };
  }

  async listAround(
    channel: string,
    ts: string,
    window: { before: number; after: number },
  ): Promise<SlackMessage[]> {
    // Two bounded history reads around the anchor: at-or-before it (latest+inclusive walks
    // backwards from the anchor) and strictly after it (oldest exclusive). Both are pure reads.
    const [beforeBody, afterBody] = await Promise.all([
      window.before > 0
        ? this.get("conversations.history", {
            channel,
            latest: ts,
            inclusive: "true",
            limit: String(window.before),
          })
        : Promise.resolve<Record<string, unknown>>({}),
      window.after > 0
        ? this.get("conversations.history", {
            channel,
            oldest: ts,
            inclusive: "false",
            limit: String(window.after),
          })
        : Promise.resolve<Record<string, unknown>>({}),
    ]);
    const collect = (body: Record<string, unknown>): SlackMessage[] =>
      (Array.isArray(body.messages) ? (body.messages as RawSlackMessage[]) : [])
        .filter((m) => typeof m.ts === "string")
        .map((m) => toMessage(channel, m, this.botUserId));
    const merged = new Map<string, SlackMessage>();
    for (const message of [...collect(beforeBody), ...collect(afterBody)]) {
      merged.set(message.ts, message);
    }
    return [...merged.values()].sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
  }

  async getThread(channel: string, ts: string): Promise<SlackThreadReply[]> {
    // conversations.replies returns the parent (root) message FIRST followed by its replies. Page
    // through next_cursor like listMentions (a pure read, safe to retry on 429/5xx) and drop the
    // parent (the message whose ts === the thread ts) so only the replies are returned.
    // include_all_metadata carries back the bot's own message metadata, which the fold prefers
    // over parsing reply text and which send reconciliation matches markers against.
    const out: SlackThreadReply[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.maxHistoryPages; page += 1) {
      const params: Record<string, string> = {
        channel,
        ts,
        limit: "200",
        include_all_metadata: "true",
      };
      if (cursor) params.cursor = cursor;
      const body = await this.get("conversations.replies", params);
      const messages = Array.isArray(body.messages) ? (body.messages as RawSlackMessage[]) : [];
      for (const m of messages) {
        if (typeof m.ts !== "string") continue;
        if (m.ts === ts) continue;
        out.push(toThreadReply(m));
      }
      cursor = nextCursor(body);
      if (!cursor) break;
    }
    // Same loud-truncation contract as the history scan: a silently partial thread would let a
    // continuation agent recover incomplete progress notes with no signal anything was dropped.
    if (cursor) {
      this.logger.warn(
        `slack tracker: thread ${channel}:${ts} hit the ${this.maxHistoryPages}-page safety cap ` +
          "with more replies remaining; returning a truncated thread.",
      );
    }
    return out;
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    // reactions.add is idempotent: re-applying an already-present reaction is harmless (Slack
    // returns already_reacted, which parse() treats as success), so retrying on an ambiguous 5xx
    // cannot corrupt state.
    await this.post("reactions.add", { channel, timestamp: ts, name }, { idempotent: true });
  }

  async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    // reactions.remove is idempotent: removing an already-absent reaction is harmless (Slack
    // returns no_reaction, which parse() treats as success), so retrying on a 5xx is safe.
    await this.post("reactions.remove", { channel, timestamp: ts, name }, { idempotent: true });
  }

  async postReply(
    channel: string,
    threadTs: string,
    body: string,
    options: SlackPostOptions = {},
  ): Promise<string> {
    // chat.postMessage is NOT idempotent: a blind retry posts a DUPLICATE reply. It may retry
    // internally only on a 429 (rejected before processing). An AMBIGUOUS outcome - a 5xx or a
    // network/timeout failure after the request was sent, where the reply may or may not have
    // been delivered - is resolved by metadata reconciliation when the post carries a unique
    // marker (`metadata.payload.seq`): scan the thread for the marker; found means the original
    // send landed (return its real ts), not found proves it did not (a retry cannot duplicate).
    // Without a marker the historical contract stands: ambiguous outcomes fail loudly.
    const params: Record<string, unknown> = {
      channel,
      thread_ts: threadTs,
      text: stripBroadcastMentions(body),
    };
    if (options.blocks !== undefined) params.blocks = options.blocks;
    if (options.metadata !== undefined) {
      params.metadata = {
        event_type: options.metadata.eventType,
        event_payload: options.metadata.payload,
      };
    }
    const marker = reconcilableMarker(options.metadata);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.post("chat.postMessage", params, { idempotent: false });
        return typeof response.ts === "string" ? response.ts : "";
      } catch (error) {
        if (marker === null || !(error instanceof SlackAmbiguousDeliveryError) || attempt >= 2) {
          throw error;
        }
        this.logger.warn(
          `slack chat.postMessage outcome unknown (${errorMessage(error)}); reconciling by ` +
            `metadata marker before retrying`,
        );
        const deliveredTs = await this.findReplyByMarker(channel, threadTs, marker);
        if (deliveredTs !== null) return deliveredTs;
        // Marker absent from the thread: the ambiguous send provably did not land, so a retry
        // cannot duplicate it. Loop and post again.
      }
    }
  }

  /**
   * Scan the thread for a bot reply carrying the given metadata marker; the marker's `seq` is
   * unique per logical post, so at most one reply matches. Read failures resolve to "not found"
   * conservatively - the caller then retries the post, and a duplicate is impossible because a
   * A read failure propagates instead of being treated as "not found": absence is proof that a
   * retry is safe only after an authoritative thread read succeeds.
   */
  private async findReplyByMarker(
    channel: string,
    threadTs: string,
    marker: { eventType: string; seq: string },
  ): Promise<string | null> {
    const replies = await this.getThread(channel, threadTs);
    for (const reply of replies) {
      if (
        reply.metadata?.eventType === marker.eventType &&
        reply.metadata.payload.seq === marker.seq
      ) {
        return reply.ts;
      }
    }
    return null;
  }

  async updateMessage(
    channel: string,
    ts: string,
    body: string,
    options: SlackPostOptions = {},
  ): Promise<void> {
    // chat.update converges to the same content on repeat, so retrying an ambiguous outcome is
    // safe (idempotent in effect, unlike chat.postMessage).
    const params: Record<string, unknown> = { channel, ts, text: stripBroadcastMentions(body) };
    if (options.blocks !== undefined) params.blocks = options.blocks;
    if (options.metadata !== undefined) {
      params.metadata = {
        event_type: options.metadata.eventType,
        event_payload: options.metadata.payload,
      };
    }
    await this.post("chat.update", params, { idempotent: true });
  }

  async postEphemeral(
    channel: string,
    user: string,
    threadTs: string,
    body: string,
  ): Promise<void> {
    // Ephemeral notices are best-effort accents (callers swallow failures); like any
    // non-idempotent post, retry only the pre-processing 429 rejection.
    await this.post(
      "chat.postEphemeral",
      { channel, user, thread_ts: threadTs, text: stripBroadcastMentions(body) },
      { idempotent: false },
    );
  }

  async openView(triggerId: string, view: Record<string, unknown>): Promise<string | null> {
    // trigger_ids expire in ~3 seconds, so there is no meaningful retry budget beyond the
    // internal 429 handling; a failure surfaces to the interaction handler, which logs it.
    const response = await this.post(
      "views.open",
      { trigger_id: triggerId, view },
      { idempotent: false },
    );
    return isRecord(response.view) && typeof response.view.id === "string"
      ? response.view.id
      : null;
  }

  async updateView(viewId: string, view: Record<string, unknown>): Promise<void> {
    await this.post("views.update", { view_id: viewId, view }, { idempotent: true });
  }

  private async get(
    method: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const url = `${this.endpoint}/${method}?${new URLSearchParams(params).toString()}`;
    // GET (conversations.history) is a pure read: safe to retry on both 429 and 5xx.
    const response = await this.fetchWithRetry(
      method,
      async () =>
        this.fetchImpl(url, {
          method: "GET",
          headers: { authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(30_000),
        }),
      { idempotent: true },
    );
    return this.parse(method, response);
  }

  private async post(
    method: string,
    params: Record<string, unknown>,
    options: { idempotent: boolean },
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchWithRetry(
      method,
      async () =>
        this.fetchImpl(`${this.endpoint}/${method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(30_000),
        }),
      options,
    );
    return this.parse(method, response);
  }

  private async fetchWithRetry(
    method: string,
    send: () => Promise<Response>,
    options: { idempotent: boolean },
  ): Promise<Response> {
    for (let retryCount = 0; ; retryCount += 1) {
      let response: Response;
      try {
        response = await send();
      } catch (error) {
        // A network/timeout failure is AMBIGUOUS for a write: the request may have been sent and
        // processed before the connection died. Typed so postReply can reconcile-by-marker
        // instead of failing; for pure reads the distinction is harmless.
        throw new SlackAmbiguousDeliveryError(
          `slack ${method} request failed: ${errorMessage(error)}`,
          error,
        );
      }
      // A non-idempotent write (chat.postMessage) may retry only on a 429, which Slack rejects
      // BEFORE processing the request - so no reply was posted and a retry cannot duplicate it.
      // An ambiguous 5xx (the reply may have already been delivered) must NOT be retried here;
      // it surfaces as SlackAmbiguousDeliveryError so metadata-marked posts can reconcile.
      const canRetry = options.idempotent ? isRetryable(response.status) : response.status === 429;
      if (!canRetry || retryCount >= MAX_RETRIES) {
        if (response.status >= 500) {
          throw new SlackAmbiguousDeliveryError(
            `slack ${method} failed: status ${response.status}`,
          );
        }
        if (isRetryable(response.status)) {
          // A 429 at retry exhaustion is definitive: Slack rejected every attempt before
          // processing, so nothing was delivered.
          throw new Error(`slack ${method} failed: status ${response.status}`);
        }
        return response;
      }
      // Surface the backoff: when Slack rate-limits a history or reply read, a cold scan can spend
      // long stretches asleep here, one Retry-After at a time. Without this line that window is
      // silent and the daemon looks hung. One warn per wait makes the rate-limit crawl visible to
      // anyone tailing the process.
      const delayMs = retryDelayMs(response.headers, retryCount);
      this.logger.warn(
        `slack ${method}: HTTP ${response.status}; backing off ${Math.round(delayMs / 1000)}s ` +
          `before retry ${retryCount + 1}/${MAX_RETRIES}`,
      );
      await this.sleep(delayMs);
    }
  }

  private async parse(method: string, response: Response): Promise<Record<string, unknown>> {
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new Error(`slack ${method} returned a non-JSON response (HTTP ${response.status})`);
    }
    if (body.ok !== true) {
      const reason = typeof body.error === "string" ? body.error : String(response.status);
      // Benign Slack errors that mean the write's GOAL is already satisfied are treated as success.
      // This matters for idempotent retries: when an ambiguous 5xx actually applied the write, the
      // retry sees these "already done" errors and must resolve cleanly rather than report a failure
      // while the target state is in fact present (which would let the next poll observe a phantom
      // advanced/terminal status). reactions.add: already_reacted means the reaction is present
      // (the goal). reactions.remove: no_reaction means the reaction is already absent (the goal).
      if (method === "reactions.add" && reason === "already_reacted") return body;
      if (method === "reactions.remove" && reason === "no_reaction") return body;
      throw new Error(`slack ${method} failed: ${reason}`);
    }
    return body;
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(headers: Headers, retryCount: number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter.trim());
    if (Number.isInteger(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }
    const dateMs = Date.parse(retryAfter.trim());
    if (!Number.isNaN(dateMs)) {
      return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_DELAY_MS);
    }
  }
  return Math.min(1_000 * 2 ** retryCount, 30_000);
}

function nextCursor(body: Record<string, unknown>): string | undefined {
  const meta = body.response_metadata;
  if (typeof meta !== "object" || meta === null) return undefined;
  const cursor = (meta as Record<string, unknown>).next_cursor;
  if (typeof cursor !== "string" || cursor === "") return undefined;
  return cursor;
}

function toMessage(channel: string, m: RawSlackMessage, botUserId?: string): SlackMessage {
  const raw = m.reactions ?? [];
  return {
    channel,
    ts: m.ts ?? "",
    text: m.text ?? "",
    ...(typeof m.user === "string" ? { user: m.user } : {}),
    reactions: raw.map((r) => r.name).filter((n): n is string => typeof n === "string"),
    // Bot authorship comes from each reaction's `users` list. Slack may truncate that list on
    // heavily-reacted messages, so a bot reaction can occasionally be invisible here; state then
    // falls back conservatively (the thread reply, when one exists, always wins regardless).
    botReactions:
      botUserId === undefined
        ? []
        : raw
            .filter((r) => Array.isArray(r.users) && r.users.includes(botUserId))
            .map((r) => r.name)
            .filter((n): n is string => typeof n === "string"),
    ...(typeof m.reply_count === "number" && m.reply_count > 0
      ? { replyCount: m.reply_count }
      : {}),
    ...(typeof m.latest_reply === "string" ? { latestReply: m.latest_reply } : {}),
  };
}

function toThreadReply(m: RawSlackMessage): SlackThreadReply {
  // exactOptionalPropertyTypes: only set `user` when present rather than assigning undefined.
  const reply: SlackThreadReply = { ts: m.ts ?? "", text: m.text ?? "" };
  if (typeof m.user === "string") reply.user = m.user;
  const metadata = toMessageMetadata(m.metadata);
  if (metadata !== undefined) reply.metadata = metadata;
  return reply;
}

/** Map Slack's raw `metadata` field onto {@link SlackMessageMetadata}; undefined when absent. */
export function toMessageMetadata(
  raw: { event_type?: string; event_payload?: unknown } | undefined,
): SlackMessageMetadata | undefined {
  if (!raw || typeof raw.event_type !== "string" || !isRecord(raw.event_payload)) {
    return undefined;
  }
  return { eventType: raw.event_type, payload: raw.event_payload };
}

/**
 * An ambiguous write outcome: the request may or may not have been applied. postReply resolves
 * these by metadata-marker reconciliation; everything else propagates them as plain failures.
 */
class SlackAmbiguousDeliveryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SlackAmbiguousDeliveryError";
  }
}

/** The reconciliation key of a metadata payload: present only when `seq` is a unique string. */
function reconcilableMarker(
  metadata: SlackMessageMetadata | undefined,
): { eventType: string; seq: string } | null {
  if (!metadata) return null;
  const seq = metadata.payload.seq;
  if (typeof seq !== "string" || seq === "") return null;
  return { eventType: metadata.eventType, seq };
}

/**
 * A unique per-post marker value for send reconciliation. Time-prefixed for log readability;
 * the random suffix is what makes it unique - two posts can share a millisecond.
 */
export function makeMetadataSeq(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
