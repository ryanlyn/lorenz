import { parseBoolToken } from "./coerce.js";
import type { FeatureInput, FlagInput, FlagIssue, FlagManifest, RawLayer } from "./types.js";

const FLAG_PREFIX = "LORENZ_FLAG_";
const FEATURE_PREFIX = "LORENZ_FEATURE_";

// Manifest keys are lower_snake_case dotted, so the env encoding is a lossless mechanical
// transform: `scheduler.batch_size` -> `LORENZ_FLAG_SCHEDULER__BATCH_SIZE`. No camelCase boundary
// handling and no lossy uppercasing, so derived names never collide.
function encodeKey(key: string): string {
  return key.split(".").join("__").toUpperCase();
}

export function flagEnvName(key: string): string {
  return `${FLAG_PREFIX}${encodeKey(key)}`;
}

function featureEnvName(name: string): string {
  return `${FEATURE_PREFIX}${encodeKey(name)}`;
}

interface EnvBinding {
  readonly kind: "flag" | "feature";
  readonly key: string;
}

/** Build the reverse env-name -> binding table, throwing on a boot-time name collision. */
export function buildEnvLookup(manifest: FlagManifest): Map<string, EnvBinding> {
  const table = new Map<string, EnvBinding>();
  const add = (envVar: string, binding: EnvBinding): void => {
    const existing = table.get(envVar);
    if (existing) {
      throw new Error(
        `@lorenz/flags: env var ${envVar} maps to both ${existing.kind} \`${existing.key}\` and ` +
          `${binding.kind} \`${binding.key}\`; set an explicit envName to disambiguate`,
      );
    }
    table.set(envVar, binding);
  };
  for (const [key, def] of Object.entries(manifest.flags)) {
    add(def.envName ?? flagEnvName(key), { kind: "flag", key });
  }
  for (const [name, def] of Object.entries(manifest.features)) {
    add(def.envName ?? featureEnvName(name), { kind: "feature", key: name });
  }
  return table;
}

/**
 * Scan the whole environment for the reserved prefixes. Categorization problems (unknown name,
 * wrong prefix for a known key, non-boolean feature value) become deferred {@link FlagIssue}s so a
 * single resolve reports every env problem at once, independent of `process.env` iteration order.
 * Only a manifest-level env-name collision (from {@link buildEnvLookup}) throws.
 */
export function flagInputsFromEnv(
  manifest: FlagManifest,
  env: NodeJS.ProcessEnv = process.env,
): RawLayer {
  const lookup = buildEnvLookup(manifest);
  const flags: FlagInput[] = [];
  const features: FeatureInput[] = [];
  const issues: FlagIssue[] = [];
  for (const [envVar, rawValue] of Object.entries(env)) {
    const isFlag = envVar.startsWith(FLAG_PREFIX);
    const isFeature = envVar.startsWith(FEATURE_PREFIX);
    if ((!isFlag && !isFeature) || rawValue === undefined) continue;
    const binding = lookup.get(envVar);
    if (!binding) {
      issues.push({
        kind: isFlag ? "unknown_flag" : "unknown_feature",
        message: `${envVar}: unknown ${isFlag ? "flag" : "feature"} (no manifest key maps to this env var)`,
      });
      continue;
    }
    if (binding.kind === "flag") {
      if (!isFlag) {
        issues.push({
          kind: "invalid_value",
          message: `${envVar}: \`${binding.key}\` is a flag; use ${FLAG_PREFIX}* not ${FEATURE_PREFIX}*`,
        });
        continue;
      }
      flags.push({ source: "env", key: binding.key, rawValue, origin: envVar });
    } else {
      if (!isFeature) {
        issues.push({
          kind: "invalid_value",
          message: `${envVar}: \`${binding.key}\` is a feature; use ${FEATURE_PREFIX}* not ${FLAG_PREFIX}*`,
        });
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
  }
  return { flags, features, issues };
}
