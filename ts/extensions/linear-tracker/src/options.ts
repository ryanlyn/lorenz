import type { Settings } from "@symphony/domain";
import { stringListOption, stringOption } from "@symphony/tracker-sdk";

export const LINEAR_DEFAULT_ENDPOINT = "https://api.linear.app/graphql";

/** Linear-specific keys of the `tracker:` config section, validated by the provider. */
export interface LinearTrackerOptions {
  /** @deprecated Use `projectSlugs` instead. Single Linear project slug. */
  projectSlug?: string | undefined;
  /** Linear project slugs to monitor. Mutually exclusive with `projectLabels`. */
  projectSlugs?: string[] | undefined;
  /** Linear project labels for dynamic discovery. Mutually exclusive with `projectSlugs`. */
  projectLabels?: string[] | undefined;
}

/** Typed view over `settings.tracker.options` for the Linear provider. */
export function linearTrackerOptions(settings: Settings): LinearTrackerOptions {
  const options = settings.tracker.options;
  return {
    projectSlug: stringOption(options, "projectSlug") || undefined,
    projectSlugs: stringListOption(options, "projectSlugs"),
    projectLabels: stringListOption(options, "projectLabels"),
  };
}

/** The configured Linear API endpoint, falling back to the public GraphQL endpoint. */
export function linearEndpoint(settings: Settings): string {
  return settings.tracker.endpoint ?? LINEAR_DEFAULT_ENDPOINT;
}
