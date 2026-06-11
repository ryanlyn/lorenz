export interface SlackMessage {
  channel: string;
  ts: string;
  text: string;
  reactions: string[];
}

/** A single reply in a Slack thread, excluding the parent (root) message. */
export interface SlackThreadReply {
  ts: string;
  text: string;
  user?: string;
}

export interface SlackTransport {
  // Note: there is no incremental `sinceTs` watermark. Polling re-derives mentions from the
  // active window each loop; pagination is bounded by MAX_HISTORY_PAGES, not a time cursor.
  listMentions(channels: string[]): Promise<SlackMessage[]>;
  getMessage(channel: string, ts: string): Promise<SlackMessage | null>;
  /** Return the thread replies for the message at `ts`, EXCLUDING the parent (root) message. */
  getThread(channel: string, ts: string): Promise<SlackThreadReply[]>;
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  removeReaction(channel: string, ts: string, name: string): Promise<void>;
  postReply(channel: string, threadTs: string, body: string): Promise<void>;
}
