import { isAllowedAuthor, isBotMention } from "./mapping.js";
import type {
  SlackChannelScan,
  SlackMessage,
  SlackThreadReply,
  SlackThreadReplyPage,
  SlackThreadReplyPageQuery,
  SlackTransport,
  SlackUser,
} from "./transport.js";

interface SeedMessage {
  ts: string;
  text: string;
  user?: string;
  /** Reactions authored by the BOT (the mirror/marker), as if written in an earlier session. */
  reactions?: string[];
  /** Reactions authored by humans: visible on the message but never state-bearing. */
  humanReactions?: string[];
  replies?: SlackThreadReply[];
}

interface StoredMessage extends Omit<SlackMessage, "reactions"> {
  humanReactions: string[];
  thread: SlackThreadReply[];
}

interface InMemoryOptions {
  botUserId?: string;
  /** Author allowlist mirroring `tracker.users`: empty means no author constraint. */
  allowedUsers?: string[];
  /** Resolvable user profiles for `getUser` (defaults to none). */
  users?: Record<string, SlackUser>;
}

export class InMemorySlackTransport implements SlackTransport {
  readonly replies: Array<{ channel: string; threadTs: string; body: string }> = [];
  private readonly messages: Map<string, StoredMessage[]> = new Map();
  private readonly botUserId: string | undefined;
  private readonly allowedUsers: string[];
  private readonly users: Record<string, SlackUser>;

  constructor(seed: Record<string, SeedMessage[]> = {}, opts: InMemoryOptions = {}) {
    this.botUserId = opts.botUserId;
    this.allowedUsers = opts.allowedUsers ?? [];
    this.users = opts.users ?? {};
    for (const [channel, msgs] of Object.entries(seed)) {
      this.messages.set(
        channel,
        msgs.map((m) => ({
          channel,
          ts: m.ts,
          text: m.text,
          ...(m.user !== undefined ? { user: m.user } : {}),
          botReactions: [...(m.reactions ?? [])],
          humanReactions: [...(m.humanReactions ?? [])],
          thread: (m.replies ?? []).map((r) => ({ ...r })),
        })),
      );
    }
  }

  async scanChannels(channels: string[]): Promise<SlackChannelScan> {
    const mentions: SlackMessage[] = [];
    const threadedRoots: SlackMessage[] = [];
    for (const channel of channels) {
      for (const m of this.messages.get(channel) ?? []) {
        if (isBotMention(m.text, this.botUserId) && isAllowedAuthor(m.user, this.allowedUsers))
          mentions.push(this.snapshot(m));
        else if (m.thread.length > 0) threadedRoots.push(this.snapshot(m));
      }
    }
    return Promise.resolve({ mentions, threadedRoots });
  }

  async listMentions(channels: string[]): Promise<SlackMessage[]> {
    return (await this.scanChannels(channels)).mentions;
  }

  async teamUrl(): Promise<string | null> {
    return Promise.resolve("https://example.slack.com");
  }

  async getMessage(channel: string, ts: string): Promise<SlackMessage | null> {
    const found = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    return Promise.resolve(found ? this.snapshot(found) : null);
  }

  async getThread(
    channel: string,
    ts: string,
    abortSignal?: AbortSignal,
  ): Promise<SlackThreadReply[]> {
    abortSignal?.throwIfAborted();
    const found = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    return Promise.resolve(found ? found.thread.map((r) => ({ ...r })) : []);
  }

  async getThreadPage(
    channel: string,
    ts: string,
    query: SlackThreadReplyPageQuery,
  ): Promise<SlackThreadReplyPage> {
    query.abortSignal?.throwIfAborted();
    const found = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    const after = Number.parseFloat(query.afterTs);
    const offset = query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`invalid in-memory Slack thread cursor: ${query.cursor}`);
    }
    const replies = (found?.thread ?? [])
      .filter((reply) => Number.parseFloat(reply.ts) > after)
      .sort((left, right) => Number.parseFloat(left.ts) - Number.parseFloat(right.ts));
    const end = Math.min(replies.length, offset + query.limit);
    return Promise.resolve({
      replies: replies.slice(offset, end).map((reply) => ({ ...reply })),
      ...(end < replies.length ? { nextCursor: String(end) } : {}),
    });
  }

  async getUser(userId: string): Promise<SlackUser | null> {
    return Promise.resolve(this.users[userId] ?? null);
  }

  async listAround(
    channel: string,
    ts: string,
    window: { before: number; after: number },
  ): Promise<SlackMessage[]> {
    const all = [...(this.messages.get(channel) ?? [])].sort(
      (a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts),
    );
    const anchor = all.findIndex((m) => m.ts === ts);
    if (anchor === -1) return Promise.resolve([]);
    const start = Math.max(0, anchor - window.before + 1);
    const end = Math.min(all.length, anchor + 1 + window.after);
    return Promise.resolve(all.slice(start, end).map((m) => this.snapshot(m)));
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    const msg = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    // This transport acts as the bot, so a reaction it adds is bot-authored.
    if (msg && !msg.botReactions.includes(name)) msg.botReactions.push(name);
    return Promise.resolve();
  }

  async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    // Slack's reactions.remove is self-scoped: it only removes the CALLER's reaction, so a
    // human-authored one survives (removing an absent one is the benign no_reaction success).
    const msg = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    if (msg) msg.botReactions = msg.botReactions.filter((r) => r !== name);
    return Promise.resolve();
  }

  async postReply(channel: string, threadTs: string, body: string): Promise<void> {
    this.replies.push({ channel, threadTs, body });
    // Append the reply to the parent message's thread so a posted reply can be read back via
    // getThread in tests. The reply is authored by the bot, with a ts after the parent's.
    const parent = (this.messages.get(channel) ?? []).find((m) => m.ts === threadTs);
    if (parent) {
      const reply: SlackThreadReply = {
        ts: `${Number.parseFloat(threadTs) + parent.thread.length + 1}.000000`,
        text: body,
      };
      if (this.botUserId !== undefined) reply.user = this.botUserId;
      parent.thread.push(reply);
    }
    return Promise.resolve();
  }

  private snapshot(message: StoredMessage): SlackMessage {
    const { thread, humanReactions, ...rest } = message;
    return {
      ...rest,
      reactions: [...new Set([...message.botReactions, ...humanReactions])],
      botReactions: [...message.botReactions],
      ...(thread.length > 0
        ? { replyCount: thread.length, latestReply: thread[thread.length - 1]!.ts }
        : {}),
    };
  }
}
