import { errorMessage, isRecord, type TrackerChangeStream } from "@lorenz/domain";

import type { SlackTrackerLogger } from "./webTransport.js";

/**
 * Minimal structural view of a WHATWG `WebSocket` - just the members Socket Mode needs. Kept
 * local (rather than depending on a DOM lib or a `ws` package) so the only runtime requirement is
 * the global `WebSocket` shipped by Node 22+, and so tests can inject a fake socket.
 */
export interface SlackWebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

export type SlackWebSocketFactory = (url: string) => SlackWebSocketLike;

const defaultWebSocketFactory: SlackWebSocketFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => SlackWebSocketLike }).WebSocket;
  if (!Ctor) {
    throw new Error(
      "slack socket mode: a global WebSocket is required (Node 22+) but is unavailable",
    );
  }
  return new Ctor(url);
};

/** Cap on reconnect backoff: a persistently failing socket retries at most this often. */
const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 1_000;

const defaultReconnectDelayMs = (attempt: number): number =>
  Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS);

/** Dependencies and knobs for {@link SlackSocketMode}; production callers rely on the defaults. */
export interface SlackSocketModeOptions {
  /** Slack Web API base (e.g. `https://slack.com/api`) for `apps.connections.open`. */
  endpoint: string;
  /** App-level token (`xapp-...`) with `connections:write`; used ONLY to open the events socket. */
  appToken: string;
  /** Watched channel ids; events outside these are ignored so we never poll on unrelated traffic. */
  channels: string[];
  /** Invoked when a watched channel sees a mention/reply/reaction - the runtime re-polls promptly. */
  onChange: () => void;
  fetchImpl?: typeof fetch;
  webSocketFactory?: SlackWebSocketFactory;
  logger?: SlackTrackerLogger;
  /** Backoff for the Nth (0-based) consecutive reconnect; defaults to capped exponential. */
  reconnectDelayMs?: (attempt: number) => number;
}

/**
 * Slack Socket Mode client: opens a WebSocket via `apps.connections.open` and invokes
 * {@link SlackSocketModeOptions.onChange} the instant a watched channel sees an `app_mention`,
 * a `message` (covers thread-reply mentions and human `!status` commands), or a reaction change.
 * This is Slack's recommended push transport - no public HTTP endpoint, just an app-level token -
 * and it lets the runtime dispatch immediately instead of waiting out the (deliberately
 * conservative) poll interval.
 *
 * The connection self-heals: Slack recycles Socket Mode connections periodically (a `disconnect`
 * frame precedes closure) and the network can drop, so a closed socket reconnects with capped
 * exponential backoff. The nudge is best-effort by contract - the interval poll remains the safety
 * net - so a dropped frame or a reconnect gap only delays discovery to the next interval, never
 * loses an issue.
 */
export class SlackSocketMode implements TrackerChangeStream {
  private readonly endpoint: string;
  private readonly appToken: string;
  private readonly channels: Set<string>;
  private readonly onChange: () => void;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: SlackWebSocketFactory;
  private readonly logger: SlackTrackerLogger;
  private readonly reconnectDelayMs: (attempt: number) => number;

