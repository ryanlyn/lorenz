import { defaultToolRegistry, type ToolRegistry } from "@lorenz/tool-sdk";
import { defaultTrackerRegistry, type TrackerRegistry } from "@lorenz/tracker-sdk";

import { linearTrackerProvider } from "./provider.js";
import { linearToolProvider } from "./tools.js";

/**
 * Register this extension's tracker provider and tool pack. Idempotent; called by the
 * composition root (or a test) against its registries, defaulting to the process-wide ones.
 */
export function registerLinearTracker(
  registries: { trackers?: TrackerRegistry; tools?: ToolRegistry } = {},
): void {
  const trackers = registries.trackers ?? defaultTrackerRegistry;
  const tools = registries.tools ?? defaultToolRegistry;
  if (trackers.get(linearTrackerProvider.kind) === undefined) {
    trackers.register(linearTrackerProvider);
  }
  if (tools.get(linearToolProvider.name) === undefined) {
    tools.register(linearToolProvider);
  }
}
