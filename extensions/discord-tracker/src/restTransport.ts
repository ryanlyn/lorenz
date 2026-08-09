import type { APIChannel, APIMessage, APIRole, APIUser } from "discord-api-types/v10";
import { errorMessage, type Settings } from "@lorenz/domain";

import { isAllowedAuthor, isBotMarked, isBotMention } from "./mapping.js";
import { discordEndpoint, discordTrackerOptions } from "./options.js";
import { selectDiscordAttachment } from "./transport.js";
import type {
  DiscordAttachmentRead,
  DiscordApplicationCommand,
  DiscordChannelScan,
  DiscordInteractionResult,
  DiscordMessage,
  DiscordTransport,
  DiscordUser,
  DiscordWorkpad,
} from "./transport.js";
import { workpadMessage } from "./workpad.js";

const MAX_HISTORY_PAGES = 500;
const MAX_THREAD_PAGES = 100;
const MAX_RETRIES = 4;
const MAX_RETRY_DELAY_MS = 60_000;
const RESPONSE_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const ATTACHMENT_BODY_LIMIT_BYTES = RESPONSE_BODY_LIMIT_BYTES;
const SECONDS_PER_DAY = 86_400;

const DISCORD_USER_AGENT = "DiscordBot (https://github.com/ryanlyn/lorenz, 0.1.1)";

type Sleep = (delayMs: number) => Promise<void>;

const defaultSleep: Sleep = async (delayMs) =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

export interface DiscordTrackerLogger {
  warn(message: string): void;
}

export interface DiscordRestTransportOptions {
  maxHistoryPages?: number | undefined;
  maxThreadPages?: number | undefined;
  scanLookbackDays?: number | undefined;
  now?: (() => number) | undefined;
}

export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly responseBody: unknown,
  ) {
    super(`discord ${method} ${path} failed: status ${status}${discordErrorSuffix(responseBody)}`);
    this.name = "DiscordApiError";
  }
}

export class DiscordRestTransport implements DiscordTransport {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly guildId: string | undefined;
  private readonly botUserId: string | undefined;
  private readonly markerEmoji: string;
  private readonly allowedUsers: string[];
  private readonly maxHistoryPages: number;
  private readonly maxThreadPages: number;
  private readonly scanLookbackDays: number;
  private readonly now: () => number;
  private globalRateLimitUntil = 0;
  private warnedNoBotUserId = false;
  private botRoleIdsRequest: Promise<string[]> | null = null;

  constructor(
    private readonly settings: Settings,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: Sleep = defaultSleep,
    private readonly logger: DiscordTrackerLogger = { warn: (message) => console.warn(message) },
    options: DiscordRestTransportOptions = {},
  ) {
    this.endpoint = discordEndpoint(settings);
    this.token = settings.tracker.apiKey ?? "";
    const tracker = discordTrackerOptions(settings);
    this.guildId = tracker.guildId;
    this.botUserId = tracker.botUserId;
    this.markerEmoji = tracker.markerEmoji;
    this.allowedUsers = tracker.users;
    this.maxHistoryPages = options.maxHistoryPages ?? MAX_HISTORY_PAGES;
    this.maxThreadPages = options.maxThreadPages ?? MAX_THREAD_PAGES;
    this.scanLookbackDays = options.scanLookbackDays ?? tracker.scanLookbackDays ?? 0;
    this.now = options.now ?? Date.now;
  }

  async scanChannels(channels: string[]): Promise<DiscordChannelScan> {
    if (!this.botUserId || this.botUserId.trim() === "") {
      if (!this.warnedNoBotUserId) {
        this.warnedNoBotUserId = true;
        this.logger.warn(
          "discord tracker: bot_user_id (DISCORD_BOT_USER_ID) is not set; refusing to scan " +
            "mentions so unrelated messages cannot become issues",
        );
      }
      return { mentions: [] };
    }

    const results = await Promise.all(
      channels.map(async (channelId) => {
        try {
          return { channelId, messages: await this.scanChannel(channelId) };
        } catch (error) {
          const message = errorMessage(error);
          this.logger.warn(
            `discord tracker: channel ${channelId} scan failed before completing; discarding ` +
              `its partial results this poll: ${message}`,
          );
          return { channelId, failure: message };
        }
      }),
    );

    const mentions: DiscordMessage[] = [];
    const failures: string[] = [];
    for (const result of results) {
      if ("messages" in result) mentions.push(...result.messages);
      else failures.push(`${result.channelId}: ${result.failure}`);
    }
    if (channels.length > 0 && failures.length === channels.length) {
      throw new Error(`discord channel history failed for all channels: ${failures.join("; ")}`);
    }
    return { mentions };
  }

