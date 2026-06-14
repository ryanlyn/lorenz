import type { Settings } from "@symphony/domain";
import { stringListOption, stringOption } from "@symphony/tracker-sdk";

export const LINEAR_DEFAULT_ENDPOINT = "https://api.linear.app/graphql";

/** Linear-specific keys of the selected tracker bundle, validated by the provider. */
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

/** Keys of the pack's `tools.linear` slice. */
const LINEAR_PACK_OPTION_KEYS: Record<string, "apiKey" | "endpoint"> = {
  apiKey: "apiKey",
  api_key: "apiKey",
  endpoint: "endpoint",
};

/** Credential and endpoint the mounted linear TOOL pack calls Linear with. */
export interface LinearToolPackOptions {
  apiKey?: string | undefined;
  endpoint: string;
}

/**
 * Auth resolution for the linear TOOL pack. Prefers the pack's own `tools.linear` slice
 * (secret references already resolved at config-parse time), then the dispatch tracker's
 * credential and endpoint only when Linear itself drives dispatch.
 */
export function linearToolPackOptions(settings: Settings): LinearToolPackOptions {
  const packOptions = normalizeLinearPackOptions(settings.toolOptions?.["linear"] ?? {});
  const dispatchIsLinear = settings.tracker.kind === "linear";
  const apiKey =
    packOptions.apiKey || (dispatchIsLinear ? settings.tracker.apiKey : undefined) || undefined;
  const endpoint =
    packOptions.endpoint ??
    (dispatchIsLinear ? settings.tracker.endpoint : undefined) ??
    LINEAR_DEFAULT_ENDPOINT;
  return { apiKey, endpoint };
}

/**
 * Validate the pack's `tools.linear` slice; backs `linearToolProvider.validateOptions`.
 * Errors name the offending `tools.linear.<key>` so config typos fail at startup.
 */
export function validateLinearToolOptions(options: Record<string, unknown>): void {
  normalizeLinearPackOptions(options);
}

function normalizeLinearPackOptions(options: Record<string, unknown>): {
  apiKey?: string | undefined;
  endpoint?: string | undefined;
} {
  const normalized: { apiKey?: string | undefined; endpoint?: string | undefined } = {};
  for (const [key, value] of Object.entries(options)) {
    const canonical = LINEAR_PACK_OPTION_KEYS[key];
    if (canonical === undefined) {
      throw new Error(
        `tools.linear.${key} is not supported (known keys: ${Object.keys(LINEAR_PACK_OPTION_KEYS).join(", ")})`,
      );
    }
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw new Error(`tools.linear.${key} must be a string`);
    }
    normalized[canonical] = value;
  }
  return normalized;
}
