import { clearDefaultFlags, getDefaultFlags, hasDefaultFlags, setDefaultFlags } from "./default.js";
import { resetFlagDeprecationWarnings } from "./deprecations.js";
import { resolveFlags } from "./resolve.js";
import type {
  FeatureDef,
  FeatureInput,
  FlagInput,
  FlagManifest,
  FlagMap,
  FlagOverrides,
  FlagsSnapshot,
  RawLayer,
} from "./types.js";

// Test seams (subpath export `@lorenz/flags/testing`), kept out of the production entry point.

function emptyLayer(): RawLayer {
  return { flags: [], features: [] };
}

/**
 * Build a frozen snapshot from manifest defaults + feature presets + typed overrides, with no
 * env/CLI/file scanning. Overrides enter at the explicit (CLI) band, so an explicit override beats
 * an enabled feature preset exactly as in production. Routing through the real {@link resolveFlags}
 * keeps a single precedence implementation. Deprecation warnings are suppressed (no-op `warn`).
 */
export function buildTestFlags<F extends FlagMap, Features extends Record<string, FeatureDef>>(
  manifest: FlagManifest<F, Features>,
  overrides: FlagOverrides<F, Features> = {},
): FlagsSnapshot<F, Features> {
  const flags: FlagInput[] = [];
  const features: FeatureInput[] = [];
  for (const [key, value] of Object.entries(overrides.flags ?? {})) {
    flags.push({ source: "cli", key, rawValue: value, origin: `test override flags.${key}` });
  }
  for (const [name, enabled] of Object.entries(overrides.features ?? {})) {
    if (enabled === undefined) continue;
    features.push({ source: "cli", name, enabled, origin: `test override features.${name}` });
  }
  return resolveFlags(
    manifest,
    { cli: { flags, features }, file: emptyLayer(), env: emptyLayer() },
    { warn: () => {} },
  );
}

/** Build a snapshot from overrides and install it as the default. Returns the snapshot. */
export function setFlagsForTesting<F extends FlagMap, Features extends Record<string, FeatureDef>>(
  manifest: FlagManifest<F, Features>,
  overrides: FlagOverrides<F, Features> = {},
): FlagsSnapshot<F, Features> {
  const snapshot = buildTestFlags(manifest, overrides);
  setDefaultFlags(snapshot);
  return snapshot;
}

/**
 * Run `fn` with a fresh snapshot installed as the default, restoring the prior install afterward
 * (even on throw). Synchronous only: a module-level save/restore is not safe across `await` points
 * if two scopes interleave.
 */
export function withFlags<F extends FlagMap, Features extends Record<string, FeatureDef>, T>(
  manifest: FlagManifest<F, Features>,
  overrides: FlagOverrides<F, Features>,
  fn: () => T,
): T {
  const previous = hasDefaultFlags() ? getDefaultFlags() : undefined;
  setDefaultFlags(buildTestFlags(manifest, overrides));
  try {
    const result = fn();
    if (isThenable(result)) {
      // An async body would read flags after `finally` has already restored the prior snapshot, so
      // its post-await reads would silently see the wrong flags. Fail loudly instead.
      throw new Error(
        "withFlags requires a synchronous callback; it returned a thenable. Use " +
          "setFlagsForTesting()/resetFlags() to scope flags across awaits.",
      );
    }
    return result;
  } finally {
    if (previous) setDefaultFlags(previous);
    else clearDefaultFlags();
  }
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Clear the installed snapshot and re-arm once-per-process deprecation warnings. */
export function resetFlags(): void {
  clearDefaultFlags();
  resetFlagDeprecationWarnings();
}
