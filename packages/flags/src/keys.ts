import type { FlagManifest } from "./types.js";

// `hasOwnProperty` (not the `in` operator) so inherited names like `constructor`/`toString` are not
// mistaken for declared keys: `isFlagKey(m, "constructor")` must be false so unknown keys fail.

export function isFlagKey(manifest: FlagManifest, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(manifest.flags, key);
}

export function isFeatureKey(manifest: FlagManifest, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(manifest.features, name);
}

export function flagKeys(manifest: FlagManifest): readonly string[] {
  return Object.keys(manifest.flags).sort();
}

export function featureKeys(manifest: FlagManifest): readonly string[] {
  return Object.keys(manifest.features).sort();
}
