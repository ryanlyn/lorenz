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

/** Absolute on-disk board directory for the configured settings. */
export function localBoardDir(
  settings: Settings,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  return resolveBoardDir(localTrackerOptions(settings).path, opts);
}