  private socket: SlackWebSocketLike | null = null;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SlackSocketModeOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.appToken = options.appToken;
    this.channels = new Set(options.channels);
    this.onChange = options.onChange;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.logger = options.logger ?? { warn: (message) => console.warn(message) };
    this.reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelayMs;
  }

  /** Begins connecting (detached). Resolves once the first connection attempt has been kicked off. */
  start(): void {
    void this.connect();
  }

  /** Idempotent: stops reconnecting and closes the live socket. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // The socket may already be closing/closed; nothing to recover.
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    let url: string;
    try {
      url = await this.openConnection();
    } catch (error) {
      this.scheduleReconnect(`apps.connections.open failed: ${errorMessage(error)}`);
      return;
    }
    if (this.closed) return;

    let socket: SlackWebSocketLike;
    try {
      socket = this.webSocketFactory(url);
    } catch (error) {
      this.scheduleReconnect(`websocket open failed: ${errorMessage(error)}`);
      return;
    }
    this.socket = socket;

    socket.addEventListener("message", (event) => this.onMessage(socket, event.data));
    socket.addEventListener("close", () => this.onSocketClosed(socket));
    socket.addEventListener("error", () => {
      // The matching `close` event drives reconnection; a bare error with no close should not
      // wedge the connection, so close the socket to force one.
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    });
  }

  /** Resolve the single-use `wss://` URL for a Socket Mode connection. */
  private async openConnection(): Promise<string> {
    const response = await this.fetchImpl(`${this.endpoint}/apps.connections.open`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.appToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(30_000),
    });
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new Error(`non-JSON response (HTTP ${response.status})`);
    }
    if (body.ok !== true || typeof body.url !== "string" || body.url === "") {
      const reason = typeof body.error === "string" ? body.error : String(response.status);
      throw new Error(reason);
    }
    return body.url;
  }

  private onMessage(socket: SlackWebSocketLike, data: unknown): void {
    if (typeof data !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(frame)) return;

    // Every envelope-bearing frame MUST be acknowledged or Slack treats delivery as failed and
    // redelivers; ack first, then act, so a throw in handling never drops the ack.
    if (typeof frame.envelope_id === "string") {
      try {
        socket.send(JSON.stringify({ envelope_id: frame.envelope_id }));
      } catch {
        // A send on a half-closed socket throws; the close handler will reconnect.
      }
    }

    if (frame.type === "hello") {
      // A live connection resets the backoff so the NEXT drop retries promptly.
      this.reconnectAttempts = 0;
      return;
    }
    if (frame.type === "disconnect") {
      // Slack is recycling this connection. Close so the standard reconnect path opens a fresh
      // one (the interval poll covers the brief gap).
      try {
        socket.close();
      } catch {
        // Already closing.
      }
      return;
    }
    if (frame.type === "events_api" && this.eventTouchesWatchedChannel(frame.payload)) {
      this.onChange();
    }
  }

  /**
   * True when an Events API payload describes activity in a watched channel that could create or
   * advance an issue: a mention, any channel/thread message, or a reaction change. The poll
   * re-derives candidates with the real bot-mention/marker scoping, so a broad match here only
   * risks one extra (coalesced, rate-limited) poll - never a spurious dispatch.
   */
  private eventTouchesWatchedChannel(payload: unknown): boolean {
    if (!isRecord(payload)) return false;
    const event = payload.event;
    if (!isRecord(event)) return false;
    const type = event.type;
    if (
      type !== "app_mention" &&
      type !== "message" &&
      type !== "reaction_added" &&
      type !== "reaction_removed"
    ) {
      return false;
    }
    const channel = channelOfEvent(event);
    // No channels configured means "watch nothing" rather than "watch everything": fail closed.
    return channel !== null && this.channels.has(channel);
  }

  private onSocketClosed(socket: SlackWebSocketLike): void {
    if (this.socket !== socket) return; // a stale socket (already replaced); ignore.
    this.socket = null;
    this.scheduleReconnect("socket closed");
  }

  private scheduleReconnect(reason: string): void {
    if (this.closed) return;
    const delay = this.reconnectDelayMs(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.logger.warn(`slack socket mode: ${reason}; reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    // A daemon shutting down must not be held open by a pending reconnect timer.
    this.reconnectTimer.unref?.();
  }
}

/** Channel id carried by an Events API event: top-level for messages/mentions, `item` for reactions. */
function channelOfEvent(event: Record<string, unknown>): string | null {
  if (typeof event.channel === "string") return event.channel;
  const item = event.item;
  if (isRecord(item) && typeof item.channel === "string") return item.channel;
  return null;
}
