import { isAllowedAuthor, isBotMention } from "./mapping.js";
import { stripBroadcastMentions } from "./sanitize.js";
import type {
  SlackChannelScan,
  SlackMessage,
  SlackPostOptions,
  SlackThreadReply,
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
  readonly ephemerals: Array<{ channel: string; user: string; threadTs: string; body: string }> =
    [];
  readonly openedViews: Array<{ triggerId: string; view: Record<string, unknown> }> = [];
  readonly updatedViews: Array<{ viewId: string; view: Record<string, unknown> }> = [];
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

  async getThread(channel: string, ts: string): Promise<SlackThreadReply[]> {
    const found = (this.messages.get(channel) ?? []).find((m) => m.ts === ts);
    return Promise.resolve(found ? found.thread.map((r) => ({ ...r })) : []);
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

  async postReply(
    channel: string,
    threadTs: string,
    body: string,
    options: SlackPostOptions = {},
  ): Promise<string> {
    const text = stripBroadcastMentions(body);
    this.replies.push({ channel, threadTs, body: text });
    // Append the reply to the parent message's thread so a posted reply can be read back via
    // getThread in tests. The reply is authored by the bot, with a ts after the parent's.
    const parent = (this.messages.get(channel) ?? []).find((m) => m.ts === threadTs);
    const ts = parent
      ? `${Number.parseFloat(threadTs) + parent.thread.length + 1}.000000`
      : `${Number.parseFloat(threadTs) + 1}.000000`;
    if (parent) {
      const reply: SlackThreadReply = { ts, text };
      if (this.botUserId !== undefined) reply.user = this.botUserId;
      if (options.metadata !== undefined) reply.metadata = options.metadata;
      parent.thread.push(reply);
    }
    return Promise.resolve(ts);
  }

  async updateMessage(
    channel: string,
    ts: string,
    body: string,
    options: SlackPostOptions = {},
  ): Promise<void> {
    // Edits apply wherever the message lives: a root, or a reply in any thread.
    const text = stripBroadcastMentions(body);
    for (const m of this.messages.get(channel) ?? []) {
      if (m.ts === ts) {
        m.text = text;
        return Promise.resolve();
      }
      const reply = m.thread.find((r) => r.ts === ts);
      if (reply) {
        reply.text = text;
        if (options.metadata !== undefined) reply.metadata = options.metadata;
        return Promise.resolve();
      }
    }
    return Promise.reject(new Error("slack chat.update failed: message_not_found"));
  }

  async postEphemeral(
    channel: string,
    user: string,
    threadTs: string,
    body: string,
  ): Promise<void> {
    this.ephemerals.push({ channel, user, threadTs, body: stripBroadcastMentions(body) });
    return Promise.resolve();
  }

  async openView(triggerId: string, view: Record<string, unknown>): Promise<string> {
    this.openedViews.push({ triggerId, view });
    return Promise.resolve(`V_OPEN_${this.openedViews.length}`);
  }

  async updateView(viewId: string, view: Record<string, unknown>): Promise<void> {
    this.updatedViews.push({ viewId, view });
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
