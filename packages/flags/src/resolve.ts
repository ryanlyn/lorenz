import { parseBoolToken } from "./coerce.js";
import { collectFlagDeprecations, commitFlagDeprecations, stderrFlagWarn } from "./deprecations.js";
import { FlagIssueCollector, flagValueErrorMessage } from "./errors.js";
import { presetValueEqual } from "./manifest.js";
import type {
  FeatureDef,
  FeatureInput,
  FlagDef,
  FlagInput,
  FlagManifest,
  FlagMap,
  FlagsSnapshot,
  LayerSource,
  RawLayers,
  ResolveOptions,
} from "./types.js";

interface ResolvedFlag {
  readonly value: unknown;
  readonly source: LayerSource;
}

type ParseOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/**
 * Fold the CLI, file, and env layers, plus enabled-feature presets and manifest defaults, into one
 * frozen snapshot. All problems aggregate into a single thrown error (collect-all). Deprecation
 * warnings are staged during resolution and committed only on success.
 */
export function resolveFlags<F extends FlagMap, Features extends Record<string, FeatureDef>>(
  manifest: FlagManifest<F, Features>,
  layers: RawLayers,
  options: ResolveOptions = {},
): FlagsSnapshot<F, Features> {
  const issues = new FlagIssueCollector();
  for (const layer of [layers.cli, layers.file, layers.env]) {
    if (layer.issues) issues.addAll(layer.issues);
  }

  // Per-layer last-wins maps of explicit flag inputs (parsers guarantee known keys).
  const cliFlags = lastWins(layers.cli.flags);
  const fileFlags = lastWins(layers.file.flags);
  const envFlags = lastWins(layers.env.flags);
  const explicitFlagKeys = new Set<string>([
    ...cliFlags.keys(),
    ...fileFlags.keys(),
    ...envFlags.keys(),
  ]);

  // Feature enablement: the highest layer that mentions the feature wins; otherwise its default.
  const enabled = new Map<string, boolean>();
  for (const [name, def] of Object.entries(manifest.features)) {
    const chosen =
      featureInLayer(layers.cli.features, name) ??
      featureInLayer(layers.file.features, name) ??
      featureInLayer(layers.env.features, name);
    enabled.set(name, chosen ? chosen.enabled : def.default);
  }

  // Preset composition over enabled features only, skipping any explicitly-set flag (an explicit
  // setting both overrides and defuses a would-be conflict). Differing values from two enabled
  // features that both reach this point is a hard, deterministic error.
  const presetValue = new Map<string, unknown>();
  const presetOwner = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const [featureName, featureDef] of Object.entries(manifest.features)) {
    if (!enabled.get(featureName)) continue;
    for (const [flagKey, value] of Object.entries(featureDef.preset)) {
      if (explicitFlagKeys.has(flagKey)) continue;
      if (presetValue.has(flagKey)) {
        const existing = presetValue.get(flagKey);
        if (!presetValueEqual(existing, value) && !conflicts.has(flagKey)) {
          conflicts.add(flagKey);
          issues.add({
            kind: "preset_conflict",
            message:
              `feature preset conflict on flag \`${flagKey}\`: feature \`${presetOwner.get(flagKey) ?? "?"}\` ` +
              `sets it to ${display(existing)} but feature \`${featureName}\` sets it to ${display(value)}. ` +
              `Enable only one, or set \`${flagKey}\` explicitly to override both.`,
          });
        }
        continue;
      }
      presetValue.set(flagKey, value);
      presetOwner.set(flagKey, featureName);
    }
  }

  // Flag value resolution: highest explicit layer -> enabled-feature preset -> manifest default.
  const resolved = new Map<string, ResolvedFlag>();
  for (const [key, def] of Object.entries(manifest.flags)) {
    const explicit = cliFlags.get(key) ?? fileFlags.get(key) ?? envFlags.get(key);
    if (explicit) {
      const outcome = parseFlagValue(def, explicit.rawValue);
      if (outcome.ok) resolved.set(key, { value: outcome.value, source: explicit.source });
      else
        issues.add({
          kind: "invalid_value",
          message: `invalid value for ${explicit.origin}: ${outcome.message}`,
        });
      continue;
    }
    if (presetValue.has(key) && !conflicts.has(key)) {
      // Preset values were validated at manifest load; re-validate defensively against the schema.
      const outcome = parseFlagValue(def, presetValue.get(key));
      if (outcome.ok) resolved.set(key, { value: outcome.value, source: "feature" });
      else
        issues.add({
          kind: "invalid_value",
          message: `feature preset for flag \`${key}\` is invalid: ${outcome.message}`,
        });
      continue;
    }
    resolved.set(key, { value: def.default, source: "default" });
  }

  // Stage deprecation warnings for explicitly-set keys that resolved successfully. A deprecated flag
  // set to an invalid value is absent from `resolved`, so it neither warns nor consumes a slot.
  const explicitDeprecationKeys: { key: string; isFeature: boolean }[] = [];
  for (const key of explicitFlagKeys) {
    if (resolved.get(key)?.source !== "default" && resolved.has(key)) {
      explicitDeprecationKeys.push({ key, isFeature: false });
    }
  }
  for (const name of explicitlyMentionedFeatures(layers)) {
    explicitDeprecationKeys.push({ key: name, isFeature: true });
  }
  const staged = collectFlagDeprecations(explicitDeprecationKeys, manifest);

  issues.throwIfAny();

  commitFlagDeprecations(staged, options.warn ?? stderrFlagWarn);
  return buildSnapshot<F, Features>(resolved, enabled);
}

