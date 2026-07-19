import WebSocket, { type RawData } from "ws";
import type { TrackerChangeStream } from "@lorenz/domain";

import type { DiscordInteraction } from "./transport.js";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const READY_STATE_OPEN = 1;
const MAX_RECONNECT_ATTEMPTS = 50;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const RESUME_FAILURE_THRESHOLD = 3;

const GATEWAY_INTENTS =
  (1 << 0) | // GUILDS
  (1 << 9) | // GUILD_MESSAGES
  (1 << 10) | // GUILD_MESSAGE_REACTIONS
  (1 << 15); // MESSAGE_CONTENT

const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const FRESH_IDENTIFY_CLOSE_CODES = new Set([4003, 4005, 4007, 4009]);

interface GatewayPayload {
  op: number;
  d: unknown;
  s?: number | null | undefined;
  t?: string | null | undefined;
}

interface GatewayReady {
  session_id?: string | undefined;
  resume_gateway_url?: string | undefined;
}

interface GatewayEventData {
  id?: string | undefined;
  guild_id?: string | undefined;
  channel_id?: string | undefined;
  message_id?: string | undefined;
  parent_id?: string | undefined;
  mentions?: Array<{ id?: string | undefined }> | undefined;
  mention_roles?: string[] | undefined;
}

export interface DiscordGatewayLogger {
  warn(message: string): void;
}

export type DiscordWebSocketFactory = (url: string) => WebSocket;

export interface DiscordGatewayOptions {
  token: string;
  guildId: string;
  botUserId: string;
  channels: ReadonlySet<string>;
  trackedThreadIds: ReadonlySet<string>;
  onChange: () => void;
  onInteraction?: ((interaction: DiscordInteraction) => void) | undefined;
  logger?: DiscordGatewayLogger | undefined;
  createWebSocket?: DiscordWebSocketFactory | undefined;
  random?: (() => number) | undefined;
}

/**
 * Discord Gateway subscription used only as a low-latency wake-up signal. REST scans remain the
 * source of truth, so a disconnect or missed event is repaired by the ordinary polling interval.
 */
export class DiscordGatewayChangeStream implements TrackerChangeStream {
  private readonly token: string;
  private readonly guildId: string;
  private readonly botUserId: string;
  private readonly channels: ReadonlySet<string>;
  private readonly trackedThreadIds: ReadonlySet<string>;
  private readonly onChange: () => void;
  private readonly onInteraction: ((interaction: DiscordInteraction) => void) | undefined;
  private readonly logger: DiscordGatewayLogger;
  private readonly createWebSocket: DiscordWebSocketFactory;
  private readonly random: () => number;
  private socket: WebSocket | null = null;
  private heartbeatTimeout: NodeJS.Timeout | undefined;
  private heartbeatInterval: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private lastHeartbeatAck = true;
  private reconnectAttempts = 0;
  private consecutiveResumeFailures = 0;
  private closed = false;

