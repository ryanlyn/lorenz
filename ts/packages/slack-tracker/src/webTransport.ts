import type { Settings } from "@symphony/domain";

import { isBotMention } from "./mapping.js";
import type { SlackMessage, SlackThreadReply, SlackTransport } from "./transport.js";

interface RawSlackMessage {
  ts?: string;
  text?: string;
  user?: string;
  reactions?: Array<{ name?: string }>;
}

// Generous safety cap on conversations.history pages. The normal terminal condition is Slack
// returning no next_cursor (full history exhausted). This cap only exists to bound a pathological
// non-terminating cursor; reaching it while a cursor is STILL present is an anomaly we surface as a
// loud truncation warning rather than silently dropping older mentions. At limit=200 this covers
// ~100k messages per channel per poll.
const MAX_HISTORY_PAGES = 500;
const MAX_RETRIES = 4;

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
}

export class SlackWebTransport implements SlackTransport {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly botUserId: string | undefined;
  private readonly maxHistoryPages: number;
  private warnedNoBotUserId = false;

  constructor(
    settings: Settings,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: Sleep = defaultSleep,
    private readonly logger: SlackTrackerLogger = { warn: (message) => console.warn(message) },
    options: SlackWebTransportOptions = {},
  ) {
    this.endpoint = (settings.tracker.endpoint || "https://slack.com/api").replace(/\/+$/, "");
    this.token = settings.tracker.apiKey ?? "";
    this.botUserId = settings.tracker.botUserId;
    this.maxHistoryPages = options.maxHistoryPages ?? MAX_HISTORY_PAGES;
  }

