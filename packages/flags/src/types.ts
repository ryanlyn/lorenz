import type { z } from "zod";

// Pure type surface for the package. Every other module imports its types from here, so the value
// modules (manifest, errors, resolve, ...) form an acyclic graph and never trip the `no-circular`
// architecture rule.

/** Per-key deprecation marker. `detail` adds optional guidance to the warning. */
export interface FlagDeprecation {
  readonly detail?: string | undefined;
}

export type FlagKind = "string" | "int" | "float" | "bool" | "enum";

/** A single flag declaration. `schema`'s output is the flag's value type; `default` is that type. */
export interface FlagDef<Schema extends z.ZodType = z.ZodType> {
  readonly kind: FlagKind;
  readonly schema: Schema;
  readonly default: z.output<Schema>;
  readonly description: string;
  readonly deprecation?: FlagDeprecation | undefined;
  /** enum only: the allowed values, surfaced in error/help text. */
  readonly values?: readonly string[] | undefined;
  /**
   * Explicit, arbitrary env var name this flag reads from. Optional: a flag with no `envName` is
   * config/CLI-only and is never read from the environment. There is no key-derived default and no
   * reserved prefix - the name is whatever the author writes.
   */
  readonly envName?: string | undefined;
}

/** A feature: a named boolean whose enablement applies a preset of flag default-overrides. */
export interface FeatureDef<Preset extends Record<string, unknown> = Record<string, unknown>> {
  readonly default: boolean;
  readonly description: string;
  readonly preset: Preset;
  readonly deprecation?: FlagDeprecation | undefined;
  /**
   * Explicit, arbitrary env var name this feature reads from. Optional: a feature with no `envName`
   * is config/CLI-only and is never read from the environment. There is no name-derived default and
   * no reserved prefix.
   */
  readonly envName?: string | undefined;
}

export type FlagMap = Record<string, FlagDef>;

export type FlagValue<D extends FlagDef> = D extends FlagDef<infer S> ? z.output<S> : never;
export type FlagKeyOf<F extends FlagMap> = keyof F & string;
export type FlagValuesOf<F extends FlagMap> = { [K in keyof F]: FlagValue<F[K]> };
export type PresetFor<F extends FlagMap> = Partial<FlagValuesOf<F>>;
export type FeatureMapFor<F extends FlagMap> = Record<string, FeatureDef<PresetFor<F>>>;
export type FeatureKeyOf<Features extends Record<string, FeatureDef>> = keyof Features & string;

export interface FlagManifest<
  F extends FlagMap = FlagMap,
  Features extends Record<string, FeatureDef> = Record<string, FeatureDef>,
> {
  readonly flags: F;
  readonly features: Features;
}

/** Where a resolved value came from. `feature` means an enabled feature's preset supplied it. */
export type LayerSource = "cli" | "file" | "env" | "feature" | "default";

export interface FlagInput {
  readonly source: LayerSource;
  readonly key: string;
  readonly rawValue: unknown;
  /** Human-facing label of where this came from, e.g. `--flag x=1` or `LORENZ_FLAG_X`. */
  readonly origin: string;
}

export interface FeatureInput {
  readonly source: LayerSource;
  readonly name: string;
  readonly enabled: boolean;
  readonly origin: string;
}

export type FlagIssueKind =
  | "unknown_flag"
  | "unknown_feature"
  | "invalid_value"
  | "preset_conflict";

export interface FlagIssue {
  readonly kind: FlagIssueKind;
  readonly message: string;
}

export interface RawLayer {
  readonly flags: readonly FlagInput[];
  readonly features: readonly FeatureInput[];
  /** Problems a parser detected but deferred to the resolver's collect-all aggregation. */
  readonly issues?: readonly FlagIssue[] | undefined;
}

/** The three explicit layers, in HIGH-to-LOW precedence order. */
export interface RawLayers {
  readonly cli: RawLayer;
  readonly file: RawLayer;
  readonly env: RawLayer;
}

export interface ResolveOptions {
  /** Sink for once-per-process deprecation warnings. Defaults to a stderr `warning:` writer. */
  readonly warn?: ((message: string) => void) | undefined;
}

/** A fully-resolved, immutable view. Values are already coerced and validated. */
export interface FlagsSnapshot<
  F extends FlagMap = FlagMap,
  Features extends Record<string, FeatureDef> = Record<string, FeatureDef>,
> {
  /** Typed flag read; the return type is exactly this key's value type. */
  get<K extends FlagKeyOf<F>>(key: K): FlagValue<F[K]>;
  /** Effective feature state after all layers. */
  feature(key: FeatureKeyOf<Features>): boolean;
  /** Frozen value map, for snapshotting into logs/traces. */
  readonly values: Readonly<{ [K in keyof F]: FlagValue<F[K]> }>;
  /** Per-flag provenance, for diagnostics (e.g. "timeout_ms came from cli"). */
  source(key: FlagKeyOf<F>): LayerSource;
}

export interface FlagOverrides<F extends FlagMap, Features extends Record<string, FeatureDef>> {
  flags?: Partial<FlagValuesOf<F>> | undefined;
  features?: Partial<Record<FeatureKeyOf<Features>, boolean>> | undefined;
}
