import { defaultToolRegistry, type ToolRegistry } from "@lorenz/tool-sdk";
import { defaultTrackerRegistry, type TrackerRegistry } from "@lorenz/tracker-sdk";

import { discordTrackerProvider } from "./provider.js";
import { discordToolProvider } from "./tools.js";

export function registerDiscordTracker(
  registries: { trackers?: TrackerRegistry; tools?: ToolRegistry } = {},
): void {
  const trackers = registries.trackers ?? defaultTrackerRegistry;
  const tools = registries.tools ?? defaultToolRegistry;
  if (trackers.get(discordTrackerProvider.kind) === undefined) {
    trackers.register(discordTrackerProvider);
  }
  if (tools.get(discordToolProvider.name) === undefined) {
    tools.register(discordToolProvider);
  }
}
