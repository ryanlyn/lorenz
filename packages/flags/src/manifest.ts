import { z } from "zod";

import { coercedBoolean, coercedFloat, coercedInt } from "./coerce.js";
import { getDefaultFlags } from "./default.js";
import { flagValueErrorMessage } from "./errors.js";
import type {
  FeatureDef,
  FeatureMapFor,
  FlagDef,
  FlagDeprecation,
  FlagManifest,
  FlagMap,
  FlagsSnapshot,
} from "./types.js";

interface BaseFlagConfig {
  readonly description: string;
  readonly deprecation?: FlagDeprecation | undefined;
  readonly envName?: string | undefined;
}
interface StringFlagConfig extends BaseFlagConfig {
  readonly default: string;
}
interface NumberFlagConfig extends BaseFlagConfig {
  readonly default: number;
  /** Optional extra constraint (e.g. `(n) => n >= 1`) applied on top of int/float coercion. */
  readonly refine?: ((n: number) => boolean) | undefined;
  readonly refineMessage?: string | undefined;
}
interface BoolFlagConfig extends BaseFlagConfig {
  readonly default: boolean;
}
interface EnumFlagConfig<V extends readonly [string, ...string[]]> extends BaseFlagConfig {
  readonly values: V;
  readonly default: V[number];
}

function refinedNumber(
  base: z.ZodType<number, string | number>,
  config: NumberFlagConfig,
): z.ZodType<number, string | number> {
  if (!config.refine) return base;
  const refine = config.refine;
  return base.refine(refine, { message: config.refineMessage ?? "is invalid" });
}

/** Builders for the five flag kinds. Each returns a {@link FlagDef} whose schema output is the
 *  flag's value type; numeric and boolean schemas coerce string inputs from env/CLI/file. */
export const flag = {
  string(config: StringFlagConfig): FlagDef<z.ZodString> {
    return {
      kind: "string",
      schema: z.string(),
      default: config.default,
      description: config.description,
      deprecation: config.deprecation,
      envName: config.envName,
    };
  },
  int(config: NumberFlagConfig): FlagDef<z.ZodType<number, string | number>> {
    return {
      kind: "int",
      schema: refinedNumber(coercedInt, config),
      default: config.default,
      description: config.description,
      deprecation: config.deprecation,
      envName: config.envName,
    };
  },
  float(config: NumberFlagConfig): FlagDef<z.ZodType<number, string | number>> {
    return {
      kind: "float",
      schema: refinedNumber(coercedFloat, config),
      default: config.default,
      description: config.description,
      deprecation: config.deprecation,
      envName: config.envName,
    };
  },
  bool(config: BoolFlagConfig): FlagDef<z.ZodType<boolean, string | boolean>> {
    return {
      kind: "bool",
      schema: coercedBoolean,
      default: config.default,
      description: config.description,
      deprecation: config.deprecation,
      envName: config.envName,
    };
  },
  enum<const V extends readonly [string, ...string[]]>(config: EnumFlagConfig<V>) {
    // The return type is inferred from the actual `z.enum(values)` call, so `FlagValue<thisDef>`
    // narrows to the exact literal union rather than a hand-asserted type.
    const schema = z.enum(config.values);
    return {
      kind: "enum",
      schema,
      default: config.default,
      description: config.description,
      deprecation: config.deprecation,
      values: config.values,
      envName: config.envName,
    } satisfies FlagDef<typeof schema>;
  },
} as const;

export function feature<const Preset extends Record<string, unknown>>(config: {
  readonly default: boolean;
  readonly description: string;
  readonly preset: Preset;
  readonly deprecation?: FlagDeprecation | undefined;
  readonly envName?: string | undefined;
}): FeatureDef<Preset> {
  return config;
}

// Keys are lower_snake_case dotted segments only, for a single consistent key vocabulary across the
// manifest, config file, and CLI tokens. The rule is enforced at module load so a stray camelCase
// key fails fast in CI, not at daemon start. (Env var names are declared separately and explicitly
// via each entry's `envName`; they are not derived from the key.)
const SNAKE_KEY = /^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)*$/;

function assertSnakeKeys(keys: readonly string[], what: string): void {
  for (const key of keys) {
    if (!SNAKE_KEY.test(key)) {
      throw new Error(
        `@lorenz/flags: ${what} key \`${key}\` must be lower_snake_case dotted ` +
          `(e.g. scheduler.batch_size); camelCase is not allowed.`,
      );
    }
  }
}

export function defineFlags<const F extends FlagMap>(flags: F): F {
  assertSnakeKeys(Object.keys(flags), "flag");
  return flags;
}

export function defineFeatures<const F extends FlagMap, const Features extends FeatureMapFor<F>>(
  _flags: F,
  features: Features,
): Features {
  assertSnakeKeys(Object.keys(features), "feature");
  return features;
}

/** Scalar-only value set, so reference identity via `Object.is` is correct and obvious. */
export function presetValueEqual(a: unknown, b: unknown): boolean {
  return Object.is(a, b);
}

/**
 * Validate a manifest once at module load: every flag default parses, and every preset references a
 * known flag with a valid value. Two features presetting the same flag to differing values is
 * intentionally allowed (legal for mutually-exclusive features); that conflict is authoritative only
 * over the actually-enabled set at resolve time.
 */
export function validateManifest(manifest: FlagManifest): void {
  const errors: string[] = [];
  for (const [key, def] of Object.entries(manifest.flags)) {
    const result = def.schema.safeParse(def.default);
    if (!result.success) {
      errors.push(
        `flag \`${key}\` default is invalid: ${flagValueErrorMessage(result.error, def)}`,
      );
    }
  }
  for (const [featureName, featureDef] of Object.entries(manifest.features)) {
    for (const [flagKey, value] of Object.entries(featureDef.preset)) {
      const flagDef = manifest.flags[flagKey];
      if (!flagDef) {
        errors.push(`feature \`${featureName}\` presets unknown flag \`${flagKey}\``);
        continue;
      }
      const result = flagDef.schema.safeParse(value);
      if (!result.success) {
        errors.push(
          `feature \`${featureName}\` presets \`${flagKey}\` to an invalid value: ${flagValueErrorMessage(result.error, flagDef)}`,
        );
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`@lorenz/flags manifest is invalid:\n  - ${errors.join("\n  - ")}`);
  }
}

export interface BoundFlags<F extends FlagMap, Features extends Record<string, FeatureDef>> {
  /** Typed ambient accessor: the installed snapshot, narrowed to this manifest. */
  getFlags(): FlagsSnapshot<F, Features>;
}

/**
 * Bind a manifest to typed ambient accessors. Called once by the manifest-owning module; the rest
 * of the engine imports the returned `getFlags`/`flag`, so ambient reads are as well-typed as the
 * manifest. The cast is sound because the composition root installs a snapshot built from the same
 * manifest, and it is contained to this one factory.
 */
export function bindFlags<F extends FlagMap, Features extends Record<string, FeatureDef>>(
  _manifest: FlagManifest<F, Features>,
): BoundFlags<F, Features> {
  return {
    getFlags: () => getDefaultFlags() as FlagsSnapshot<F, Features>,
  };
}
