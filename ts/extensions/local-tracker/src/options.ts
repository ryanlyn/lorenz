import type { Settings } from "@symphony/domain";
import { stringOption } from "@symphony/tracker-sdk";

import { resolveBoardDir } from "./resolveBoardDir.js";

/** Local-board-specific keys of the `tracker:` config section, validated by the provider. */
export interface LocalTrackerOptions {
  /** Board directory (e.g. `.symphony/local`); resolved relative to cwd when not absolute. */
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

/** Keys of the pack's `tool_options.local` slice, with the snake_case spelling accepted. */
const LOCAL_PACK_OPTION_KEYS: Record<string, "path" | "idPrefix"> = {
  path: "path",
  idPrefix: "idPrefix",
  id_prefix: "idPrefix",
};

/**
 * Board location for the local TOOL pack. Prefers the pack's own `tool_options.local`
 * slice, so a mounted pack works on any dispatch tracker; falls back to `tracker.options`
 * only when the local board also drives dispatch.
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
 * Validate the pack's `tool_options.local` slice; backs `localToolProvider.validateOptions`.
 * Errors name the offending `tool_options.local.<key>` so config typos fail at startup.
 */
export function validateLocalToolOptions(options: Record<string, unknown>): void {
  normalizeLocalPackOptions(options);
}

function normalizeLocalPackOptions(options: Record<string, unknown>): LocalTrackerOptions {
  const normalized: { path?: string | undefined; idPrefix?: string | undefined } = {};
  for (const [key, value] of Object.entries(options)) {
    const canonical = LOCAL_PACK_OPTION_KEYS[key];
    if (canonical === undefined) {
      throw new Error(
        `tool_options.local.${key} is not supported (known keys: ${Object.keys(LOCAL_PACK_OPTION_KEYS).join(", ")})`,
      );
    }
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw new Error(`tool_options.local.${key} must be a string`);
    }
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