  private async scanChannel(channelId: string): Promise<DiscordMessage[]> {
    const floor =
      this.scanLookbackDays > 0
        ? this.now() - this.scanLookbackDays * SECONDS_PER_DAY * 1000
        : null;
    const out: DiscordMessage[] = [];
    let before: string | undefined;
    let truncated = false;
    for (let page = 0; page < this.maxHistoryPages; page += 1) {
      const params = new URLSearchParams({ limit: "100" });
      if (before) params.set("before", before);
      const payload = await this.requestJson<APIMessage[]>(
        "GET",
        `/channels/${routeSegment(channelId)}/messages?${params.toString()}`,
        { idempotent: true },
      );
      const messages = Array.isArray(payload) ? payload : [];
      let reachedFloor = false;
      for (const raw of messages) {
        const message = toMessage(raw, channelId);
        if (floor !== null && Date.parse(message.timestamp) < floor) {
          reachedFloor = true;
          continue;
        }
        if (
          isBotMarked(message, this.markerEmoji) ||
          ((isBotMention(message, this.botUserId) || message.mentionRoleIds.length > 0) &&
            isAllowedAuthor(message, this.allowedUsers))
        ) {
          out.push(message);
        }
      }
      if (messages.length < 100 || reachedFloor) return this.keepTrackedMessages(out);
      before = messages.at(-1)?.id;
      if (!before) return this.keepTrackedMessages(out);
      truncated = page === this.maxHistoryPages - 1;
    }
    if (truncated) {
      this.logger.warn(
        `discord tracker: channel ${channelId} history scan hit the ` +
          `${this.maxHistoryPages}-page safety cap; older mentions may be missed this poll`,
      );
    }
    return this.keepTrackedMessages(out);
  }

  async getMessage(channelId: string, messageId: string): Promise<DiscordMessage | null> {
    const raw = await this.requestJson<APIMessage>(
      "GET",
      `/channels/${routeSegment(channelId)}/messages/${routeSegment(messageId)}`,
      { idempotent: true, allowNotFound: true },
    );
    if (!raw) return null;
    return (await this.withBotRoleContext([toMessage(raw, channelId)]))[0] ?? null;
  }

  async getThread(messageId: string): Promise<DiscordMessage[]> {
    const channel = await this.requestJson<APIChannel>(
      "GET",
      `/channels/${routeSegment(messageId)}`,
      {
        idempotent: true,
        allowNotFound: true,
      },
    );
    if (!channel) return [];

    const out: DiscordMessage[] = [];
    let before: string | undefined;
    for (let page = 0; page < this.maxThreadPages; page += 1) {
      const params = new URLSearchParams({ limit: "100" });
      if (before) params.set("before", before);
      const payload = await this.requestJson<APIMessage[]>(
        "GET",
        `/channels/${routeSegment(messageId)}/messages?${params.toString()}`,
        { idempotent: true },
      );
      const messages = Array.isArray(payload) ? payload : [];
      out.push(...messages.map((message) => toMessage(message, messageId)));
      if (messages.length < 100) return this.withBotRoleContext(out);
      before = messages.at(-1)?.id;
      if (!before) return this.withBotRoleContext(out);
    }
    this.logger.warn(
      `discord tracker: thread ${messageId} hit the ${this.maxThreadPages}-page safety cap; ` +
        "returning a truncated thread",
    );
    return this.withBotRoleContext(out);
  }

