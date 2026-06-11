import { defaultStateType, normalizeIssue } from "@symphony/issue";
import type { Issue, IssueStateType, RuntimeTrackerClient, Settings } from "@symphony/domain";

import {
  isBotMention,
  stateFromReactions,
  statusEmojiMap,
  stripLeadingMention,
} from "./mapping.js";
import { slackTrackerOptions } from "./options.js";
import type { SlackMessage, SlackTransport } from "./transport.js";

export function splitIssueId(id: string): [string, string] | null {
  const idx = id.indexOf(":");
  if (idx === -1) return null;
  return [id.slice(0, idx), id.slice(idx + 1)];
}

/**
 * Derive labels from hashtag tokens in `text`: match `#tag`, strip the leading `#`, lowercase,
 * and dedupe (preserving first-seen order). Lets Slack issues carry plain routing/filter labels.
 *
 * The `#` must be at a boundary (start of string or preceded by whitespace) so in-token `#`s -
 * a URL fragment (`http://x#frag`) or a hex color (`color:#fff`) - do not leak in as bogus labels.
 *
 * Every mrkdwn angle-bracket token is stripped first: channel references (`<#C0ABC|general>`)
 * and user mentions (`<@U123|alice>`) embed an id behind `#`/`@`, and links (`<url|caption>`)
 * can carry a `#hashtag` inside their display caption - none of those are author-intended tags,
 * and a leaked one could even become a dispatch route.
 */
