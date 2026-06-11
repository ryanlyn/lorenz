import { defaultToolRegistry, type ToolRegistry } from "@symphony/tool-sdk";
import { defaultTrackerRegistry, type TrackerRegistry } from "@symphony/tracker-sdk";

import { slackTrackerProvider } from "./provider.js";
import { slackToolProvider } from "./tools.js";

/**
 * Register this extension's tracker provider and tool pack. Idempotent; called by the
 * composition root (or a test) against its registries, defaulting to the process-wide ones.
 */
export function registerSlackTracker(
  registries: { trackers?: TrackerRegistry; tools?: ToolRegistry } = {},
): void {
  const trackers = registries.trackers ?? defaultTrackerRegistry;
  const tools = registries.tools ?? defaultToolRegistry;
  if (trackers.get(slackTrackerProvider.kind) === undefined) {
    trackers.register(slackTrackerProvider);
  }
  if (tools.get(slackToolProvider.name) === undefined) {
    tools.register(slackToolProvider);
  }
}