  async getChannelParent(channelId: string): Promise<string | null> {
    const channel = await this.requestJson<APIChannel>(
      "GET",
      `/channels/${routeSegment(channelId)}`,
      { idempotent: true, allowNotFound: true },
    );
    if (!channel || !("parent_id" in channel)) return null;
    return typeof channel.parent_id === "string" ? channel.parent_id : null;
  }

  async ensureThread(root: DiscordMessage, name: string): Promise<string> {
    const existing = await this.requestJson<APIChannel>(
      "GET",
      `/channels/${routeSegment(root.id)}`,
      {
        idempotent: true,
        allowNotFound: true,
      },
    );
    if (existing) return existing.id;

    const path = `/channels/${routeSegment(root.channelId)}/messages/${routeSegment(root.id)}/threads`;
    try {
      const created = await this.requestJson<APIChannel>("POST", path, {
        body: {
          name: normalizeThreadName(name, root.id),
          auto_archive_duration: 10080,
        },
        idempotent: false,
      });
      return created.id;
    } catch (error) {
      // Concurrent first writes may both observe no thread. Discord permits one thread per source
      // message, so the loser adopts the canonical thread returned by the follow-up read.
      if (error instanceof DiscordApiError && (error.status === 400 || error.status === 409)) {
        const raced = await this.requestJson<APIChannel>(
          "GET",
          `/channels/${routeSegment(root.id)}`,
          {
            idempotent: true,
            allowNotFound: true,
          },
        );
        if (raced) return raced.id;
      }
      throw error;
    }
  }

  async postThreadMessage(threadId: string, body: string): Promise<void> {
    for (const content of chunkDiscordText(body)) {
      await this.requestJson<APIMessage>("POST", `/channels/${routeSegment(threadId)}/messages`, {
        body: { content, allowed_mentions: { parse: [] } },
        idempotent: false,
      });
    }
  }

  async postWorkpad(threadId: string, workpad: DiscordWorkpad): Promise<string> {
    const posted = await this.requestJson<APIMessage>(
      "POST",
      `/channels/${routeSegment(threadId)}/messages`,
      {
        body: workpadMessage(this.settings, workpad),
        idempotent: false,
      },
    );
    return posted.id;
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.requestJson<undefined>(
      "PUT",
      `/channels/${routeSegment(channelId)}/messages/${routeSegment(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`,
      { idempotent: true },
    );
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.requestJson<undefined>(
      "DELETE",
      `/channels/${routeSegment(channelId)}/messages/${routeSegment(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`,
      { idempotent: true },
    );
  }

