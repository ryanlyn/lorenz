export interface SlackMessage {
  channel: string;
  ts: string;
  text: string;
  /** Every reaction name on the message, any author. Display only - never drives state. */
  reactions: string[];
  /**
   * Reaction names authored by the BOT itself (a subset of `reactions`). These are the only
   * reactions that carry meaning: the status mirror and the reaction-derived state fallback
   * read them, and a non-empty list is the bot's tracking marker. Human reactions are
   * deliberately excluded - humans transition status through `!`-command thread replies, and
   * a reaction from a random channel member must not silently move an issue. Derived from each
   * reaction's `users` list, which Slack may truncate on heavily-reacted messages; the thread
   * reply remains the authoritative state either way.
   */
  botReactions: string[];
  /** Author user id, when the API provided one. */
  user?: string | undefined;
  /** Number of thread replies under this message (root messages only). */
  replyCount?: number | undefined;
  /** ts of the newest thread reply (root messages only). */
  latestReply?: string | undefined;
}

/**
 * True when the bot itself has reacted to the message - its tracking marker. A bot-marked root
 * is (and stays) a tracked issue: reply-tracked threads are recognized across restarts by the
 * marker alone, and the tool trust boundary accepts a marked root even if the author allowlist
 * has since been tightened.
 */
export function isBotMarked(message: SlackMessage): boolean {
  return message.botReactions.length > 0;
}

/** A single reply in a Slack thread, excluding the parent (root) message. */
export interface SlackThreadReply {
  ts: string;
  text: string;
  user?: string;
  /** True when Slack marks the reply as bot-authored. */
  isBot?: boolean;
  /** True when Slack reports that the stored reply text was edited. */
  edited?: boolean;
}

/** One Slack API page of thread replies newer than an event cursor. */
export interface SlackThreadReplyPage {
  replies: SlackThreadReply[];
  /** Opaque Slack pagination cursor. Omitted when the thread page is complete. */
  nextCursor?: string;
}

/** Bounds and cancellation for one Slack thread-reply page. */
export interface SlackThreadReplyPageQuery {
  afterTs: string;
  limit: number;
  cursor?: string;
  abortSignal?: AbortSignal;
}

/** A workspace member, as resolved via `users.info`. */
export interface SlackUser {
  id: string;
  name?: string | undefined;
  realName?: string | undefined;
  displayName?: string | undefined;
  isBot?: boolean | undefined;
}

/** One pass over the watched channels' root messages. */
export interface SlackChannelScan {
  /** Root messages that mention the bot (tracked issues). */
  mentions: SlackMessage[];
  /** Non-mention root messages that carry a thread (candidates for reply-mention tracking). */
  threadedRoots: SlackMessage[];
}

export interface SlackTransport {
  // Note: there is no incremental, advancing `sinceTs` cursor. Each poll re-derives the scan from
  // either full history or a configured FIXED trailing window, bounded by MAX_HISTORY_PAGES, so
  // every issue inside the scanned range keeps re-surfacing rather than being skipped past.
  /** One paged pass over each channel's root messages, split into mentions and threaded roots. */
  scanChannels(channels: string[]): Promise<SlackChannelScan>;
  /** The mention half of {@link scanChannels}; kept for callers that need nothing else. */
  listMentions(channels: string[]): Promise<SlackMessage[]>;
  getMessage(channel: string, ts: string): Promise<SlackMessage | null>;
  /**
   * Base URL of the Slack workspace (e.g. `https://acme.slack.com`) for building message
   * permalinks, or `null` when it cannot be determined. Implementations cache the lookup.
   */
  teamUrl(): Promise<string | null>;
  /** Return the thread replies for the message at `ts`, EXCLUDING the parent (root) message. */
  getThread(channel: string, ts: string, abortSignal?: AbortSignal): Promise<SlackThreadReply[]>;
  /** Return one bounded page of replies newer than `afterTs`, excluding the thread root. */
  getThreadPage(
    channel: string,
    ts: string,
    query: SlackThreadReplyPageQuery,
  ): Promise<SlackThreadReplyPage>;
  /** Resolve a workspace member via `users.info`; `null` when unknown or unreadable. */
  getUser(userId: string): Promise<SlackUser | null>;
  /**
   * Channel messages around an anchor ts: up to `before` messages at-or-before the anchor and
   * `after` messages strictly after it, in ascending ts order. Read-only context window.
   */
  listAround(
    channel: string,
    ts: string,
    window: { before: number; after: number },
  ): Promise<SlackMessage[]>;
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  removeReaction(channel: string, ts: string, name: string): Promise<void>;
  postReply(channel: string, threadTs: string, body: string): Promise<void>;
}
