export interface SlackMessage {
  channel: string;
  ts: string;
  text: string;
  reactions: string[];
  /** Author user id, when the API provided one. */
  user?: string | undefined;
  /** Number of thread replies under this message (root messages only). */
  replyCount?: number | undefined;
  /** ts of the newest thread reply (root messages only). */
  latestReply?: string | undefined;
  /** True when the bot itself has reacted to this message (its tracking marker). */
  botReacted?: boolean | undefined;
}

/** A single reply in a Slack thread, excluding the parent (root) message. */
export interface SlackThreadReply {
  ts: string;
  text: string;
  user?: string;
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
  // Note: there is no incremental `sinceTs` watermark. Polling re-derives the scan from the
  // active window each loop; pagination is bounded by MAX_HISTORY_PAGES, not a time cursor.
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
  getThread(channel: string, ts: string): Promise<SlackThreadReply[]>;
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
