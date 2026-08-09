import { selectDiscordAttachment } from "./transport.js";
import type {
  DiscordApplicationCommand,
  DiscordAttachmentRead,
  DiscordChannelScan,
  DiscordInteractionResult,
  DiscordMessage,
  DiscordTransport,
  DiscordUser,
  DiscordWorkpad,
} from "./transport.js";

/** Deterministic transport for tracker and tool tests. */
export class InMemoryDiscordTransport implements DiscordTransport {
  readonly postedMessages: Array<{ threadId: string; body: string }> = [];
  readonly addedReactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  readonly removedReactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  readonly createdThreads: string[] = [];
  readonly postedWorkpads: Array<{ threadId: string; messageId: string; workpad: DiscordWorkpad }> =
    [];
  readonly registeredCommands: DiscordApplicationCommand[] = [];
  readonly deferredInteractions: Array<{ interactionId: string; interactionToken: string }> = [];
  readonly completedInteractions: Array<{
    applicationId: string;
    interactionToken: string;
    result: DiscordInteractionResult;
  }> = [];
  readonly attachmentBodies = new Map<string, Uint8Array>();

  constructor(
    readonly messages: DiscordMessage[] = [],
    readonly threads = new Map<string, DiscordMessage[]>(),
    readonly users = new Map<string, DiscordUser>(),
  ) {}

  async scanChannels(channels: string[]): Promise<DiscordChannelScan> {
    return Promise.resolve({
      mentions: this.messages.filter((message) => channels.includes(message.channelId)),
    });
  }

  async getMessage(channelId: string, messageId: string): Promise<DiscordMessage | null> {
    return Promise.resolve(
      this.messages.find(
        (message) => message.channelId === channelId && message.id === messageId,
      ) ??
        this.threads.get(channelId)?.find((message) => message.id === messageId) ??
        null,
    );
  }

  async getThread(messageId: string): Promise<DiscordMessage[]> {
    return Promise.resolve([...(this.threads.get(messageId) ?? [])]);
  }

  async readAttachment(
    channelId: string,
    messageId: string,
    attachmentId?: string,
  ): Promise<DiscordAttachmentRead> {
    const message = await this.getMessage(channelId, messageId);
    if (!message) throw new Error(`message ${messageId} does not belong to this Discord issue`);
    const attachment = selectDiscordAttachment(message, attachmentId);
    const body = this.attachmentBodies.get(attachment.id);
    if (!body) throw new Error(`missing in-memory Discord attachment: ${attachment.id}`);
    return { attachment, body: body.slice() };
  }

  async getChannelParent(channelId: string): Promise<string | null> {
    const root = this.messages.find((message) => message.id === channelId && message.hasThread);
    return Promise.resolve(root?.channelId ?? null);
  }

  async ensureThread(root: DiscordMessage): Promise<string> {
    if (!root.hasThread) {
      root.hasThread = true;
      this.threads.set(root.id, []);
      this.createdThreads.push(root.id);
    }
    return Promise.resolve(root.id);
  }

  async postThreadMessage(threadId: string, body: string): Promise<void> {
    this.postedMessages.push({ threadId, body });
    return Promise.resolve();
  }

  async postWorkpad(threadId: string, workpad: DiscordWorkpad): Promise<string> {
    const messageId = String(900000000000000000n + BigInt(this.postedWorkpads.length));
    this.postedWorkpads.push({ threadId, messageId, workpad });
    return Promise.resolve(messageId);
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.addedReactions.push({ channelId, messageId, emoji });
    const message = await this.getMessage(channelId, messageId);
    if (message && !message.reactions.some((reaction) => reaction.emoji === emoji && reaction.me)) {
      message.reactions.push({ emoji, me: true });
    }
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    this.removedReactions.push({ channelId, messageId, emoji });
    const message = await this.getMessage(channelId, messageId);
    if (message) {
      message.reactions = message.reactions.filter(
        (reaction) => reaction.emoji !== emoji || !reaction.me,
      );
    }
  }

  async getUser(userId: string): Promise<DiscordUser | null> {
    return Promise.resolve(this.users.get(userId) ?? null);
  }

  async registerApplicationCommands(commands: DiscordApplicationCommand[]): Promise<void> {
    this.registeredCommands.splice(0, this.registeredCommands.length, ...commands);
    return Promise.resolve();
  }

  async deferInteraction(interactionId: string, interactionToken: string): Promise<void> {
    this.deferredInteractions.push({ interactionId, interactionToken });
    return Promise.resolve();
  }

  async completeInteraction(
    applicationId: string,
    interactionToken: string,
    result: DiscordInteractionResult,
  ): Promise<void> {
    this.completedInteractions.push({ applicationId, interactionToken, result });
    return Promise.resolve();
  }

  async listAround(
    channelId: string,
    messageId: string,
    window: { before: number; after: number },
  ): Promise<DiscordMessage[]> {
    const ordered = this.messages
      .filter((message) => message.channelId === channelId)
      .toSorted((left, right) => left.id.localeCompare(right.id));
    const anchor = ordered.findIndex((message) => message.id === messageId);
    if (anchor === -1) return Promise.resolve([]);
    return Promise.resolve(
      ordered.slice(
        Math.max(0, anchor - window.before),
        Math.min(ordered.length, anchor + window.after + 1),
      ),
    );
  }
}
