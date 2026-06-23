import type { FlagDeprecation, FlagManifest } from "./types.js";

function formatFlagDeprecation(key: string, deprecation: FlagDeprecation): string {
  const base = `\`${key}\` is deprecated.`;
  return deprecation.detail ? `${base} ${deprecation.detail}` : base;
}

export function stderrFlagWarn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

// Once-per-process dedup, so a deprecated key set on every poll/reload warns only once.
const warnedDeprecations = new Set<string>();

export interface StagedDeprecation {
  readonly key: string;
  readonly message: string;
}

/**
 * Stage (but do not emit) deprecation warnings for the given explicitly-set keys. The resolver
 * stages during resolution and only {@link commitFlagDeprecations commits} if the overall resolve
 * succeeds, so a resolve that throws never consumes a once-per-process warning slot.
 */
export function collectFlagDeprecations(
  explicitKeys: readonly { readonly key: string; readonly isFeature: boolean }[],
  manifest: FlagManifest,
): StagedDeprecation[] {
  const staged: StagedDeprecation[] = [];
  for (const { key, isFeature } of explicitKeys) {
    const deprecation = isFeature
      ? manifest.features[key]?.deprecation
      : manifest.flags[key]?.deprecation;
    if (deprecation) staged.push({ key, message: formatFlagDeprecation(key, deprecation) });
  }
  return staged;
}

/** Commit staged warnings to the once-per-process dedup set and emit the not-yet-seen ones. */
export function commitFlagDeprecations(
  staged: readonly StagedDeprecation[],
  warn: (message: string) => void = stderrFlagWarn,
): string[] {
  const emitted: string[] = [];
  for (const { key, message } of staged) {
    if (warnedDeprecations.has(key)) continue;
    warnedDeprecations.add(key);
    warn(message);
    emitted.push(key);
  }
  return emitted;
}

/** Test seam: clear the once-per-process dedup set so a fresh snapshot re-warns. */
export function resetFlagDeprecationWarnings(): void {
  warnedDeprecations.clear();
}
