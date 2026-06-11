import { defaultToolRegistry, type ToolRegistry } from "@symphony/tool-sdk";
import { defaultTrackerRegistry, type TrackerRegistry } from "@symphony/tracker-sdk";

import { localTrackerProvider } from "./provider.js";
import { localToolProvider } from "./tools.js";

/**
 * Register this extension's tracker provider and tool pack. Idempotent; called by the
 * composition root (or a test) against its registries, defaulting to the process-wide ones.
 */
export function registerLocalTracker(
  registries: { trackers?: TrackerRegistry; tools?: ToolRegistry } = {},
): void {
  const trackers = registries.trackers ?? defaultTrackerRegistry;
  const tools = registries.tools ?? defaultToolRegistry;
  if (trackers.get(localTrackerProvider.kind) === undefined) {
    trackers.register(localTrackerProvider);
  }
  if (tools.get(localToolProvider.name) === undefined) {
    tools.register(localToolProvider);
  }
}
