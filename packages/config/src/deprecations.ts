import { isRecord } from "@lorenz/domain";

import { normalizeWorkflowConfig } from "./aliases.js";
import { schemaConfigDeprecations, type ConfigDeprecation } from "./schemas.js";

export type { ConfigDeprecation } from "./schemas.js";

/**
 * Scan raw workflow front matter for deprecated keys. The deprecation facts live as `.meta()`
 * annotations on the schema fields/sections they belong to (see `schemas.ts`); this function
 * only resolves aliases to the canonical spelling and defers to {@link schemaConfigDeprecations}.
 */
export function collectConfigDeprecations(raw: Record<string, unknown>): ConfigDeprecation[] {
  const normalized = normalizeWorkflowConfig(raw);
  return isRecord(normalized) ? schemaConfigDeprecations(normalized) : [];
}

/** Render a deprecation as a one-line operator warning with its recommendation. */
export function formatConfigDeprecation(dep: ConfigDeprecation): string {
  const base = `\`${dep.configPath}\` is deprecated; use \`${dep.replacement}\` instead.`;
  return dep.detail ? `${base} ${dep.detail}` : base;
}

/** Collect and emit every deprecation through `warn`, returning the collected list. */
export function warnConfigDeprecations(
  raw: Record<string, unknown>,
  warn: (message: string) => void,
): ConfigDeprecation[] {
  const deprecations = collectConfigDeprecations(raw);
  for (const dep of deprecations) warn(formatConfigDeprecation(dep));
  return deprecations;
}
