import type { Settings } from "@lorenz/domain";
import { stringOption } from "@lorenz/tracker-sdk";

import { resolveBoardDir } from "./resolveBoardDir.js";

/** Local-board-specific keys of the selected tracker bundle, validated by the provider. */
export interface LocalTrackerOptions {
  /** Board directory (e.g. `.lorenz/local`); resolved relative to cwd when not absolute. */
  path?: string | undefined;
  /**
   * Issue-id prefix (e.g. `"BOARD-"`, `"XXX-"`). Issue files are `<prefix><n>.md` and new
   * ids are minted with this prefix.
   */
  idPrefix?: string | undefined;
}

/** Typed view over `settings.tracker.options` for the local board provider. */
export function localTrackerOptions(settings: Settings): LocalTrackerOptions {
  const options = settings.tracker.options;
  return {
    path: stringOption(options, "path"),
    idPrefix: stringOption(options, "idPrefix"),
  };
}

/** Keys of the pack's `tools.local` slice. */
const LOCAL_PACK_OPTION_KEYS: Record<string, "path" | "idPrefix"> = {
  path: "path",
  idPrefix: "idPrefix",
  id_prefix: "idPrefix",
};

/**
 * Board location for the local TOOL pack. Prefers the pack's own `tools.local` slice, then
 * falls back to `tracker.options` when the local board drives dispatch.
 */
export function localToolPackOptions(settings: Settings): LocalTrackerOptions {
  const packOptions = normalizeLocalPackOptions(settings.toolOptions?.["local"] ?? {});
  const trackerFallback =
    settings.tracker.kind === "local" ? localTrackerOptions(settings) : ({} as LocalTrackerOptions);
  return {
    path: packOptions.path ?? trackerFallback.path,
    idPrefix: packOptions.idPrefix ?? trackerFallback.idPrefix,
  };
}

/**
 * Validate the pack's `tools.local` slice; backs `localToolProvider.validateOptions`.
 * Errors name the offending `tools.local.<key>` so config typos fail at startup.
 */
export function validateLocalToolOptions(options: Record<string, unknown>): void {
  normalizeLocalPackOptions(options);
}

const LOCAL_ID_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Shared id-prefix validation for the tracker options and the pack's tool options slice. */
export function assertLocalIdPrefix(prefix: string, label: string): void {
  if (!LOCAL_ID_PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      `${label} ${JSON.stringify(prefix)} is invalid: ` +
        `must start alphanumeric, then only letters, digits, "_" or "-"`,
    );
  }
}

function normalizeLocalPackOptions(options: Record<string, unknown>): LocalTrackerOptions {
  const normalized: { path?: string | undefined; idPrefix?: string | undefined } = {};
  for (const [key, value] of Object.entries(options)) {
    const canonical = LOCAL_PACK_OPTION_KEYS[key];
    if (canonical === undefined) {
      throw new Error(
        `tools.local.${key} is not supported (known keys: ${Object.keys(LOCAL_PACK_OPTION_KEYS).join(", ")})`,
      );
    }
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw new Error(`tools.local.${key} must be a string`);
    }
    if (canonical === "path" && value.trim() === "") {
      throw new Error(`tools.local.${key} must not be empty`);
    }
    if (canonical === "idPrefix") assertLocalIdPrefix(value, `tools.local.${key}`);
    normalized[canonical] = value;
  }
  return normalized;
}

/** Absolute on-disk board directory for the configured settings. */
export function localBoardDir(
  settings: Settings,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  return resolveBoardDir(localTrackerOptions(settings).path, opts);
}
