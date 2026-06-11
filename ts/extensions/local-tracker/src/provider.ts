import type { TrackerProvider } from "@symphony/tracker-sdk";
import { rejectUnknownOptions, stringOption } from "@symphony/tracker-sdk";

import { LocalTrackerClient } from "./client.js";
import { DEFAULT_BOARD_DIR } from "./resolveBoardDir.js";
import { DEFAULT_ID_PREFIX } from "./boardStore.js";
import { localTrackerOptions } from "./options.js";
import { localToolOps } from "./toolOps.js";

/**
 * Issue-id prefixes must be filesystem-safe so `<prefix><n>.md` can never escape the board
 * dir. BoardStore re-checks this at runtime; validating here surfaces the error at config
 * load with the user-facing key name.
 */
const LOCAL_ID_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function assertValidLocalIdPrefix(prefix: string): void {
  if (!LOCAL_ID_PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      `tracker.id_prefix ${JSON.stringify(prefix)} is invalid: ` +
        `must start alphanumeric, then only letters, digits, "_" or "-"`,
    );
  }
}

/** Markdown-file board tracker: issues are `<prefix><n>.md` files in a local directory. */
export const localTrackerProvider: TrackerProvider = {
  kind: "local",
  configAliases: { id_prefix: "idPrefix" },
  parseOptions(options) {
    rejectUnknownOptions(options, ["path", "idPrefix"], "local");
    const path = stringOption(options, "path") ?? DEFAULT_BOARD_DIR;
    const idPrefix = stringOption(options, "idPrefix") ?? DEFAULT_ID_PREFIX;
    assertValidLocalIdPrefix(idPrefix);
    return { path, idPrefix };
  },
  validateDispatch(settings) {
    const { path } = localTrackerOptions(settings);
    if (path === undefined || path.trim() === "") {
      throw new Error("tracker.path (board directory) is required for the local tracker");
    }
  },
  createClient(settings, context) {
    return new LocalTrackerClient(settings, process.cwd(), context.env);
  },
  createToolOps: (settings) => localToolOps(settings),
};
