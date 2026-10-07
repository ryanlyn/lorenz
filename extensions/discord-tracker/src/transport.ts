export interface DiscordReaction {
  /** Unicode emoji, or `name:id` for a custom guild emoji. */
  emoji: string;
  /** Whether the authenticated bot owns this reaction. */
  me: boolean;
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  title?: string | undefined;
  description?: string | undefined;
  contentType?: string | undefined;
  size: number;
}

export interface DiscordAttachmentRead {
  attachment: DiscordAttachment;
  body: Uint8Array;
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
  attachments: DiscordAttachment[];
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

export interface DiscordApplicationCommandOptionChoice {
  name: string;
  value: string;
}

export interface DiscordApplicationCommandOption {
  type: number;
  name: string;
  description: string;
  required?: boolean | undefined;
  choices?: DiscordApplicationCommandOptionChoice[] | undefined;
}

export interface DiscordApplicationCommand {
  type: number;
  name: string;
  description?: string | undefined;
  options?: DiscordApplicationCommandOption[] | undefined;
}

export interface DiscordInteraction {
  id: string;
  applicationId: string;
  token: string;
  type: "command" | "component";
  guildId: string;
  channelId: string;
  userId: string;
  userBot: boolean;
  commandName?: string | undefined;
  commandOptions?: Record<string, string> | undefined;
  customId?: string | undefined;
  componentValues?: string[] | undefined;
  targetId?: string | undefined;
}

export interface DiscordInteractionResult {
  title: string;
  description: string;
  color: number;
}

export interface DiscordWorkpad {
  environment: string;
  plan: string[];
  acceptanceCriteria: string[];
  validationCommands: string[];
  progress: string[];
}

export interface DiscordTransport {
  scanChannels(channels: string[]): Promise<DiscordChannelScan>;
  getMessage(channelId: string, messageId: string): Promise<DiscordMessage | null>;
  getThread(messageId: string): Promise<DiscordMessage[]>;
  getChannelParent(channelId: string): Promise<string | null>;
  ensureThread(root: DiscordMessage, name: string): Promise<string>;
  postThreadMessage(threadId: string, body: string): Promise<void>;
  postWorkpad(threadId: string, workpad: DiscordWorkpad): Promise<string>;
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  getUser(userId: string): Promise<DiscordUser | null>;
  registerApplicationCommands(commands: DiscordApplicationCommand[]): Promise<void>;
  deferInteraction(interactionId: string, interactionToken: string): Promise<void>;
  completeInteraction(
    applicationId: string,
    interactionToken: string,
    result: DiscordInteractionResult,
  ): Promise<void>;
  listAround(
    channelId: string,
    messageId: string,
    window: { before: number; after: number },
  ): Promise<DiscordMessage[]>;
  readAttachment(
    channelId: string,
    messageId: string,
    attachmentId?: string,
  ): Promise<DiscordAttachmentRead>;
}

export function selectDiscordAttachment(
  message: DiscordMessage,
  attachmentId: string | undefined,
): DiscordAttachment {
  if (attachmentId) {
    const attachment = message.attachments.find((candidate) => candidate.id === attachmentId);
    if (!attachment) {
      throw new Error(
        `attachment ${attachmentId} does not belong to Discord message ${message.id}`,
      );
    }
    return attachment;
  }
  if (message.attachments.length === 0) {
    throw new Error(`Discord message ${message.id} has no attachments`);
  }
  if (message.attachments.length > 1) {
    throw new Error(`attachmentId is required for Discord message ${message.id}`);
  }
  return message.attachments[0]!;
}