  async getUser(userId: string): Promise<DiscordUser | null> {
    const user = await this.requestJson<APIUser>("GET", `/users/${routeSegment(userId)}`, {
      idempotent: true,
      allowNotFound: true,
    });
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      ...(user.global_name !== undefined ? { globalName: user.global_name } : {}),
      ...(user.bot !== undefined ? { bot: user.bot } : {}),
    };
  }

  async registerApplicationCommands(commands: DiscordApplicationCommand[]): Promise<void> {
    if (!this.guildId || commands.length === 0) return;
    const application = await this.requestJson<{ id?: string }>("GET", "/oauth2/applications/@me", {
      idempotent: true,
    });
    if (typeof application.id !== "string") {
      throw new Error("discord application metadata did not include an application id");
    }
    const path =
      `/applications/${routeSegment(application.id)}/guilds/` +
      `${routeSegment(this.guildId)}/commands`;
    const current = await this.requestJson<Array<Record<string, unknown>>>("GET", path, {
      idempotent: true,
    });
    for (const command of commands) {
      const existing = current.find(
        (candidate) => candidate.name === command.name && candidate.type === command.type,
      );
      if (existing && applicationCommandMatches(existing, command)) continue;
      await this.requestJson<Record<string, unknown>>("POST", path, {
        body: command,
        idempotent: false,
      });
    }
  }

  async deferInteraction(interactionId: string, interactionToken: string): Promise<void> {
    await this.requestJson<undefined>(
      "POST",
      `/interactions/${routeSegment(interactionId)}/${routeSegment(interactionToken)}/callback`,
      {
        body: { type: 5, data: { flags: 1 << 6 } },
        idempotent: false,
        authenticated: false,
        globalRateLimit: false,
        displayPath: "/interactions/:id/:token/callback",
        timeoutMs: 2500,
        maxRetries: 0,
      },
    );
  }

  async completeInteraction(
    applicationId: string,
    interactionToken: string,
    result: DiscordInteractionResult,
  ): Promise<void> {
    await this.requestJson<Record<string, unknown>>(
      "PATCH",
      `/webhooks/${routeSegment(applicationId)}/${routeSegment(interactionToken)}/messages/@original`,
      {
        body: {
          embeds: [
            {
              title: result.title,
              description: result.description,
              color: result.color,
            },
          ],
          allowed_mentions: { parse: [] },
        },
        idempotent: true,
        authenticated: false,
        globalRateLimit: false,
        displayPath: "/webhooks/:application/:token/messages/@original",
      },
    );
  }

  async listAround(
    channelId: string,
    messageId: string,
    window: { before: number; after: number },
  ): Promise<DiscordMessage[]> {
    const [anchor, before, after] = await Promise.all([
      this.getMessage(channelId, messageId),
      this.listRelative(channelId, "before", messageId, window.before),
      this.listRelative(channelId, "after", messageId, window.after),
    ]);
    return [...before, ...(anchor ? [anchor] : []), ...after].sort((left, right) =>
      compareSnowflakes(left.id, right.id),
    );
  }

  async readAttachment(
    channelId: string,
    messageId: string,
    attachmentId?: string,
  ): Promise<DiscordAttachmentRead> {
    const raw = await this.requestJson<APIMessage>(
      "GET",
      `/channels/${routeSegment(channelId)}/messages/${routeSegment(messageId)}`,
      { idempotent: true, allowNotFound: true },
    );
    if (!raw) throw new Error(`message ${messageId} does not belong to this Discord issue`);
    const message = toMessage(raw, channelId);
    if (message.channelId !== channelId || message.id !== messageId) {
      throw new Error(`message ${messageId} does not belong to this Discord issue`);
    }
    const attachment = selectDiscordAttachment(message, attachmentId);
    if (attachment.size > ATTACHMENT_BODY_LIMIT_BYTES) {
      throw new Error(
        `discord attachment ${attachment.id} exceeds ${ATTACHMENT_BODY_LIMIT_BYTES} bytes`,
      );
    }
    const rawAttachment = raw.attachments.find((candidate) => candidate.id === attachment.id);
    if (!rawAttachment) {
      throw new Error(
        `attachment ${attachment.id} does not belong to Discord message ${message.id}`,
      );
    }
    const url = discordAttachmentUrl(attachment.id, rawAttachment.url);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { "user-agent": DISCORD_USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error(
        `discord attachment ${attachment.id} request failed: ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
    if (!response.ok) {
      const responseBody = await readResponseBody(response);
      throw new DiscordApiError(
        response.status,
        "GET",
        `/attachments/${routeSegment(attachment.id)}`,
        responseBody,
      );
    }
    return {
      attachment,
      body: await readResponseBytes(response, ATTACHMENT_BODY_LIMIT_BYTES),
    };
  }

  private async listRelative(
    channelId: string,
    direction: "before" | "after",
    messageId: string,
    limit: number,
  ): Promise<DiscordMessage[]> {
    if (limit === 0) return [];
    const params = new URLSearchParams({ [direction]: messageId, limit: String(limit) });
    const payload = await this.requestJson<APIMessage[]>(
      "GET",
      `/channels/${routeSegment(channelId)}/messages?${params.toString()}`,
      { idempotent: true },
    );
    const messages = (Array.isArray(payload) ? payload : []).map((message) =>
      toMessage(message, channelId),
    );
    return this.withBotRoleContext(messages);
  }

  private async keepTrackedMessages(messages: DiscordMessage[]): Promise<DiscordMessage[]> {
    const contextualized = await this.withBotRoleContext(messages);
    return contextualized.filter(
      (message) =>
        isBotMarked(message, this.markerEmoji) ||
        (isBotMention(message, this.botUserId) && isAllowedAuthor(message, this.allowedUsers)),
    );
  }

  private async withBotRoleContext(messages: DiscordMessage[]): Promise<DiscordMessage[]> {
    if (!messages.some((message) => message.mentionRoleIds.length > 0)) return messages;
    const botRoleIds = await this.resolveBotRoleIds();
    return messages.map((message) => ({ ...message, botRoleIds }));
  }

  private async resolveBotRoleIds(): Promise<string[]> {
    if (!this.guildId || !this.botUserId) return [];
    this.botRoleIdsRequest ??= this.requestJson<APIRole[]>(
      "GET",
      `/guilds/${routeSegment(this.guildId)}/roles`,
      { idempotent: true },
    )
      .then((roles) =>
        (Array.isArray(roles) ? roles : [])
          .filter((role) => role.tags?.bot_id === this.botUserId)
          .map((role) => role.id),
      )
      .catch((error) => {
        this.logger.warn(
          `discord tracker: managed bot role lookup failed; role mentions are disabled: ${errorMessage(error)}`,
        );
        return [];
      });
    return this.botRoleIdsRequest;
  }

  private async requestJson<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: {
      body?: unknown;
      idempotent: boolean;
      allowNotFound?: boolean | undefined;
      authenticated?: boolean | undefined;
      globalRateLimit?: boolean | undefined;
      displayPath?: string | undefined;
      timeoutMs?: number | undefined;
      maxRetries?: number | undefined;
    },
  ): Promise<T> {
    const displayPath = options.displayPath ?? path;
    const maxRetries = options.maxRetries ?? MAX_RETRIES;
    for (let retryCount = 0; ; retryCount += 1) {
      if (options.globalRateLimit !== false) await this.waitForGlobalRateLimit();
      let response: Response;
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "user-agent": DISCORD_USER_AGENT,
        };
        if (options.authenticated !== false) headers.authorization = `Bot ${this.token}`;
        response = await this.fetchImpl(`${this.endpoint}${path}`, {
          method,
          headers,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        });
      } catch (error) {
        throw new Error(`discord ${method} ${displayPath} request failed: ${errorMessage(error)}`, {
          cause: error,
        });
      }

      const responseBody = await readResponseBody(response);
      if (response.ok) return responseBody as T;
      if (response.status === 404 && options.allowNotFound === true) return null as T;

      const retryable =
        response.status === 429 ||
        (options.idempotent && response.status >= 500 && response.status < 600);
      if (!retryable || retryCount >= maxRetries) {
        throw new DiscordApiError(response.status, method, displayPath, responseBody);
      }

      const delayMs = retryDelayMs(response, responseBody, retryCount);
      if (response.status === 429 && isGlobalRateLimit(responseBody)) {
        this.globalRateLimitUntil = Math.max(this.globalRateLimitUntil, this.now() + delayMs);
      }
      this.logger.warn(
        `discord ${method} ${displayPath}: HTTP ${response.status}; backing off ` +
          `${Math.round(delayMs / 1000)}s before retry ${retryCount + 1}/${maxRetries}`,
      );
      await this.sleep(delayMs);
    }
  }

  private async waitForGlobalRateLimit(): Promise<void> {
    const delayMs = this.globalRateLimitUntil - this.now();
    if (delayMs > 0) await this.sleep(delayMs);
  }
}

function toMessage(raw: APIMessage, channelId: string): DiscordMessage {
  const threadLastMessageId: unknown =
    raw.thread && "last_message_id" in raw.thread ? raw.thread.last_message_id : undefined;
  return {
    id: raw.id,
    channelId: raw.channel_id ?? channelId,
    content: raw.content ?? "",
    timestamp: raw.timestamp,
    authorId: raw.author?.id,
    authorName: raw.author?.global_name ?? raw.author?.username,
    authorBot: raw.author?.bot === true || raw.webhook_id !== undefined,
    mentionUserIds: (raw.mentions ?? []).map((user) => user.id),
    mentionRoleIds: raw.mention_roles ?? [],
    botRoleIds: [],
    reactions: (raw.reactions ?? []).flatMap((reaction) => {
      const emoji = reaction.emoji.id
        ? `${reaction.emoji.name ?? "emoji"}:${reaction.emoji.id}`
        : reaction.emoji.name;
      return emoji ? [{ emoji, me: reaction.me }] : [];
    }),
    attachments: (raw.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      ...(attachment.title !== undefined ? { title: attachment.title } : {}),
      ...(attachment.description !== undefined ? { description: attachment.description } : {}),
      ...(attachment.content_type !== undefined ? { contentType: attachment.content_type } : {}),
      size: attachment.size,
    })),
    hasThread: raw.thread !== undefined || ((raw.flags ?? 0) & (1 << 5)) !== 0,
    ...(typeof threadLastMessageId === "string" ? { threadLastMessageId } : {}),
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const combined = await readResponseBytes(response, RESPONSE_BODY_LIMIT_BYTES);
  if (combined.byteLength === 0) return undefined;
  const text = new TextDecoder().decode(combined);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function readResponseBytes(response: Response, limitBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = (
    response.body as unknown as {
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
        cancel(): Promise<void>;
      };
    }
  ).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    const value = result.value;
    if (!value) continue;
    size += value.byteLength;
    if (size > limitBytes) {
      await reader.cancel();
      throw new Error(`discord response body exceeds ${limitBytes} bytes`);
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function discordAttachmentUrl(attachmentId: string, attachmentUrl: string): URL {
  const url = new URL(attachmentUrl);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "cdn.discordapp.com" && url.hostname !== "media.discordapp.net")
  ) {
    throw new Error(`discord attachment ${attachmentId} has an untrusted CDN URL`);
  }
  return url;
}

function retryDelayMs(response: Response, body: unknown, retryCount: number): number {
  const bodySeconds =
    typeof body === "object" && body !== null && "retry_after" in body
      ? Number((body as { retry_after?: unknown }).retry_after)
      : Number.NaN;
  const retryAfterHeader = response.headers.get("retry-after");
  const headerSeconds =
    retryAfterHeader === null || retryAfterHeader.trim() === ""
      ? Number.NaN
      : Number(retryAfterHeader);
  const seconds = Number.isFinite(bodySeconds)
    ? bodySeconds
    : Number.isFinite(headerSeconds)
      ? headerSeconds
      : Number.NaN;
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
  return Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** retryCount);
}

function isGlobalRateLimit(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "global" in body &&
    (body as { global?: unknown }).global === true
  );
}

function discordErrorSuffix(body: unknown): string {
  if (typeof body !== "object" || body === null || !("message" in body)) return "";
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" && message !== "" ? ` (${message})` : "";
}

function applicationCommandMatches(
  existing: Record<string, unknown>,
  desired: DiscordApplicationCommand,
): boolean {
  const comparableExisting = {
    type: existing.type,
    name: existing.name,
    ...(desired.description !== undefined ? { description: existing.description } : {}),
    ...(desired.options !== undefined ? { options: existing.options ?? [] } : {}),
  };
  const comparableDesired = {
    type: desired.type,
    name: desired.name,
    ...(desired.description !== undefined ? { description: desired.description } : {}),
    ...(desired.options !== undefined ? { options: desired.options } : {}),
  };
  return JSON.stringify(comparableExisting) === JSON.stringify(comparableDesired);
}

function normalizeThreadName(name: string, fallback: string): string {
  const singleLine = (name.split("\n")[0] ?? "").trim();
  return Array.from(singleLine || `Lorenz issue ${fallback}`)
    .slice(0, 100)
    .join("");
}

export function chunkDiscordText(text: string, limit = 2000): string[] {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("Discord chunk limit must be positive");
  const remaining = Array.from(text);
  if (remaining.length === 0) throw new Error("Discord message body must not be empty");
  const chunks: string[] = [];
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit).join("");
    const newline = candidate.lastIndexOf("\n");
    const cutoff =
      newline >= Math.floor(limit / 2) ? Array.from(candidate.slice(0, newline)).length : limit;
    chunks.push(remaining.splice(0, cutoff).join(""));
    while (remaining[0] === "\n") remaining.shift();
  }
  const final = remaining.join("");
  if (final !== "") chunks.push(final);
  return chunks;
}

function compareSnowflakes(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

function routeSegment(value: string): string {
  return encodeURIComponent(value);
}
