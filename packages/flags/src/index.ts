// Public surface of @lorenz/flags. Kept deliberately small: only what the composition root needs to
// declare a manifest, resolve it, and install the snapshot. Internal helpers (coercion primitives,
// the issue collector, env-name encoding, the raw singleton holder, key guards) stay unexported so
// the engine-internal boundary is not widened. Test seams live in the `./testing` subpath.

export type {
  FeatureDef,
  FeatureInput,
  FeatureKeyOf,
  FeatureMapFor,
  FlagDef,
  FlagDeprecation,
  FlagInput,
  FlagIssue,
  FlagIssueKind,
  FlagKeyOf,
  FlagKind,
  FlagManifest,
  FlagMap,
  FlagOverrides,
  FlagsSnapshot,
  FlagValue,
  FlagValuesOf,
  LayerSource,
  PresetFor,
  RawLayer,
  RawLayers,
  ResolveOptions,
} from "./types.js";

export {
  bindFlags,
  defineFeatures,
  defineFlags,
  feature,
  flag,
  validateManifest,
  type BoundFlags,
} from "./manifest.js";
export { featureKeys } from "./keys.js";
export { flagInputsFromEnv } from "./env.js";
export { flagInputsFromCli, flagInputsFromFile } from "./layers.js";
export { resolveFlags } from "./resolve.js";
export { setDefaultFlags } from "./default.js";
