import { defineFeatures, defineFlags, feature, flag, type FlagManifest } from "@lorenz/flags";

// Shared manifest exercising every flag kind, a dotted key, presets, a preset conflict pair, and
// flag/feature deprecations. Used across the package's resolve/parsing/seam tests.

export const flags = defineFlags({
  timeout_ms: flag.int({ default: 30000, description: "Request timeout in milliseconds." }),
  retries: flag.int({
    default: 3,
    refine: (n) => n >= 0,
    refineMessage: "must be a non-negative integer",
    description: "Retry attempts.",
  }),
  ratio: flag.float({ default: 1.5, description: "A scaling ratio." }),
  log_level: flag.enum({ values: ["info", "debug"], default: "info", description: "Log level." }),
  label: flag.string({ default: "default", description: "An arbitrary label." }),
  verbose: flag.bool({ default: false, description: "Verbose output." }),
  "pool.size": flag.int({ default: 4, description: "Worker pool size." }),
  legacy_timeout: flag.int({
    default: 30000,
    description: "Deprecated request timeout.",
    deprecation: { detail: "Express the value in milliseconds." },
  }),
});

export const features = defineFeatures(flags, {
  fast_mode: feature({
    default: false,
    description: "Aggressive timeouts and minimal retries.",
    preset: { timeout_ms: 1000, retries: 1 },
  }),
  safe_mode: feature({
    default: false,
    description: "Generous timeouts and extra retries.",
    preset: { timeout_ms: 60000, retries: 5 },
  }),
  chatty: feature({
    default: false,
    description: "Verbose debug logging.",
    preset: { log_level: "debug", verbose: true },
  }),
  legacy: feature({
    default: false,
    description: "Deprecated feature with no preset.",
    preset: {},
    deprecation: {},
  }),
});

export const manifest: FlagManifest<typeof flags, typeof features> = { flags, features };
