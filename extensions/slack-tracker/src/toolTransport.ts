import type { Settings } from "@lorenz/domain";

import type { SlackTransport } from "./transport.js";

/**
 * The tracker and its default tool pack run in the same daemon. Sharing the effective transport
 * keeps agent reads on the event-fed mirror, including its first-seen and tombstone state.
 */
const runtimeTransports = new WeakMap<Settings, SlackTransport>();

export function registerSlackRuntimeTransport(settings: Settings, transport: SlackTransport): void {
  runtimeTransports.set(settings, transport);
}

export function slackRuntimeTransport(settings: Settings): SlackTransport | undefined {
  return runtimeTransports.get(settings);
}
