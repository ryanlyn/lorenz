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
  /**
   * Set by the channel mirror after it has observed a thread-derived status transition. Reaction
   * fallback stays disabled if that transition is later deleted during reconciliation, so the
   * bot's derived visibility reaction cannot become authoritative.
   */
  threadEventsObserved?: boolean | undefined;
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

/**
 * Slack message metadata (`metadata.event_type` / `metadata.event_payload`) on a bot post.
 * Metadata can only be attached by the app that posted the message, so a metadata-bearing reply
 * whose author is the bot is machine-readable state that neither a human nor another app can
 * forge - the fold prefers it over parsing the reply text.
 */
export interface SlackMessageMetadata {
  eventType: string;
  payload: Record<string, unknown>;
}

/** `event_type` of the bot's authoritative status replies (see operations.ts). */
export const STATUS_METADATA_EVENT = "lorenz_status";
/** `event_type` of the bot's per-issue workpad message (see workpad.ts). */
export const WORKPAD_METADATA_EVENT = "lorenz_workpad";

/** A single reply in a Slack thread, excluding the parent (root) message. */
export interface SlackThreadReply {
  ts: string;
  text: string;
  user?: string;
  /** Slack message subtype, when present. Only `thread_broadcast` is steering-eligible. */
  subtype?: string;
  /** True when Slack marks the reply as bot-authored. */
  isBot?: boolean;
  /** True when Slack reports that the stored reply text was edited. */
  edited?: boolean;
  /** Message metadata when present (bot posts carry machine-readable state here). */
  metadata?: SlackMessageMetadata | undefined;
  /**
   * Set by the channel mirror: the text this reply had when FIRST observed. Human `!` command
   * classification uses this (first-seen wins), so a later edit cannot retroactively rewrite a
   * folded transition. Absent on API-served replies (Slack cannot return pre-edit text).
   */
  firstSeenText?: string | undefined;
  /**
   * Set by the channel mirror: the reply was deleted after being observed. Tombstoned replies
   * keep their folded role for the daemon session (a deleted `!done` does not silently re-open
   * the issue) and are dropped at the next reconciliation, where the substrate has forgotten
   * them. Also excluded from steering context.
   */
  deleted?: boolean | undefined;
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
  /**
   * Post a thread reply and return its ts. `options.metadata` attaches machine-readable message
   * metadata AND upgrades the delivery contract: a metadata-bearing post that fails ambiguously
   * (5xx/network after the request was sent) is reconciled against the thread by its unique
   * metadata marker instead of being reported failed - exactly-once, where a bare post can only
   * promise at-most-once. `options.blocks` attaches Block Kit blocks with `body` as fallback.
   * Every body is broadcast-sanitized (see sanitize.ts).
   */
  postReply(
    channel: string,
    threadTs: string,
    body: string,
    options?: SlackPostOptions,
  ): Promise<string>;
  /**
   * Edit a previously posted bot message in place (`chat.update`). Used only for display
   * mirrors (the workpad); never for fold events, which are append-only.
   */
  updateMessage(
    channel: string,
    ts: string,
    body: string,
    options?: SlackPostOptions,
  ): Promise<void>;
  /** Post an ephemeral message visible only to `user`, threaded under `threadTs`. */
  postEphemeral(channel: string, user: string, threadTs: string, body: string): Promise<void>;
  /**
   * Open a modal for the interaction identified by `triggerId` and return its view id when Slack
   * supplies one. Trigger ids are valid for only a few seconds.
   */
  openView(triggerId: string, view: Record<string, unknown>): Promise<string | null>;
  /** Replace the contents of an already-open modal. */
  updateView(viewId: string, view: Record<string, unknown>): Promise<void>;
}

/** Optional attachments for a bot write (see {@link SlackTransport.postReply}). */
export interface SlackPostOptions {
  metadata?: SlackMessageMetadata | undefined;
  blocks?: unknown[] | undefined;
}
