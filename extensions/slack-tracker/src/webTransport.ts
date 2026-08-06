import {
  errorMessage,
  isRecord,
  type OpenIssueAttachmentOptions,
  type OpenedIssueAttachment,
  type Settings,
} from "@lorenz/domain";

import { isAllowedAuthor, isBotMention } from "./mapping.js";
import { slackEndpoint, slackTrackerOptions } from "./options.js";
import { stripBroadcastMentions } from "./sanitize.js";
import type {
  SlackChannelScan,
  SlackFile,
  SlackFileUploadCompletion,
  SlackFileUploadRequest,
  SlackMessage,
  SlackMessageMetadata,
  SlackPostOptions,
  SlackPreparedFileUpload,
  SlackThreadReply,
  SlackThreadReplyPage,
  SlackThreadReplyPageQuery,
  SlackTransport,
  SlackUser,
} from "./transport.js";

interface RawSlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  mode?: string;
  file_access?: string;
  url_private?: string;
  url_private_download?: string;
}

interface RawSlackMessage {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  edited?: unknown;
  reply_count?: number;
  latest_reply?: string;
  reactions?: Array<{ name?: string; users?: string[] }>;
  metadata?: { event_type?: string; event_payload?: unknown };
  files?: RawSlackFile[];
  /** Slack Connect/event payloads may supply file ids separately from partial file objects. */
  x_files?: string[];
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

type Sleep = (delayMs: number, abortSignal?: AbortSignal) => Promise<void>;

const defaultSleep: Sleep = async (delayMs, abortSignal) =>
  new Promise((resolve, reject) => {
    abortSignal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      const reason = abortSignal?.reason as unknown;
      reject(reason instanceof Error ? reason : new Error("Slack request aborted"));
    };
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });

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

  async openFile(
    fileId: string,
    options: OpenIssueAttachmentOptions,
  ): Promise<OpenedIssueAttachment> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
      throw new Error(`invalid Slack attachment byte limit: ${options.maxBytes}`);
    }
    options.abortSignal?.throwIfAborted();
    // Always hydrate through files.info. Besides refreshing stale private URLs, this is required
    // for Slack Connect's `file_access: check_file_info` placeholder objects.
    const info = await this.get("files.info", { file: fileId }, options.abortSignal);
    if (!isRecord(info.file)) throw new Error(`slack files.info returned no file: ${fileId}`);
    const raw = info.file as RawSlackFile;
    if (typeof raw.id !== "string" || raw.id !== fileId) {
      throw new Error(`slack files.info returned the wrong file for ${fileId}`);
    }
    if (typeof raw.size === "number" && raw.size > options.maxBytes) {
      throw new Error(
        `slack attachment ${fileId} exceeds the ${options.maxBytes}-byte file limit (${raw.size})`,
      );
    }
    const privateUrl =
      typeof raw.url_private_download === "string" && raw.url_private_download !== ""
        ? raw.url_private_download
        : typeof raw.url_private === "string" && raw.url_private !== ""
          ? raw.url_private
          : null;
    if (privateUrl === null) {
      throw new Error(`slack attachment ${fileId} is unavailable for download`);
    }
    const response = await this.fetchPrivateFile(privateUrl, options.abortSignal);
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`slack attachment ${fileId} download failed: HTTP ${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const advertised = Number(contentLength);
      if (Number.isSafeInteger(advertised) && advertised > options.maxBytes) {
        await cancelResponseBody(response);
        throw new Error(
          `slack attachment ${fileId} exceeds the ${options.maxBytes}-byte file limit (${advertised})`,
        );
      }
    }
    if (response.body === null) {
      throw new Error(`slack attachment ${fileId} download returned no body`);
    }
    const mediaType =
      (typeof raw.mimetype === "string" && raw.mimetype !== "" ? raw.mimetype : undefined) ??
      response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    return {
      body: boundedResponseBody(response.body, options.maxBytes, fileId, options.abortSignal),
      ...(mediaType ? { mediaType } : {}),
      ...(typeof raw.size === "number" && Number.isSafeInteger(raw.size) && raw.size >= 0
        ? { sizeBytes: raw.size }
        : {}),
    };
  }

  /** Fetch a private Slack file without ever forwarding the bearer token to an untrusted host. */
  private async fetchPrivateFile(url: string, abortSignal?: AbortSignal): Promise<Response> {
    let current = new URL(url);
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      if (!trustedSlackFileUrl(current, this.endpoint)) {
        throw new Error(`slack attachment download refused untrusted URL: ${current.origin}`);
      }
      const response = await this.fetchWithRetry(
        "files.download",
        async () => {
          abortSignal?.throwIfAborted();
          const timeoutSignal = AbortSignal.timeout(30_000);
          return this.fetchImpl(current, {
            method: "GET",
            headers: { authorization: `Bearer ${this.token}` },
            redirect: "manual",
            signal: abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal,
          });
        },
        { idempotent: true, ...(abortSignal ? { abortSignal } : {}) },
      );
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      await cancelResponseBody(response);
      if (!location || redirectCount === 3) {
        throw new Error("slack attachment download returned an invalid redirect");
      }
      current = new URL(location, current);
    }
    throw new Error("slack attachment download exceeded the redirect limit");
  }

  async prepareFileUpload(request: SlackFileUploadRequest): Promise<SlackPreparedFileUpload> {
    // Allocating another upload ticket after an ambiguous/5xx outcome can only leave the first
    // uncompleted ticket to be discarded by Slack; it cannot share a file or post a message.
    // Retrying HTTP failures is therefore safe at the operation's goal level.
    const response = await this.post(
      "files.getUploadURLExternal",
      {
        filename: request.filename,
        length: request.length,
        ...(request.altText !== undefined ? { alt_txt: request.altText } : {}),
        ...(request.snippetType !== undefined ? { snippet_type: request.snippetType } : {}),
      },
      // Slack advertises JSON for this method, but some production workspaces treat a JSON body as
      // empty and report both required fields missing. Form encoding is accepted consistently.
      { idempotent: true, encoding: "form" },
    );
    const fileId = response.file_id;
    const uploadUrl = response.upload_url;
    if (typeof fileId !== "string" || fileId === "") {
      throw new Error("slack files.getUploadURLExternal returned no file id");
    }
    if (typeof uploadUrl !== "string" || uploadUrl === "") {
      throw new Error("slack files.getUploadURLExternal returned no upload URL");
    }
    let parsedUploadUrl: URL;
    try {
      parsedUploadUrl = new URL(uploadUrl);
    } catch (error) {
      throw new Error("slack files.getUploadURLExternal returned an invalid upload URL", {
        cause: error,
      });
    }
    // The worker will send local file bytes to this URL. Refuse an unexpected host before the URL
    // crosses that boundary, even though the API response itself came from authenticated Slack.
    if (!trustedSlackFileUrl(parsedUploadUrl, this.endpoint)) {
      throw new Error(
        `slack files.getUploadURLExternal refused untrusted upload URL: ${parsedUploadUrl.origin}`,
      );
    }
    return { fileId, uploadUrl: parsedUploadUrl.toString() };
  }

  async completeFileUploads(
    channel: string,
    threadTs: string,
    body: string,
    files: readonly SlackFileUploadCompletion[],
  ): Promise<SlackFile[]> {
    // Slack documents completion as single-use. Treat it like chat.postMessage: retry only a 429
    // that Slack rejected before processing, never an ambiguous network/5xx outcome.
    const response = await this.post(
      "files.completeUploadExternal",
      {
        files: files.map((file) => ({
          id: file.fileId,
          ...(file.title !== undefined ? { title: file.title } : {}),
        })),
        channel_id: channel,
        thread_ts: threadTs,
        initial_comment: stripBroadcastMentions(body),
      },
      { idempotent: false },
    );
    const completed = toSlackFiles(response.files);
    const completedIds = new Set(completed.map((file) => file.id));
    for (const file of files) {
      if (!completedIds.has(file.fileId)) {
        throw new Error(`slack files.completeUploadExternal omitted completed file ${file.fileId}`);
      }
    }
    return completed;
  }

  async getThread(
    channel: string,
    ts: string,
    abortSignal?: AbortSignal,
  ): Promise<SlackThreadReply[]> {
    // conversations.replies returns the parent (root) message FIRST followed by its replies. Page
    // through next_cursor like listMentions (a pure read, safe to retry on 429/5xx) and drop the
    // parent (the message whose ts === the thread ts) so only the replies are returned.
    // include_all_metadata carries back the bot's own message metadata, which the fold prefers
    // over parsing reply text and which send reconciliation matches markers against.
    const out: SlackThreadReply[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.maxHistoryPages; page += 1) {
      const pageResult = await this.getThreadPage(channel, ts, {
        afterTs: "0",
        limit: 200,
        ...(cursor ? { cursor } : {}),
        ...(abortSignal ? { abortSignal } : {}),
      });
      out.push(...pageResult.replies);
      cursor = pageResult.nextCursor;
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

  async getThreadPage(
    channel: string,
    ts: string,
    query: SlackThreadReplyPageQuery,
  ): Promise<SlackThreadReplyPage> {
    query.abortSignal?.throwIfAborted();
    const params: Record<string, string> = {
      channel,
      ts,
      oldest: query.afterTs,
      inclusive: "false",
      limit: String(Math.min(200, Math.max(1, query.limit))),
      include_all_metadata: "true",
    };
    if (query.cursor) params.cursor = query.cursor;
    const body = await this.get("conversations.replies", params, query.abortSignal);
    const messages = Array.isArray(body.messages) ? (body.messages as RawSlackMessage[]) : [];
    const replies = messages
      .filter((message) => typeof message.ts === "string" && message.ts !== ts)
      .map(toThreadReply);
    const cursor = nextCursor(body);
    return {
      replies,
      ...(cursor ? { nextCursor: cursor } : {}),
    };
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
    // been delivered - is checked by metadata reconciliation when the post carries a unique
    // marker (`metadata.payload.seq`). A found marker recovers the original send's real ts. An
    // absent marker is not proof of non-delivery because Slack may still be processing or
    // indexing the post, so the ambiguous error is surfaced without retrying.
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
    try {
      const response = await this.post("chat.postMessage", params, { idempotent: false });
      return typeof response.ts === "string" ? response.ts : "";
    } catch (error) {
      if (marker === null || !(error instanceof SlackAmbiguousDeliveryError)) {
        throw error;
      }
      this.logger.warn(
        `slack chat.postMessage outcome unknown (${errorMessage(error)}); checking the ` +
          `metadata marker before surfacing failure`,
      );
      const deliveredTs = await this.findReplyByMarker(channel, threadTs, marker);
      if (deliveredTs !== null) return deliveredTs;
      throw error;
    }
  }

  /**
   * Scan the complete thread for this bot's reply carrying the metadata marker. A read failure or
   * safety-cap truncation propagates. A complete scan can recover an already-visible send, but
   * absence never authorizes another non-idempotent post.
   */
  private async findReplyByMarker(
    channel: string,
    threadTs: string,
    marker: { eventType: string; seq: string },
  ): Promise<string | null> {
    let cursor: string | undefined;
    for (let page = 0; page < this.maxHistoryPages; page += 1) {
      const result = await this.getThreadPage(channel, threadTs, {
        afterTs: "0",
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const reply of result.replies) {
        if (
          this.botUserId !== undefined &&
          reply.user === this.botUserId &&
          reply.metadata?.eventType === marker.eventType &&
          reply.metadata.payload.seq === marker.seq
        ) {
          return reply.ts;
        }
      }
      cursor = result.nextCursor;
      if (!cursor) return null;
    }
    throw new Error(
      `slack conversations.replies reconciliation for ${channel}:${threadTs} hit the ` +
        `${this.maxHistoryPages}-page safety cap with more replies remaining`,
    );
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
    abortSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = `${this.endpoint}/${method}?${new URLSearchParams(params).toString()}`;
    // GET (conversations.history) is a pure read: safe to retry on both 429 and 5xx.
    const response = await this.fetchWithRetry(
      method,
      async () => {
        abortSignal?.throwIfAborted();
        const timeoutSignal = AbortSignal.timeout(30_000);
        return this.fetchImpl(url, {
          method: "GET",
          headers: { authorization: `Bearer ${this.token}` },
          signal: abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal,
        });
      },
      { idempotent: true, ...(abortSignal ? { abortSignal } : {}) },
    );
    return this.parse(method, response);
  }

  private async post(
    method: string,
    params: Record<string, unknown>,
    options: { idempotent: boolean; encoding?: "json" | "form" },
  ): Promise<Record<string, unknown>> {
    const formEncoded = options.encoding === "form";
    const response = await this.fetchWithRetry(
      method,
      async () =>
        this.fetchImpl(`${this.endpoint}/${method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": formEncoded
              ? "application/x-www-form-urlencoded"
              : "application/json; charset=utf-8",
          },
          body: formEncoded ? slackFormBody(params) : JSON.stringify(params),
          signal: AbortSignal.timeout(30_000),
        }),
      options,
    );
    return this.parse(method, response);
  }

  private async fetchWithRetry(
    method: string,
    send: () => Promise<Response>,
    options: { idempotent: boolean; abortSignal?: AbortSignal },
  ): Promise<Response> {
    for (let retryCount = 0; ; retryCount += 1) {
      options.abortSignal?.throwIfAborted();
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
          await cancelResponseBody(response);
          throw new SlackAmbiguousDeliveryError(
            `slack ${method} failed: status ${response.status}`,
          );
        }
        if (isRetryable(response.status)) {
          // A 429 at retry exhaustion is definitive: Slack rejected every attempt before
          // processing, so nothing was delivered.
          await cancelResponseBody(response);
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
      await cancelResponseBody(response);
      await this.sleep(delayMs, options.abortSignal);
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
      throw new SlackApiError(method, reason);
    }
    return body;
  }
}

