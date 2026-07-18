import type {
  Issue,
  IssueStateType,
  RuntimeTrackerClient,
  Settings,
  TrackerChangeStream,
} from "@lorenz/domain";
import { defaultStateType, normalizeIssue } from "@lorenz/issue";

import { DiscordGatewayChangeStream, type DiscordGatewayOptions } from "./gateway.js";
import {
  emojiForState,
  isAllowedAuthor,
  isBotMention,
  statusEmojiMap,
  stripLeadingMention,
} from "./mapping.js";
import { mirrorStatusReaction } from "./operations.js";
import { discordTrackerOptions } from "./options.js";
import { stateFromThread } from "./threadState.js";
import type { DiscordMessage, DiscordTransport } from "./transport.js";

export function splitIssueId(id: string): [string, string] | null {
  const parts = id.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!isDiscordSnowflake(parts[0]) || !isDiscordSnowflake(parts[1])) return null;
  return [parts[0], parts[1]];
}

export function isDiscordSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value);
}

function deriveLabels(text: string): string[] {
  const withoutDiscordTokens = text.replace(/<[^>]*>/g, " ");
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const match of withoutDiscordTokens.matchAll(/(?<=^|\s)#([a-z0-9][a-z0-9_-]*)/gi)) {
    const label = match[1]!.toLowerCase();
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

export interface DiscordIssueRow {
  issueId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  title: string;
  state: string;
  stateType: IssueStateType;
  labels: string[];
  text: string;
  reactions: string[];
  url: string;
}

export function discordPermalink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${encodeURIComponent(guildId)}/${encodeURIComponent(channelId)}/${encodeURIComponent(messageId)}`;
}

export function discordMessageToRow(
  message: DiscordMessage,
  settings: Settings,
  state: string,
): DiscordIssueRow {
  const tracker = discordTrackerOptions(settings);
  const guildId = tracker.guildId ?? message.guildId ?? "@me";
  const firstLine = (message.content.split("\n")[0] ?? "").trim();
  const title =
    stripLeadingMention(firstLine, tracker.botUserId, message.botRoleIds).trim() || message.id;
  return {
    issueId: `${message.channelId}:${message.id}`,
    guildId,
    channelId: message.channelId,
    messageId: message.id,
    title,
    state,
    stateType: defaultStateType(state) ?? "backlog",
    labels: deriveLabels(message.content),
    text: message.content,
    reactions: message.reactions.map((reaction) => reaction.emoji),
    url: discordPermalink(guildId, message.channelId, message.id),
  };
}

export function discordMessageToIssue(
  message: DiscordMessage,
  settings: Settings,
  state: string,
): Issue {
  const row = discordMessageToRow(message, settings, state);
  return normalizeIssue({
    id: row.issueId,
    identifier: `DSC-${message.channelId}-${message.id}`,
    title: row.title,
    description: message.content,
    state: row.state,
    state_type: row.stateType,
    labels: row.labels,
    url: row.url,
    created_at: message.timestamp,
    raw: message,
  });
}

const SCAN_CACHE_TTL_MS = 10_000;
const THREAD_STATE_CACHE_TTL_MS = 5 * 60_000;
const THREAD_STATE_CACHE_MAX = 5_000;
const MIRRORED_STATES_MAX = 5_000;

interface DiscordGatewayStream extends TrackerChangeStream {
  start(): void;
}

export class DiscordTrackerClient implements RuntimeTrackerClient {
  private scanCache: { at: number; key: string; messages: DiscordMessage[] } | null = null;
  private readonly trackedThreadIds = new Set<string>();
  private readonly threadStateCache = new Map<
    string,
    { at: number; version: string; state: string }
  >();
  private readonly mirroredStates = new Map<string, string>();
  private mirrorHealQueue: Promise<void> = Promise.resolve();
  private scanGeneration = 0;

  constructor(
    private readonly settings: Settings,
    private readonly transport: DiscordTransport,
    private readonly createGateway: (options: DiscordGatewayOptions) => DiscordGatewayStream = (
      options,
    ) => new DiscordGatewayChangeStream(options),
  ) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssuesByStates(this.settings.tracker.activeStates);
  }

  async acknowledgeIssue(issue: Issue): Promise<boolean> {
    const firstActive = this.settings.tracker.activeStates[0];
    if (!firstActive || issue.state.trim().toLowerCase() !== firstActive.trim().toLowerCase()) {
      return false;
    }
    const target =
      this.settings.tracker.activeStates.find(
        (state) => state.trim().toLowerCase() === "in progress",
      ) ??
      this.settings.tracker.activeStates.find(
        (state) => state.trim().toLowerCase() !== firstActive.trim().toLowerCase(),
      );
    if (!target) return false;
    const emoji = emojiForState(target, statusEmojiMap(this.settings));
    if (!emoji) return false;
    const parts = splitIssueId(issue.id);
    if (!parts) throw new Error(`invalid Discord issue id '${issue.id}'`);
    await this.transport.addReaction(parts[0], parts[1], emoji);
    return true;
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const out: Issue[] = [];
    const tracker = discordTrackerOptions(this.settings);
    for (const id of ids) {
      const parts = splitIssueId(id);
      if (!parts || !tracker.channels.includes(parts[0])) continue;
      const message = await this.transport.getMessage(parts[0], parts[1]);
      if (
        !message ||
        message.channelId !== parts[0] ||
        message.id !== parts[1] ||
        !this.isTracked(message)
      ) {
        continue;
      }
      out.push(await this.toIssue(message, false));
    }
    return out;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    const wanted = new Set(states.map((state) => state.trim().toLowerCase()));
    const messages = await this.scanCached();
    const out: Issue[] = [];
    for (const message of messages) {
      const issue = await this.toIssue(message);
      if (wanted.has(issue.state.trim().toLowerCase())) out.push(issue);
    }
    return out;
  }

  watch(onChange: () => void): TrackerChangeStream | null {
    const tracker = discordTrackerOptions(this.settings);
    const token = this.settings.tracker.apiKey;
    if (!token || !tracker.guildId || tracker.channels.length === 0) return null;
    const stream = this.createGateway({
      token,
      guildId: tracker.guildId,
      botUserId: tracker.botUserId ?? "",
      channels: new Set(tracker.channels),
      trackedThreadIds: this.trackedThreadIds,
      onChange: () => {
        this.scanGeneration += 1;
        this.scanCache = null;
        this.threadStateCache.clear();
        onChange();
      },
    });
    stream.start();
    return stream;
  }

  private async toIssue(message: DiscordMessage, useThreadCache = true): Promise<Issue> {
    this.trackedThreadIds.add(message.id);
    const cacheKey = `${message.channelId}:${message.id}`;
    const version = threadStateVersion(message);
    const cached = version === null ? undefined : this.threadStateCache.get(cacheKey);
    let state: string;
    if (
      useThreadCache &&
      cached &&
      cached.version === version &&
      Date.now() - cached.at < THREAD_STATE_CACHE_TTL_MS
    ) {
      state = cached.state;
    } else {
      const thread = message.hasThread ? await this.transport.getThread(message.id) : [];
      state = stateFromThread(message, thread, this.settings);
      if (version !== null) {
        if (this.threadStateCache.size >= THREAD_STATE_CACHE_MAX) this.threadStateCache.clear();
        this.threadStateCache.set(cacheKey, { at: Date.now(), version, state });
      }
    }
    this.healStatusMirror(message, state);
    return discordMessageToIssue(message, this.settings, state);
  }

  private healStatusMirror(root: DiscordMessage, state: string): void {
    const key = `${root.channelId}:${root.id}`;
    if (this.mirroredStates.get(key) === state) return;
    if (this.mirroredStates.size >= MIRRORED_STATES_MAX) this.mirroredStates.clear();
    this.mirroredStates.set(key, state);

    const map = statusEmojiMap(this.settings);
    const target = emojiForState(state, map);
    const owned = root.reactions
      .filter((reaction) => reaction.me)
      .map((reaction) => reaction.emoji);
    const staleManaged = owned.some(
      (reaction) => typeof map[reaction] === "string" && reaction !== target,
    );
    const missingTarget = target !== null && !owned.includes(target);
    if (!staleManaged && !missingTarget) return;

    const observed = {
      ...root,
      reactions: root.reactions.map((reaction) => ({ ...reaction })),
    };
    this.mirrorHealQueue = this.mirrorHealQueue.then(async () => {
      try {
        await mirrorStatusReaction(this.settings, this.transport, observed, state);
      } catch {
        // Keep the queue usable if an unexpected transport implementation rejects.
      }
    });
  }

  async flushStatusMirrorHeals(): Promise<void> {
    await this.mirrorHealQueue;
  }

  private isTracked(message: DiscordMessage): boolean {
    const tracker = discordTrackerOptions(this.settings);
    return isBotMention(message, tracker.botUserId) && isAllowedAuthor(message, tracker.users);
  }

  private async scanCached(): Promise<DiscordMessage[]> {
    const channels = discordTrackerOptions(this.settings).channels;
    const key = channels.join(",");
    const now = Date.now();
    if (
      this.scanCache &&
      this.scanCache.key === key &&
      now - this.scanCache.at < SCAN_CACHE_TTL_MS
    ) {
      return this.scanCache.messages;
    }
    const generation = this.scanGeneration;
    const scan = await this.transport.scanChannels(channels);
    const mentions = scan.mentions.filter((message) => this.isTracked(message));
    for (const message of mentions) this.trackedThreadIds.add(message.id);
    if (generation === this.scanGeneration) {
      this.scanCache = { at: Date.now(), key, messages: mentions };
    }
    return mentions;
  }
}

function threadStateVersion(message: DiscordMessage): string | null {
  if (!message.hasThread || !message.threadLastMessageId) return null;
  const botReactions = message.reactions
    .filter((reaction) => reaction.me)
    .map((reaction) => reaction.emoji)
    .sort()
    .join(",");
  return `${message.threadLastMessageId}:${botReactions}`;
}
