import { defaultToolRegistry, type ToolRegistry } from "@lorenz/tool-sdk";
import { defaultTrackerRegistry, type TrackerRegistry } from "@lorenz/tracker-sdk";

import { jiraMcpTrackerProvider, jiraTrackerProvider } from "./provider.js";
import { jiraToolProvider } from "./tools.js";

/**
 * Register this extension's tracker providers (`jira` and `jira-mcp`) and the `jira_*`
 * tool pack they mount by default. Idempotent; called by the composition root (or a test),
 * defaulting to the process-wide registries.
 */
export function registerJiraTrackers(
  registries: { trackers?: TrackerRegistry; tools?: ToolRegistry } = {},
): void {
  const trackers = registries.trackers ?? defaultTrackerRegistry;
  const tools = registries.tools ?? defaultToolRegistry;
  for (const provider of [jiraTrackerProvider, jiraMcpTrackerProvider]) {
    if (trackers.get(provider.kind) === undefined) trackers.register(provider);
  }
  if (tools.get(jiraToolProvider.name) === undefined) {
    tools.register(jiraToolProvider);
  }
}
