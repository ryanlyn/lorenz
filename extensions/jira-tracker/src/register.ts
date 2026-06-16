import { defaultTrackerRegistry, type TrackerRegistry } from "@lorenz/tracker-sdk";

import { jiraMcpTrackerProvider, jiraTrackerProvider } from "./provider.js";

/**
 * Register this extension's tracker providers (`jira` and `jira-mcp`). Jira ships no pack
 * of its own; its agent tools come from the provider-neutral `tracker` pack. Idempotent;
 * called by the composition root (or a test), defaulting to the process-wide registry.
 */
export function registerJiraTrackers(registries: { trackers?: TrackerRegistry } = {}): void {
  const trackers = registries.trackers ?? defaultTrackerRegistry;
  for (const provider of [jiraTrackerProvider, jiraMcpTrackerProvider]) {
    if (trackers.get(provider.kind) === undefined) trackers.register(provider);
  }
}