  constructor(options: DiscordGatewayOptions) {
    this.token = options.token;
    this.guildId = options.guildId;
    this.botUserId = options.botUserId;
    this.channels = options.channels;
    this.trackedThreadIds = options.trackedThreadIds;
    this.onChange = options.onChange;
    this.onInteraction = options.onInteraction;
    this.logger = options.logger ?? { warn: (message) => console.warn(message) };
    this.createWebSocket =
      options.createWebSocket ?? ((url) => new WebSocket(url, { maxPayload: MAX_PAYLOAD_BYTES }));
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.closed || this.socket) return;
    this.connect(false);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "Lorenz shutdown");
  }

  private connect(resume: boolean): void {
    if (this.closed) return;
    const baseUrl = resume && this.resumeGatewayUrl ? this.resumeGatewayUrl : GATEWAY_URL;
    const separator = baseUrl.includes("?") ? "&" : "?";
    const url = baseUrl.includes("encoding=")
      ? baseUrl
      : `${baseUrl}${separator}v=10&encoding=json`;
    const socket = this.createWebSocket(url);
    this.socket = socket;
    socket.on("message", (data) => this.handleMessage(socket, data, resume));
    socket.on("close", (code) => this.handleClose(socket, code));
    socket.on("error", (error) => {
      if (socket === this.socket && !this.closed) {
        this.logger.warn(`discord gateway socket error: ${String(error)}`);
      }
    });
  }

  private handleMessage(socket: WebSocket, data: RawData, resume: boolean): void {
    if (socket !== this.socket || this.closed) return;
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(rawDataText(data)) as GatewayPayload;
    } catch {
      this.logger.warn("discord gateway sent an invalid JSON payload; reconnecting");
      this.scheduleReconnect(false);
      return;
    }
    if (typeof payload.s === "number") this.sequence = payload.s;

    switch (payload.op) {
      case 0:
        this.handleDispatch(payload);
        break;
      case 1:
        this.sendHeartbeat();
        break;
      case 7:
        this.scheduleReconnect(true);
        break;
      case 9: {
        const canResume = payload.d === true;
        if (!canResume) this.resetSession();
        this.scheduleReconnect(canResume, 1000 + Math.floor(this.random() * 4000));
        break;
      }
      case 10: {
        const interval = readHeartbeatInterval(payload.d);
        this.startHeartbeat(interval);
        if (resume && this.sessionId && this.sequence !== null) {
          this.send({
            op: 6,
            d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
          });
        } else {
          this.send({
            op: 2,
            d: {
              token: this.token,
              intents: GATEWAY_INTENTS,
              properties: { os: process.platform, browser: "lorenz", device: "lorenz" },
            },
          });
        }
        break;
      }
      case 11:
        this.lastHeartbeatAck = true;
        break;
    }
  }

  private handleDispatch(payload: GatewayPayload): void {
    if (payload.t === "READY") {
      const ready = isRecord(payload.d) ? (payload.d as GatewayReady) : {};
      this.sessionId = typeof ready.session_id === "string" ? ready.session_id : null;
      this.resumeGatewayUrl =
        typeof ready.resume_gateway_url === "string" ? ready.resume_gateway_url : null;
      this.reconnectAttempts = 0;
      this.consecutiveResumeFailures = 0;
      return;
    }
    if (payload.t === "RESUMED") {
      this.reconnectAttempts = 0;
      this.consecutiveResumeFailures = 0;
      return;
    }
    if (payload.t === "INTERACTION_CREATE") {
      const interaction = parseInteraction(payload.d);
      if (interaction?.guildId === this.guildId) this.onInteraction?.(interaction);
      return;
    }
    if (!RELEVANT_EVENTS.has(payload.t ?? "") || !isRecord(payload.d)) return;
    const event = payload.d as GatewayEventData;
    if (event.guild_id !== this.guildId) return;
    if (event.parent_id && this.channels.has(event.parent_id)) {
      this.onChange();
      return;
    }
    const channelId = event.channel_id;
    if (!channelId) return;
    if (this.trackedThreadIds.has(channelId)) {
      this.onChange();
      return;
    }
    if (!this.channels.has(channelId)) return;
    const messageId = event.id ?? event.message_id;
    const isKnownIssue = messageId !== undefined && this.trackedThreadIds.has(messageId);
    const mentionsBot = event.mentions?.some((mention) => mention.id === this.botUserId) === true;
    const mentionsRole = (event.mention_roles?.length ?? 0) > 0;
    if (isKnownIssue || mentionsBot || mentionsRole) this.onChange();
  }

  private handleClose(socket: WebSocket, code: number): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearHeartbeat();
    if (this.closed) return;
    if (FATAL_CLOSE_CODES.has(code)) {
      this.logger.warn(`discord gateway closed with fatal code ${code}; push wake-ups stopped`);
      return;
    }
    const canResume = !FRESH_IDENTIFY_CLOSE_CODES.has(code);
    if (!canResume) this.resetSession();
    this.scheduleReconnect(canResume);
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.lastHeartbeatAck = true;
    const firstDelay = Math.floor(intervalMs * this.random());
    this.heartbeatTimeout = setTimeout(() => {
      this.sendHeartbeatOrReconnect();
      this.heartbeatInterval = setInterval(() => this.sendHeartbeatOrReconnect(), intervalMs);
    }, firstDelay);
  }

  private sendHeartbeatOrReconnect(): void {
    if (!this.lastHeartbeatAck) {
      this.logger.warn("discord gateway heartbeat was not acknowledged; resuming connection");
      this.scheduleReconnect(true);
      return;
    }
    this.sendHeartbeat();
  }

  private sendHeartbeat(): void {
    this.lastHeartbeatAck = false;
    this.send({ op: 1, d: this.sequence });
  }

  private send(payload: GatewayPayload): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== READY_STATE_OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  private scheduleReconnect(preferResume: boolean, minimumDelayMs = 0): void {
    if (this.closed || this.reconnectTimer) return;
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = null;
    socket?.close(4000, "Reconnecting");

    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      this.logger.warn(
        `discord gateway reached ${MAX_RECONNECT_ATTEMPTS} reconnect attempts; push wake-ups stopped`,
      );
      return;
    }

    let resume = preferResume && this.sessionId !== null && this.sequence !== null;
    if (resume && this.consecutiveResumeFailures >= RESUME_FAILURE_THRESHOLD) {
      this.resetSession();
      resume = false;
    }
    if (resume) this.consecutiveResumeFailures += 1;
    else this.consecutiveResumeFailures = 0;

    const delayMs = Math.max(
      minimumDelayMs,
      Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5)),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(resume);
    }, delayMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatTimeout = undefined;
    this.heartbeatInterval = undefined;
  }

  private resetSession(): void {
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.sequence = null;
    this.consecutiveResumeFailures = 0;
  }
}

