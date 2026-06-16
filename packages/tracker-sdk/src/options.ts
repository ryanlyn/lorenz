/**
 * Small, dependency-free helpers for implementing {@link TrackerProvider.parseOptions}.
 * They produce `tracker.<key> ...` error messages consistent with the config loader.
 */

/** Throw when `options` contains keys outside `known`; catches config typos per provider. */
export function rejectUnknownOptions(
  options: Record<string, unknown>,
  known: Iterable<string>,
  kind: string,
): void {
  const knownSet = new Set(known);
  const unknown = Object.keys(options).filter((key) => !knownSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`unsupported tracker option(s) for kind "${kind}": ${unknown.join(", ")}`);
  }
}

/** Read an optional string option; throws when present but not a string. */
export function stringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`tracker.${key} must be a string`);
  return value;
}

/**
 * Read an optional list-of-strings option; throws when present but malformed.
 * An empty list collapses to `undefined` so "configured empty" and "not configured"
 * behave identically downstream.
 */
export function stringListOption(
  options: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = options[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`tracker.${key} must be a list of strings`);
  }
  return value.length > 0 ? [...value] : undefined;
}

/**
 * Resolve a whole-value environment reference: `"$VAR"` becomes `env.VAR ?? ""`,
 * anything else is returned unchanged.
 */
export function resolveEnvReference(value: string, env: NodeJS.ProcessEnv): string {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (match === null) return value;
  return env[match[1]!] ?? "";
}
