import { isRecord } from "@lorenz/domain";

import { parseBoolToken } from "./coerce.js";
import { unknownFeatureError, unknownFlagError } from "./errors.js";
import { isFeatureKey, isFlagKey } from "./keys.js";
import type { FeatureInput, FlagInput, FlagIssue, FlagManifest, RawLayer } from "./types.js";

/**
 * Parse repeatable `--flag key=value` / `--feature name[=true|false]` CLI tokens. Like the env
 * parser, this is fully non-throwing: malformed shape, unknown keys, and non-boolean feature tokens
 * become deferred {@link FlagIssue}s so the resolver reports every CLI problem at once.
 */
export function flagInputsFromCli(
  manifest: FlagManifest,
  flagTokens: readonly string[],
  featureTokens: readonly string[],
): RawLayer {
  const flags: FlagInput[] = [];
  const features: FeatureInput[] = [];
  const issues: FlagIssue[] = [];

  for (const token of flagTokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      issues.push({ kind: "invalid_value", message: `--flag expects key=value, got "${token}"` });
      continue;
    }
    const key = token.slice(0, eq).trim();
    // Split on the FIRST `=` so values may themselves contain `=`.
    const rawValue = token.slice(eq + 1);
    if (!isFlagKey(manifest, key)) {
      issues.push(unknownFlagError("--flag", key, manifest));
      continue;
    }
    flags.push({ source: "cli", key, rawValue, origin: `--flag ${token}` });
  }

  for (const token of featureTokens) {
    const eq = token.indexOf("=");
    const name = (eq === -1 ? token : token.slice(0, eq)).trim();
    if (!isFeatureKey(manifest, name)) {
      issues.push(unknownFeatureError("--feature", name, manifest));
      continue;
    }
    if (eq === -1) {
      features.push({ source: "cli", name, enabled: true, origin: `--feature ${name}` });
      continue;
    }
    const enabled = parseBoolToken(token.slice(eq + 1));
    if (enabled === undefined) {
      issues.push({
        kind: "invalid_value",
        message: `--feature ${name} expects true|false, got "${token.slice(eq + 1)}"`,
      });
      continue;
    }
    features.push({ source: "cli", name, enabled, origin: `--feature ${token}` });
  }

  return { flags, features, issues };
}

/**
 * Read the `flags:` / `features:` sections off raw `WORKFLOW.md` front matter. Native YAML scalars
 * pass through unchanged as `rawValue` (no pre-stringification), so a YAML `8`/`true`/`null` reaches
 * the right validator. Structural and unknown-key problems become deferred issues.
 */
export function flagInputsFromFile(
  manifest: FlagManifest,
  config: Record<string, unknown>,
): RawLayer {
  const flags: FlagInput[] = [];
  const features: FeatureInput[] = [];
  const issues: FlagIssue[] = [];

  const flagsRaw = config.flags;
  if (flagsRaw !== undefined) {
    if (!isRecord(flagsRaw)) {
      issues.push({
        kind: "invalid_value",
        message: "WORKFLOW.md `flags:` must be a map of key to value",
      });
    } else {
      for (const [key, value] of Object.entries(flagsRaw)) {
        if (!isFlagKey(manifest, key)) {
          issues.push(unknownFlagError("WORKFLOW.md flags", key, manifest));
          continue;
        }
        flags.push({ source: "file", key, rawValue: value, origin: `WORKFLOW.md flags.${key}` });
      }
    }
  }

  const featuresRaw = config.features;
  if (featuresRaw !== undefined) {
    if (!isRecord(featuresRaw)) {
      issues.push({
        kind: "invalid_value",
        message: "WORKFLOW.md `features:` must be a map of name to boolean",
      });
    } else {
      for (const [name, value] of Object.entries(featuresRaw)) {
        if (!isFeatureKey(manifest, name)) {
          issues.push(unknownFeatureError("WORKFLOW.md features", name, manifest));
          continue;
        }
        const enabled = parseBoolToken(value);
        if (enabled === undefined) {
          issues.push({
            kind: "invalid_value",
            message: `WORKFLOW.md features.${name} must be a boolean, got "${String(value)}"`,
          });
          continue;
        }
        features.push({ source: "file", name, enabled, origin: `WORKFLOW.md features.${name}` });
      }
    }
  }

  return { flags, features, issues };
}
