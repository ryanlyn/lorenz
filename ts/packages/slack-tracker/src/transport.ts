export interface SlackMessage {
  channel: string;
  ts: string;
  text: string;
  reactions: string[];
}

export interface SlackTransport {
  listMentions(channels: string[], opts?: { sinceTs?: string }): Promise<SlackMessage[]>;
  getMessage(channel: string, ts: string): Promise<SlackMessage | null>;
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  removeReaction(channel: string, ts: string, name: string): Promise<void>;
  postReply(channel: string, threadTs: string, body: string): Promise<void>;
}