function parseFlagValue(def: FlagDef, raw: unknown): ParseOutcome {
  // Boolean tokens are normalized (case-insensitive) before the schema sees them, so env/CLI/file
  // booleans behave identically.
  let input = raw;
  if (def.kind === "bool") {
    const parsed = parseBoolToken(raw);
    if (parsed === undefined) return { ok: false, message: "must be true or false" };
    input = parsed;
  }
  const result = def.schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, message: flagValueErrorMessage(result.error, def) };
}

function buildSnapshot<F extends FlagMap, Features extends Record<string, FeatureDef>>(
  resolved: Map<string, ResolvedFlag>,
  enabled: Map<string, boolean>,
): FlagsSnapshot<F, Features> {
  const values: Record<string, unknown> = {};
  const sources = new Map<string, LayerSource>();
  for (const [key, entry] of resolved) {
    values[key] = entry.value;
    sources.set(key, entry.source);
  }
  Object.freeze(values);

  const snapshot: FlagsSnapshot<F, Features> = {
    get: (key) => {
      const name = key as string;
      if (!Object.prototype.hasOwnProperty.call(values, name)) {
        throw new Error(`unknown flag \`${name}\``);
      }
      return values[name] as never;
    },
    feature: (key) => {
      const value = enabled.get(key);
      if (value === undefined) throw new Error(`unknown feature \`${String(key)}\``);
      return value;
    },
    values: values as Readonly<{ [K in keyof F]: never }>,
    source: (key) => {
      const value = sources.get(key);
      if (value === undefined) throw new Error(`unknown flag \`${String(key)}\``);
      return value;
    },
  };
  return Object.freeze(snapshot);
}

function lastWins(inputs: readonly FlagInput[]): Map<string, FlagInput> {
  const map = new Map<string, FlagInput>();
  for (const input of inputs) map.set(input.key, input);
  return map;
}

function featureInLayer(inputs: readonly FeatureInput[], name: string): FeatureInput | undefined {
  let found: FeatureInput | undefined;
  for (const input of inputs) if (input.name === name) found = input;
  return found;
}

function explicitlyMentionedFeatures(layers: RawLayers): Set<string> {
  const names = new Set<string>();
  for (const layer of [layers.cli, layers.file, layers.env]) {
    for (const input of layer.features) names.add(input.name);
  }
  return names;
}

function display(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
