import type { TrackerProvider } from "@symphony/tracker-sdk";
import {
  rejectUnknownOptions,
  resolveEnvReference,
  stringListOption,
  stringOption,
} from "@symphony/tracker-sdk";

import { LinearClient } from "./client.js";
import { LINEAR_DEFAULT_ENDPOINT, linearTrackerOptions } from "./options.js";
import { linearToolOps } from "./toolOps.js";

/** Linear.app tracker: issues are polled from configured projects over GraphQL. */
export const linearTrackerProvider: TrackerProvider = {
  kind: "linear",
  configAliases: {
    project_slug: "projectSlug",
    project_slugs: "projectSlugs",
    project_labels: "projectLabels",
  },
  envFallbacks: { apiKey: "LINEAR_API_KEY", assignee: "LINEAR_ASSIGNEE" },
  defaultEndpoint: LINEAR_DEFAULT_ENDPOINT,
  parseOptions(options, context) {
    rejectUnknownOptions(options, ["projectSlug", "projectSlugs", "projectLabels"], "linear");
    const projectSlugRaw = stringOption(options, "projectSlug");
    const projectSlug =
      projectSlugRaw === undefined
        ? undefined
        : resolveEnvReference(projectSlugRaw, context.env) || undefined;
    const projectSlugs = stringListOption(options, "projectSlugs");
    const projectLabels = stringListOption(options, "projectLabels");
    return {
      ...(projectSlug !== undefined ? { projectSlug } : {}),
      ...(projectSlugs !== undefined ? { projectSlugs } : {}),
      ...(projectLabels !== undefined ? { projectLabels } : {}),
    };
  },
  validateDispatch(settings) {
    if (!settings.tracker.apiKey) throw new Error("tracker.api_key is required");
    const { projectSlug, projectSlugs, projectLabels } = linearTrackerOptions(settings);
    const configured = [!!projectSlug, !!projectSlugs?.length, !!projectLabels?.length];
    const count = configured.filter(Boolean).length;
    if (count === 0) {
      throw new Error(
        "tracker.project_slug, tracker.project_slugs, or tracker.project_labels is required",
      );
    }
    if (count > 1) {
      throw new Error(
        "tracker.project_slug, tracker.project_slugs, and tracker.project_labels are mutually exclusive",
      );
    }
  },
  createClient(settings) {
    const client = new LinearClient(settings);
    // Resolve project slugs (e.g. from project_labels) in the background so the first poll
    // does not pay the discovery round-trip.
    void client.resolveProjectSlugs().catch(() => {});
    return client;
  },
  createToolOps: (settings, context) => linearToolOps(settings, context),
  defaultToolPacks: () => ["linear"],
  projectUrl(settings) {
    const slug = linearTrackerOptions(settings).projectSlug?.trim();
    if (!slug) return undefined;
    return `https://linear.app/project/${encodeURIComponent(slug)}/issues`;
  },
};
