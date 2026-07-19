import { createHash } from "node:crypto";

import type { Settings } from "@lorenz/domain";

import type { SlackTransport } from "./transport.js";

/**
 * The tracker and its default tool pack run in the same daemon. Sharing the effective transport
 * keeps agent reads on the event-fed mirror, including its first-seen and tombstone state.
 */
const runtimeTransports = new Map<string, SlackTransport>();
const RUNTIME_TRANSPORTS_MAX = 32;

/**
 * Stable identity shared by the workflow settings and its per-issue clones. The hash includes
 * resolved credentials without retaining or exposing their plaintext in the registry key.
 */
export function slackRuntimeKey(settings: Settings): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        settings.tracker.kind,
        settings.tracker.endpoint,
        settings.tracker.apiKey,
        settings.tracker.options,
      ]),
    )
    .digest("hex");
}

export function registerSlackRuntimeTransport(settings: Settings, transport: SlackTransport): void {
  const key = slackRuntimeKey(settings);
  runtimeTransports.delete(key);
  while (runtimeTransports.size >= RUNTIME_TRANSPORTS_MAX) {
    const oldest = runtimeTransports.keys().next().value;
    if (oldest === undefined) break;
    runtimeTransports.delete(oldest);
  }
  runtimeTransports.set(key, transport);
}

export function slackRuntimeTransport(settings: Settings): SlackTransport | undefined {
  return runtimeTransports.get(slackRuntimeKey(settings));
}