  async listMentions(channels: string[]): Promise<SlackMessage[]> {
    // Each poll scans recent conversations.history from newest backward (no oldest/latest
    // watermark). A per-channel incremental watermark is a DEFERRED enhancement: a naive
    // time-watermark would regress re-discovery of undispatched active issues, because the runtime
    // re-surfaces an active-but-undispatched Todo/In Progress issue via the candidate poll, and a
    // watermark that advanced past it would stop re-surfacing it so it would never be picked up.
    // Doing this safely needs a stateful open-issue registry, tracked separately. The conservative
    // poll interval (WORKFLOW.slack.md polling.interval_ms) plus the 429/Retry-After backoff bound
    // the rate-limit pressure in the meantime.
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
      return [];
    }
    const out: SlackMessage[] = [];
    const failures: string[] = [];
    let completedCount = 0;
    for (const channel of channels) {
      // Isolate per-channel failures: a single unreadable channel (e.g. not_in_channel,
      // missing_scope, or a persistent 429) must not blind candidate discovery across the
      // other channels. Skip-and-log the bad channel and keep scanning the rest.
      //
      // Crucially, a channel's mentions are accumulated into a LOCAL buffer and only merged into
      // `out` once that channel's scan COMPLETES (Slack exhausts its history, or we hit the
      // page-cap truncation bound which is loudly surfaced below). If pagination fails partway
      // through, the partial buffer is DISCARDED: a partial scan must never masquerade as a
      // complete one, because every mention beyond the failed page would otherwise vanish silently
      // from candidate discovery and terminal cleanup. Only channels that completed count toward a
      // healthy poll; if no channel completes at all, we re-throw so the runtime records a
      // poll_error instead of returning a healthy-looking partial/empty result.
      try {
        const buffer: SlackMessage[] = [];
        let cursor: string | undefined;
        // Page until Slack stops returning a next_cursor: full exhaustion is the normal terminal
        // condition. The page count only guards against a pathological non-terminating cursor.
        let page = 0;
        for (; page < this.maxHistoryPages; page += 1) {
          const params: Record<string, string> = { channel, limit: "200" };
          if (cursor) params.cursor = cursor;
          const body = await this.get("conversations.history", params);
          const messages = Array.isArray(body.messages) ? (body.messages as RawSlackMessage[]) : [];
          for (const m of messages) {
            if (typeof m.ts !== "string") continue;
            if (!isBotMention(m.text ?? "", this.botUserId)) continue;
            buffer.push(toMessage(channel, m));
          }
          cursor = nextCursor(body);
          if (!cursor) break;
        }
        // Hitting the safety cap with a cursor STILL present means we stopped before exhausting the
        // channel's history. Older bot mentions beyond this point are silently invisible to candidate
        // discovery and terminal cleanup, so make the truncation loud rather than dropping them quietly.
        // Truncation is an intentional, surfaced bound, so the scan still counts as complete-enough:
        // we keep the buffer collected up to the cap.
        if (cursor) {
          this.logger.warn(
            `slack tracker: channel ${channel} history scan hit the ${this.maxHistoryPages}-page ` +
              "safety cap with more pages remaining; truncating scan. Older bot mentions in this " +
              "channel may be missed this poll.",
          );
        }
        // The channel scan completed (full exhaustion or surfaced truncation): merge its buffer.
        out.push(...buffer);
        completedCount += 1;
      } catch (error) {
        // A page failed after the transport's own retries: treat the whole channel as failed and
        // DISCARD its partial buffer (it is never merged into `out`). Log a per-channel warning and
        // continue to the next channel - one bad channel must not abort the others.
        const message = (error as Error).message;
        failures.push(`${channel}: ${message}`);
        this.logger.warn(
          `slack tracker: channel ${channel} scan failed before completing; discarding its ` +
            `partial results this poll: ${message}`,
        );
      }
    }
    // If there were channels to scan but NONE completed, surface the failure (preserving the
    // reject contract the runtime relies on for poll_error) rather than silently reporting a
    // healthy-looking partial/empty result.
    if (completedCount === 0 && failures.length > 0) {
      throw new Error(
        `slack conversations.history failed for all channels: ${failures.join("; ")}`,
      );
    }
    return out;
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
    return found ? toMessage(channel, found) : null;
  }

  async getThread(channel: string, ts: string): Promise<SlackThreadReply[]> {
    // conversations.replies returns the parent (root) message FIRST followed by its replies. Page
    // through next_cursor like listMentions (a pure read, safe to retry on 429/5xx) and drop the
    // parent (the message whose ts === the thread ts) so only the replies are returned.
    const out: SlackThreadReply[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.maxHistoryPages; page += 1) {
      const params: Record<string, string> = { channel, ts, limit: "200" };
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

  async postReply(channel: string, threadTs: string, body: string): Promise<void> {
    // chat.postMessage is NOT idempotent: a retry posts a DUPLICATE reply. It may retry only on a
    // 429 (rejected before processing), never on an ambiguous 5xx where the reply may have applied.
    await this.post(
      "chat.postMessage",
      { channel, thread_ts: threadTs, text: body },
      {
        idempotent: false,
      },
    );
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
    params: Record<string, string>,
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
        throw new Error(`slack ${method} request failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      // A non-idempotent write (chat.postMessage) may retry only on a 429, which Slack rejects
      // BEFORE processing the request - so no reply was posted and a retry cannot duplicate it.
      // An ambiguous 5xx (the reply may have already been delivered) must NOT be retried.
      const canRetry = options.idempotent ? isRetryable(response.status) : response.status === 429;
      if (!canRetry || retryCount >= MAX_RETRIES) {
        if (isRetryable(response.status)) {
          throw new Error(`slack ${method} failed: status ${response.status}`);
        }
        return response;
      }
      await this.sleep(retryDelayMs(response.headers, retryCount));
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
    if (Number.isInteger(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(retryAfter.trim());
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
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

function toMessage(channel: string, m: RawSlackMessage): SlackMessage {
  return {
    channel,
    ts: m.ts ?? "",
    text: m.text ?? "",
    reactions: (m.reactions ?? [])
      .map((r) => r.name)
      .filter((n): n is string => typeof n === "string"),
  };
}

function toThreadReply(m: RawSlackMessage): SlackThreadReply {
  // exactOptionalPropertyTypes: only set `user` when present rather than assigning undefined.
  const reply: SlackThreadReply = { ts: m.ts ?? "", text: m.text ?? "" };
  if (typeof m.user === "string") reply.user = m.user;
  return reply;
}