function deriveLabels(text: string): string[] {
  const stripped = text.replace(/<[^>]*>/g, " ");
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const match of stripped.matchAll(/(?<=^|\s)#([a-z0-9][a-z0-9_-]*)/gi)) {
    const label = match[1]!.toLowerCase();
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

/**
 * A flat, agent-facing view of a Slack issue derived from its source message. Shared by the
 * read tooling (`slack_query`) and {@link SlackTrackerClient.toIssue} so the two never drift on
 * how a message maps to a title/state/labels.
 */
export interface SlackIssueRow {
  /** `<channel>:<ts>` - the canonical Slack issue id. */
  issueId: string;
  channel: string;
  ts: string;
  /** First line of the message with the leading bot mention stripped (falls back to the ts). */
  title: string;
  /** Reaction-derived workflow state (e.g. "In Progress", "Done"), or "Todo" when none. */
  state: string;
  stateType: IssueStateType;
  labels: string[];
  /** Full message text. */
  text: string;
  reactions: string[];
  /** Permalink to the source message, when the workspace URL is known. */
  url?: string | undefined;
}

/**
 * Permalink to a message: `<workspace base>/archives/<channel>/p<ts without the dot>` - the
 * same shape Slack's own "copy link" produces.
 */
export function slackPermalink(base: string, channel: string, ts: string): string {
  return `${base.replace(/\/+$/, "")}/archives/${encodeURIComponent(channel)}/p${ts.replace(".", "")}`;
}

/**
 * Map a Slack message onto the flat {@link SlackIssueRow} view using the same status/title/label
 * derivation the tracker uses for candidate issues. Pure; performs no IO - callers that want a
 * permalink pass the workspace base URL (`SlackTransport.teamUrl()`).
 */
export function slackMessageToRow(
  message: SlackMessage,
  settings: Settings,
  permalinkBase?: string | null,
): SlackIssueRow {
  const map = statusEmojiMap(settings);
  const state = stateFromReactions(message.reactions, map, settings);
  const firstLine = (message.text.split("\n")[0] ?? "").trim();
  const title =
    stripLeadingMention(firstLine, slackTrackerOptions(settings).botUserId).trim() || message.ts;
  // normalizeIssue requires a stateType. Fall back to "backlog" for custom emoji_states mappings
  // whose state name is not a known category, so an unknown status never crashes the read.
  const stateType = defaultStateType(state) ?? "backlog";
  return {
    issueId: `${message.channel}:${message.ts}`,
    channel: message.channel,
    ts: message.ts,
    title,
    state,
    stateType,
    labels: deriveLabels(message.text),
    text: message.text,
    reactions: [...message.reactions],
    ...(permalinkBase ? { url: slackPermalink(permalinkBase, message.channel, message.ts) } : {}),
  };
}

/**
 * Map a Slack message onto a normalized tracker {@link Issue}. Shared by the runtime client
 * and the tracker tool operations so candidate discovery and agent tools never drift on how a
 * message becomes an issue. The identifier keeps the channel: Slack ts values are only unique
 * per channel, and workspace directories and cleanup are keyed by identifier downstream.
 */
export function slackMessageToIssue(
  message: SlackMessage,
  settings: Settings,
  permalinkBase?: string | null,
): Issue {
  const row = slackMessageToRow(message, settings, permalinkBase);
  const createdAtMs = Math.floor(Number.parseFloat(message.ts) * 1000);
  return normalizeIssue({
    id: row.issueId,
    identifier: `SLK-${message.channel}-${message.ts.replace(/\./g, "-")}`,
    title: row.title,
    description: message.text,
    state: row.state,
    state_type: row.stateType,
    labels: row.labels,
    ...(row.url !== undefined ? { url: row.url } : {}),
    ...(Number.isFinite(createdAtMs) ? { created_at: new Date(createdAtMs).toISOString() } : {}),
    raw: message,
  });
}

/**
 * One mention scan serves every read within a poll cycle: the runtime triggers two
 * back-to-back full scans per cycle (terminal-state reconciliation, then candidates), and each
 * scan pages the full channel history against a tightly rate-limited API. Comfortably shorter
 * than any real poll interval, so cross-poll staleness stays bounded.
 */
const MENTIONS_CACHE_TTL_MS = 10_000;

export class SlackTrackerClient implements RuntimeTrackerClient {
  private mentionsCache: { at: number; key: string; messages: SlackMessage[] } | null = null;

  constructor(
    private readonly settings: Settings,
    private readonly transport: SlackTransport,
  ) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssuesByStates(this.settings.tracker.activeStates);
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const channels = new Set(this.channels());
    const botUserId = slackTrackerOptions(this.settings).botUserId;
    const base = await this.transport.teamUrl();
    const out: Issue[] = [];
    for (const id of ids) {
      const parts = splitIssueId(id);
      if (!parts) continue;
      const [channel, ts] = parts;
      // Apply the same tracked-message predicate as candidate discovery and the Slack write tools:
      // only configured channels, and only messages that still mention the bot. If a human edits the
      // source message to drop the mention, the issue reconciles as gone instead of staying live.
      if (!channels.has(channel)) continue;
      const msg = await this.transport.getMessage(channel, ts);
      if (!msg) continue;
      if (!isBotMention(msg.text, botUserId)) continue;
      out.push(slackMessageToIssue(msg, this.settings, base));
    }
    return out;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const wanted = new Set(states.map((s) => s.trim().toLowerCase()));
    const issues = await this.allMentionIssues();
    return issues.filter((i) => wanted.has(i.state.trim().toLowerCase()));
  }

  private async allMentionIssues(): Promise<Issue[]> {
    const [messages, base] = await Promise.all([
      this.listMentionsCached(),
      this.transport.teamUrl(),
    ]);
    return messages.map((m) => slackMessageToIssue(m, this.settings, base));
  }

  private async listMentionsCached(): Promise<SlackMessage[]> {
    const key = this.channels().join(",");
    const now = Date.now();
    if (
      this.mentionsCache &&
      this.mentionsCache.key === key &&
      now - this.mentionsCache.at < MENTIONS_CACHE_TTL_MS
    ) {
      return this.mentionsCache.messages;
    }
    const messages = await this.transport.listMentions(this.channels());
    this.mentionsCache = { at: Date.now(), key, messages };
    return messages;
  }

  private channels(): string[] {
    return slackTrackerOptions(this.settings).channels;
  }
}
