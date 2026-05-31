import { defaultStateType, normalizeIssue } from "@symphony/issue";
import type { Issue, RuntimeTrackerClient, Settings } from "@symphony/domain";

import { isBotMention, stateFromReactions, statusEmojiMap, stripLeadingMention } from "./mapping.js";
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
 * Slack channel references (`<#C0ABC|general>`) and user mentions (`<@U123|alice>`) embed an
 * id behind `#`/`@` inside angle brackets; those are stripped first so they cannot leak in as
 * bogus labels (e.g. `c0abc`).
 */
export function deriveLabels(text: string): string[] {
  const stripped = text.replace(/<[#@][^>]*>/g, " ");
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

export class SlackTrackerClient implements RuntimeTrackerClient {
  constructor(
    private readonly settings: Settings,
    private readonly transport: SlackTransport,
  ) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    const issues = (await this.transport.listMentions(this.channels())).map((m) => this.toIssue(m));
    const active = new Set(this.settings.tracker.activeStates.map((s) => s.trim().toLowerCase()));
    return issues.filter((i) => active.has(i.state.trim().toLowerCase()));
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const channels = new Set(this.channels());
    const botUserId = this.settings.tracker.botUserId;
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
      out.push(this.toIssue(msg));
    }
    return out;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const wanted = new Set(states.map((s) => s.trim().toLowerCase()));
    const issues = (await this.transport.listMentions(this.channels())).map((m) => this.toIssue(m));
    return issues.filter((i) => wanted.has(i.state.trim().toLowerCase()));
  }

  private channels(): string[] {
    return this.settings.tracker.channels ?? [];
  }

  private toIssue(message: SlackMessage): Issue {
    const state = stateFromReactions(message.reactions, statusEmojiMap(this.settings));
    const firstLine = (message.text.split("\n")[0] ?? "").trim();
    const title =
      stripLeadingMention(firstLine, this.settings.tracker.botUserId).trim() || message.ts;
    // normalizeIssue requires a stateType. Fall back to "backlog" for custom emoji_states
    // mappings whose state name is not a known category, so they never crash the read.
    const stateType = defaultStateType(state) ?? "backlog";
    return normalizeIssue({
      id: `${message.channel}:${message.ts}`,
      identifier: `SLK-${message.ts.replace(/\./g, "-")}`,
      title,
      description: message.text,
      state,
      state_type: stateType,
      labels: deriveLabels(message.text),
      raw: message,
    });
  }
}
