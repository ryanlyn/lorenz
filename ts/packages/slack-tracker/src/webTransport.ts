import type { Settings } from "@symphony/domain";

import { isBotMention } from "./mapping.js";
import type { SlackMessage, SlackTransport } from "./transport.js";

interface RawSlackMessage {
  ts?: string;
  text?: string;
  reactions?: Array<{ name?: string }>;
}

const MAX_HISTORY_PAGES = 50;

export class SlackWebTransport implements SlackTransport {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly botUserId: string | undefined;

  constructor(
    settings: Settings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.endpoint = (settings.tracker.endpoint || "https://slack.com/api").replace(/\/+$/, "");
    this.token = settings.tracker.apiKey ?? "";
    this.botUserId = settings.tracker.botUserId;
  }

  async listMentions(channels: string[]): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    for (const channel of channels) {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
        const params: Record<string, string> = { channel, limit: "200" };
        if (cursor) params.cursor = cursor;
        const body = await this.get("conversations.history", params);
        const messages = Array.isArray(body.messages) ? (body.messages as RawSlackMessage[]) : [];
        for (const m of messages) {
          if (typeof m.ts !== "string") continue;
          if (!isBotMention(m.text ?? "", this.botUserId)) continue;
          out.push(toMessage(channel, m));
        }
        cursor = nextCursor(body);
        if (!cursor) break;
      }
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
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    return this.parse(method, response);
  }

  private async post(
    method: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.endpoint}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30_000),
    });
    return this.parse(method, response);
  }

  private async parse(method: string, response: Response): Promise<Record<string, unknown>> {
    const body = (await response.json()) as Record<string, unknown>;
    if (body.ok !== true) {
      const reason = typeof body.error === "string" ? body.error : String(response.status);
      throw new Error(`slack ${method} failed: ${reason}`);
    }
    return body;
  }
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
