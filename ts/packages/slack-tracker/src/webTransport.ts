import type { Settings } from "@symphony/domain";

import { isBotMention } from "./mapping.js";
import type { SlackMessage, SlackTransport } from "./transport.js";

interface RawSlackMessage {
  ts?: string;
  text?: string;
  reactions?: Array<{ name?: string }>;
}

const MAX_HISTORY_PAGES = 50;
const MAX_RETRIES = 4;

type Sleep = (delayMs: number) => Promise<void>;

const defaultSleep: Sleep = async (delayMs) =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

/** Minimal logging surface so a skipped (unreadable) channel is surfaced (default: console.warn). */
export interface SlackTrackerLogger {
  warn(message: string): void;
}

export class SlackWebTransport implements SlackTransport {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly botUserId: string | undefined;
  private warnedNoBotUserId = false;

  constructor(
    settings: Settings,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: Sleep = defaultSleep,
    private readonly logger: SlackTrackerLogger = { warn: (message) => console.warn(message) },
  ) {
    this.endpoint = (settings.tracker.endpoint || "https://slack.com/api").replace(/\/+$/, "");
    this.token = settings.tracker.apiKey ?? "";
    this.botUserId = settings.tracker.botUserId;
  }

  async listMentions(channels: string[]): Promise<SlackMessage[]> {
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
    let anySucceeded = false;
    for (const channel of channels) {
      // Isolate per-channel failures: a single unreadable channel (e.g. not_in_channel,
      // missing_scope, or a persistent 429) must not blind candidate discovery across the
      // other channels. Skip-and-log the bad channel; pages collected before the failure are
      // already in `out` and survive. A channel that completes at least one page counts as a
      // success, so only a total wipeout (no channel readable at all) re-throws and surfaces
      // as a runtime poll_error.
      try {
        let cursor: string | undefined;
        for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
          const params: Record<string, string> = { channel, limit: "200" };
          if (cursor) params.cursor = cursor;
          const body = await this.get("conversations.history", params);
          anySucceeded = true;
          const messages = Array.isArray(body.messages) ? (body.messages as RawSlackMessage[]) : [];
          for (const m of messages) {
            if (typeof m.ts !== "string") continue;
            if (!isBotMention(m.text ?? "", this.botUserId)) continue;
            out.push(toMessage(channel, m));
          }
          cursor = nextCursor(body);
          if (!cursor) break;
        }
      } catch (error) {
        const message = (error as Error).message;
        failures.push(`${channel}: ${message}`);
        this.logger.warn(`slack tracker: skipping channel ${channel}: ${message}`);
      }
    }
    // If no channel produced any successful page, surface the failure (preserving the
    // single-channel reject contract the runtime relies on for poll_error) rather than
    // silently reporting zero mentions.
    if (!anySucceeded && failures.length > 0) {
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

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    await this.post("reactions.add", { channel, timestamp: ts, name });
  }

  async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    await this.post("reactions.remove", { channel, timestamp: ts, name });
  }

  async postReply(channel: string, threadTs: string, body: string): Promise<void> {
    await this.post("chat.postMessage", { channel, thread_ts: threadTs, text: body });
  }

  private async get(
    method: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const url = `${this.endpoint}/${method}?${new URLSearchParams(params).toString()}`;
    const response = await this.fetchWithRetry(method, async () =>
      this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(30_000),
      }),
    );
    return this.parse(method, response);
  }

  private async post(
    method: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchWithRetry(method, async () =>
      this.fetchImpl(`${this.endpoint}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30_000),
      }),
    );
    return this.parse(method, response);
  }

  private async fetchWithRetry(method: string, send: () => Promise<Response>): Promise<Response> {
    for (let retryCount = 0; ; retryCount += 1) {
      let response: Response;
      try {
        response = await send();
      } catch (error) {
        throw new Error(`slack ${method} request failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      if (!isRetryable(response.status) || retryCount >= MAX_RETRIES) {
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
