import { defaultStateType, normalizeIssue } from "@symphony/issue";
import type { Issue, RuntimeTrackerClient, Settings } from "@symphony/domain";

import { stateFromReactions, statusEmojiMap, stripLeadingMention } from "./mapping.js";
import type { SlackMessage, SlackTransport } from "./transport.js";

export function splitIssueId(id: string): [string, string] | null {
  const idx = id.indexOf(":");
  if (idx === -1) return null;
  return [id.slice(0, idx), id.slice(idx + 1)];
}

/**
 * Derive labels from hashtag tokens in `text`: match `#tag`, strip the leading `#`, lowercase,
 * and dedupe (preserving first-seen order). Lets Slack issues carry plain routing/filter labels.
 */
export function deriveLabels(text: string): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/#([a-z0-9][a-z0-9_-]*)/gi)) {
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
    const out: Issue[] = [];
    for (const id of ids) {
      const parts = splitIssueId(id);
      if (!parts) continue;
      const msg = await this.transport.getMessage(parts[0], parts[1]);
      if (msg) out.push(this.toIssue(msg));
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
    const stateType = defaultStateType(state);
    return normalizeIssue({
      id: `${message.channel}:${message.ts}`,
      identifier: `SLK-${message.ts.replace(/\./g, "-")}`,
      title,
      description: message.text,
      state,
      ...(stateType ? { state_type: stateType } : {}),
      labels: deriveLabels(message.text),
      raw: message,
    });
  }
}
