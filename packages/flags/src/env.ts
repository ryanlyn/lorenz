import { parseBoolToken } from "./coerce.js";
import type { FeatureInput, FlagInput, FlagIssue, FlagManifest, RawLayer } from "./types.js";

interface EnvBinding {
  readonly kind: "flag" | "feature";
  readonly key: string;
}

/**
 * Build the env-name -> binding table from the manifest's EXPLICIT `envName` declarations.
 *
 * A flag or feature is reachable from the environment only when it declares an `envName`. The name
 * is author-chosen and arbitrary: there is no key-derived encoding and no reserved prefix, so the
 * environment is never scanned by convention. Entries without an `envName` are intentionally absent
 * from the table - they are config/CLI-only and cannot be set through the environment at all.
 *
 * Throws on a boot-time collision where two manifest entries claim the same env var name.
 */
export function buildEnvLookup(manifest: FlagManifest): Map<string, EnvBinding> {
  const table = new Map<string, EnvBinding>();
  const add = (envVar: string, binding: EnvBinding): void => {
    const existing = table.get(envVar);
    if (existing) {
      throw new Error(
        `@lorenz/flags: env var ${envVar} maps to both ${existing.kind} \`${existing.key}\` and ` +
          `${binding.kind} \`${binding.key}\`; give them distinct envName values`,
      );
    }
    table.set(envVar, binding);
  };
  for (const [key, def] of Object.entries(manifest.flags)) {
    if (def.envName !== undefined) add(def.envName, { kind: "flag", key });
  }
  for (const [name, def] of Object.entries(manifest.features)) {
    if (def.envName !== undefined) add(def.envName, { kind: "feature", key: name });
  }
  return table;
}

/**
 * Read the explicitly-declared flag/feature env vars from `env`. Only the names a manifest entry
 * declares via `envName` are consulted - the environment is never scanned for a prefix, so an
 * undeclared or misspelled variable is simply ignored rather than reported. A non-boolean value for
 * a feature is the one categorization problem, deferred as a {@link FlagIssue} so a single resolve
 * reports every problem at once. A manifest-level envName collision (from {@link buildEnvLookup})
 * throws.
 */
export function flagInputsFromEnv(
  manifest: FlagManifest,
  env: NodeJS.ProcessEnv = process.env,
): RawLayer {
  const lookup = buildEnvLookup(manifest);
  const flags: FlagInput[] = [];
  const features: FeatureInput[] = [];
  const issues: FlagIssue[] = [];
  for (const [envVar, binding] of lookup) {
    const rawValue = env[envVar];
    if (rawValue === undefined) continue;
    if (binding.kind === "flag") {
      flags.push({ source: "env", key: binding.key, rawValue, origin: envVar });
      continue;
    }
    const enabled = parseBoolToken(rawValue);
    if (enabled === undefined) {
      issues.push({
        kind: "invalid_value",
        message: `invalid value for ${envVar}: must be true or false`,
      });
      continue;
    }
    features.push({ source: "env", name: binding.key, enabled, origin: envVar });
  }
  return { flags, features, issues };
}
