import { isBotMention } from "./mapping.js";
import type { SlackMessage, SlackThreadReply, SlackTransport } from "./transport.js";

interface SeedMessage {
  ts: string;
  text: string;
  reactions?: string[];
  replies?: SlackThreadReply[];
}

interface StoredMessage extends SlackMessage {
  thread: SlackThreadReply[];
}

export class InMemorySlackTransport implements SlackTransport {
  readonly replies: Array<{ channel: string; threadTs: string; body: string }> = [];
  private readonly messages: Map<string, StoredMessage[]> = new Map();
  private readonly botUserId: string | undefined;

  constructor(seed: Record<string, SeedMessage[]> = {}, opts: { botUserId?: string } = {}) {
    this.botUserId = opts.botUserId;
    for (const [channel, msgs] of Object.entries(seed)) {
      this.messages.set(
        channel,
        msgs.map((m) => ({
          channel,
          ts: m.ts,
          text: m.text,
          reactions: [...(m.reactions ?? [])],
          thread: (m.replies ?? []).map((r) => ({ ...r })),
        })),
      );
    }
  }

  async listMentions(channels: string[]): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    for (const channel of channels) {
      for (const m of this.messages.get(channel) ?? []) {
        if (isBotMention(m.text, this.botUserId)) out.push({ ...m, reactions: [...m.reactions] });
      }
    }
    return Promise.resolve(out);
  }

  async teamUrl(): Promise<string | null> {
    return Promise.resolve("https://example.slack.com");
  }

  async getMessage(channel: string, ts: string): Promise<SlackMessage | null> {
    const found = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    return Promise.resolve(
      found
        ? {
            channel: found.channel,
            ts: found.ts,
            text: found.text,
            reactions: [...found.reactions],
          }
        : null,
    );
  }

  async getThread(channel: string, ts: string): Promise<SlackThreadReply[]> {
    const found = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    return Promise.resolve(found ? found.thread.map((r) => ({ ...r })) : []);
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    const msg = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    if (msg && !msg.reactions.includes(name)) msg.reactions.push(name);
    return Promise.resolve();
  }

  async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    const msg = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    if (msg) msg.reactions = msg.reactions.filter((r) => r !== name);
    return Promise.resolve();
  }

  async postReply(channel: string, threadTs: string, body: string): Promise<void> {
    this.replies.push({ channel, threadTs, body });
    // Append the reply to the parent message's thread so a posted reply can be read back via
    // getThread in tests. Synthesize a ts so the reply is distinguishable from the parent.
    const parent = (this.messages.get(channel) ?? []).find((m) => m.ts === threadTs);
    if (parent)
      parent.thread.push({ ts: `${threadTs}-reply-${parent.thread.length + 1}`, text: body });
    return Promise.resolve();
  }
}
