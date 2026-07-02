import {
  bindFlags,
  defineFeatures,
  defineFlags,
  feature,
  flag,
  flagInputsFromCli,
  flagInputsFromEnv,
  flagInputsFromFile,
  featureKeys,
  resolveFlags,
  validateManifest,
  type FeatureKeyOf,
  type FlagKeyOf,
  type FlagManifest,
  type FlagsSnapshot,
} from "@lorenz/flags";

// The composition root owns the concrete flag/feature manifest; `@lorenz/flags` itself stays
// manifest-agnostic. The valid key universe is declared once here, so unknown keys fail explicitly
// at every layer. (When an engine package needs to read a flag with its precise type, this manifest
// moves to that engine package and the daemon imports it from there.)
const flags = defineFlags({
  "diagnostics.log_flag_resolution": flag.bool({
    default: false,
    description: "Write the resolved flag set to stderr at startup.",
    envName: "LORENZ_FLAG_DIAGNOSTICS__LOG_FLAG_RESOLUTION",
  }),
  "diagnostics.detail": flag.enum({
    values: ["summary", "full"],
    default: "summary",
    description:
      "Startup flag-dump detail: summary lists non-default flags, full lists every flag and feature.",
    envName: "LORENZ_FLAG_DIAGNOSTICS__DETAIL",
  }),
  "diagnostics.sample_limit": flag.int({
    default: 20,
    refine: (n) => n >= 0,
    refineMessage: "must be a non-negative integer",
    description: "Maximum flags to print in the startup dump (0 = no limit).",
    envName: "LORENZ_FLAG_DIAGNOSTICS__SAMPLE_LIMIT",
  }),
  "daemon.enabled": flag.bool({
    default: false,
    description:
      "Run the orchestrator as a long-lived single-instance daemon (leadership lock, heartbeat, and HTTP control endpoints).",
  }),
  "claim_store.backend": flag.enum({
    values: ["memory", "sqlite", "turso"],
    default: "memory",
    description: "Orchestrator claim store implementation.",
  }),
  "claim_store.path": flag.string({
    default: "",
    description:
      "Durable claim store database path (empty derives a path under the workflow workspace).",
  }),
  "claim_store.owner_stale_ms": flag.int({
    default: 0,
    refine: (n) => n >= 0,
    refineMessage: "must be a non-negative integer",
    description: "Claim owner lease stale threshold in ms (0 uses the store default).",
  }),
});

const features = defineFeatures(flags, {
  verbose_diagnostics: feature({
    default: false,
    description: "Dump the full resolved flag set to stderr at startup.",
    preset: { "diagnostics.log_flag_resolution": true, "diagnostics.detail": "full" },
    envName: "LORENZ_FEATURE_VERBOSE_DIAGNOSTICS",
  }),
  daemon: feature({
    default: false,
    description: "Run the orchestrator as a long-lived single-instance daemon.",
    preset: { "daemon.enabled": true },
  }),
  durable_claims: feature({
    default: false,
    description: "Persist orchestrator claims durably with the SQLite backend.",
    preset: { "claim_store.backend": "sqlite" },
  }),
});

const appManifest: FlagManifest<typeof flags, typeof features> = { flags, features };

// Fail fast in CI if the manifest is internally inconsistent (bad default / bad preset).
validateManifest(appManifest);

type AppFlags = typeof flags;
type AppFeatures = typeof features;
export type AppFlagsSnapshot = FlagsSnapshot<AppFlags, AppFeatures>;
type AppFlagKey = FlagKeyOf<AppFlags>;
type AppFeatureKey = FeatureKeyOf<AppFeatures>;

const bound = bindFlags(appManifest);

/** Typed ambient accessor for the installed snapshot. Reads after `setDefaultFlags` at startup. */
export function getFlags(): AppFlagsSnapshot {
  return bound.getFlags();
}

export interface FlagCliInputs {
  // Optional so a programmatic caller can omit them to mean "no CLI flag overrides" rather than
  // being forced to pass empty arrays; the daemon always supplies arrays from commander.
  readonly flagTokens?: readonly string[] | undefined;
  readonly featureTokens?: readonly string[] | undefined;
}

/** Commander accumulator for repeatable options: collects raw tokens, does no validation. */
export function accumulateOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Resolve the app's flags from the three layers. Does NOT install the snapshot; the caller does. */
export function resolveAppFlags(
  inputs: FlagCliInputs,
  fileConfig: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  options: { warn?: ((message: string) => void) | undefined } = {},
): AppFlagsSnapshot {
  return resolveFlags(
    appManifest,
    {
      cli: flagInputsFromCli(appManifest, inputs.flagTokens ?? [], inputs.featureTokens ?? []),
      file: flagInputsFromFile(appManifest, fileConfig),
      env: flagInputsFromEnv(appManifest, env),
    },
    options,
  );
}

/** Render the resolved flag set with provenance for the startup dump and `lorenz doctor`. */
export function renderFlagDiagnostics(snapshot: AppFlagsSnapshot): string {
  const full = snapshot.get("diagnostics.detail") === "full";
  const limit = snapshot.get("diagnostics.sample_limit");
  const entries = Object.entries(snapshot.values).filter(
    ([key]) => full || snapshot.source(key as AppFlagKey) !== "default",
  );
  const shown = limit > 0 ? entries.slice(0, limit) : entries;
  const lines = shown.map(
    ([key, value]) => `  ${key} = ${JSON.stringify(value)} (${snapshot.source(key as AppFlagKey)})`,
  );
  if (shown.length < entries.length) {
    lines.push(`  ... and ${entries.length - shown.length} more (raise diagnostics.sample_limit)`);
  }
  if (full) {
    const enabled = featureKeys(appManifest).filter((name) =>
      snapshot.feature(name as AppFeatureKey),
    );
    lines.push(`  features enabled: ${enabled.length > 0 ? enabled.join(", ") : "(none)"}`);
  }
  const header = full ? "Resolved flags (full):" : "Resolved flags (non-default):";
  return `${header}\n${lines.join("\n")}\n`;
}
