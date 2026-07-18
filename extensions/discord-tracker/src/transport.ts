export interface DiscordReaction {
  /** Unicode emoji, or `name:id` for a custom guild emoji. */
  emoji: string;
  /** Whether the authenticated bot owns this reaction. */
  me: boolean;
}

export interface DiscordMessage {
  id: string;
  channelId: string;
  guildId?: string | undefined;
  content: string;
  timestamp: string;
  authorId?: string | undefined;
  authorName?: string | undefined;
  authorBot: boolean;
  mentionUserIds: string[];
  /** Role ids mentioned by the message. */
  mentionRoleIds: string[];
  /** Guild role ids Discord reports as managed by the configured bot. */
  botRoleIds: string[];
  reactions: DiscordReaction[];
  /** Discord reports an attached native thread whose id equals this message id. */
  hasThread: boolean;
  /** Latest thread message id when Discord includes thread metadata on the source message. */
  threadLastMessageId?: string | undefined;
}

export interface DiscordUser {
  id: string;
  username: string;
  globalName?: string | null | undefined;
  bot?: boolean | undefined;
}

export interface DiscordChannelScan {
  mentions: DiscordMessage[];
}

export interface DiscordTransport {
  scanChannels(channels: string[]): Promise<DiscordChannelScan>;
  getMessage(channelId: string, messageId: string): Promise<DiscordMessage | null>;
  getThread(messageId: string): Promise<DiscordMessage[]>;
  ensureThread(root: DiscordMessage, name: string): Promise<string>;
  postThreadMessage(threadId: string, body: string): Promise<void>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  getUser(userId: string): Promise<DiscordUser | null>;
  listAround(
    channelId: string,
    messageId: string,
    window: { before: number; after: number },
  ): Promise<DiscordMessage[]>;
}