function slackFormBody(params: Record<string, unknown>): string {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`slack form parameter ${name} must be a string, number, or boolean`);
    }
    body.set(name, String(value));
  }
  return body.toString();
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

function trustedSlackFileUrl(url: URL, endpoint: string): boolean {
  if (url.username !== "" || url.password !== "") return false;
  const endpointUrl = new URL(endpoint);
  if (url.origin === endpointUrl.origin) return true;
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "files.slack.com" ||
    host.endsWith(".slack.com") ||
    host === "slack-files.com" ||
    host.endsWith(".slack-files.com") ||
    host === "slack-gov.com" ||
    host.endsWith(".slack-gov.com")
  );
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Releasing a response is best-effort and must not replace the primary Slack error.
  }
}

async function* boundedResponseBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  fileId: string,
  abortSignal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      abortSignal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        return;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        throw new Error(
          `slack attachment ${fileId} exceeds the ${maxBytes}-byte file limit while downloading`,
        );
      }
      yield chunk.value;
    }
  } finally {
    if (!complete) {
      try {
        await reader.cancel();
      } catch {
        // The primary abort, limit, or consumer error wins.
      }
    }
    reader.releaseLock();
  }
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
    ...filesProperty(m.files, m.x_files),
  };
}

function toThreadReply(m: RawSlackMessage): SlackThreadReply {
  // exactOptionalPropertyTypes: only set `user` when present rather than assigning undefined.
  const reply: SlackThreadReply = { ts: m.ts ?? "", text: m.text ?? "" };
  if (typeof m.user === "string") reply.user = m.user;
  if (typeof m.subtype === "string") reply.subtype = m.subtype;
  if (typeof m.bot_id === "string" || m.subtype === "bot_message") reply.isBot = true;
  if (m.edited !== undefined) reply.edited = true;
  const metadata = toMessageMetadata(m.metadata);
  if (metadata !== undefined) reply.metadata = metadata;
  const files = toSlackFiles(m.files, m.x_files);
  if (files.length > 0) reply.files = files;
  return reply;
}