const RELEVANT_EVENTS = new Set([
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "MESSAGE_DELETE",
  "MESSAGE_REACTION_ADD",
  "MESSAGE_REACTION_REMOVE",
  "MESSAGE_REACTION_REMOVE_ALL",
  "MESSAGE_REACTION_REMOVE_EMOJI",
  "THREAD_UPDATE",
  "THREAD_DELETE",
]);

function readHeartbeatInterval(value: unknown): number {
  if (!isRecord(value) || typeof value.heartbeat_interval !== "number") return 45_000;
  return Math.max(1000, value.heartbeat_interval);
}

function parseInteraction(value: unknown): DiscordInteraction | null {
  if (!isRecord(value) || !isRecord(value.data)) return null;
  const id = stringField(value, "id");
  const applicationId = stringField(value, "application_id");
  const token = stringField(value, "token");
  const guildId = stringField(value, "guild_id");
  const channelId = stringField(value, "channel_id");
  const type = value.type;
  const user =
    isRecord(value.member) && isRecord(value.member.user) ? value.member.user : value.user;
  if (
    !id ||
    !applicationId ||
    !token ||
    !guildId ||
    !channelId ||
    !isRecord(user) ||
    (type !== 2 && type !== 3)
  ) {
    return null;
  }
  const userId = stringField(user, "id");
  if (!userId) return null;

  if (type === 2) {
    const commandName = stringField(value.data, "name");
    if (!commandName) return null;
    return {
      id,
      applicationId,
      token,
      type: "command",
      guildId,
      channelId,
      userId,
      userBot: user.bot === true,
      commandName,
      commandOptions: interactionOptions(value.data.options),
      ...(typeof value.data.target_id === "string" ? { targetId: value.data.target_id } : {}),
    };
  }

  const customId = stringField(value.data, "custom_id");
  if (!customId) return null;
  const componentValues = stringArray(value.data.values);
  return {
    id,
    applicationId,
    token,
    type: "component",
    guildId,
    channelId,
    userId,
    userBot: user.bot === true,
    customId,
    ...(componentValues.length > 0 ? { componentValues } : {}),
  };
}

function interactionOptions(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const option of value) {
    if (!isRecord(option) || typeof option.name !== "string") continue;
    if (typeof option.value === "string") out[option.name] = option.value;
  }
  return out;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