/** Defensively project Slack file objects without retaining private download URLs. */
export function toSlackFiles(files: unknown, xFiles: unknown = undefined): SlackFile[] {
  const out: SlackFile[] = [];
  const seen = new Set<string>();
  if (Array.isArray(files)) {
    for (const value of files) {
      if (!isRecord(value) || typeof value.id !== "string" || value.id === "") continue;
      const file = safeSlackFile(value);
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      out.push(file);
    }
  }
  if (Array.isArray(xFiles)) {
    for (const value of xFiles) {
      if (typeof value !== "string" || value === "" || seen.has(value)) continue;
      seen.add(value);
      out.push({ id: value, mode: "file_access", fileAccess: "check_file_info" });
    }
  }
  return out;
}

function filesProperty(
  files: RawSlackFile[] | undefined,
  xFiles: string[] | undefined,
): { files?: SlackFile[] } {
  const projected = toSlackFiles(files, xFiles);
  return projected.length > 0 ? { files: projected } : {};
}

function safeSlackFile(file: RawSlackFile): SlackFile {
  return {
    id: file.id!,
    ...(typeof file.name === "string" && file.name !== "" ? { name: file.name } : {}),
    ...(typeof file.title === "string" && file.title !== "" ? { title: file.title } : {}),
    ...(typeof file.mimetype === "string" && file.mimetype !== ""
      ? { mimetype: file.mimetype }
      : {}),
    ...(typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0
      ? { size: file.size }
      : {}),
    ...(typeof file.mode === "string" && file.mode !== "" ? { mode: file.mode } : {}),
    ...(typeof file.file_access === "string" && file.file_access !== ""
      ? { fileAccess: file.file_access }
      : {}),
  };
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
 * An ambiguous write outcome: the request may or may not have been applied. postReply can recover
 * one whose metadata marker is already visible; it never retries an unresolved send.
 */
class SlackAmbiguousDeliveryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SlackAmbiguousDeliveryError";
  }
}

/** A definitive Slack Web API error response with its machine-readable error code. */
export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`slack ${method} failed: ${code}`);
    this.name = "SlackApiError";
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
