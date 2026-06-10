import path from "node:path";

/** The board directory used when no tracker.path is configured. */
export const DEFAULT_BOARD_DIR = ".symphony/local";

/**
 * Resolve the on-disk board directory from a configured tracker.path.
 *
 * This is the single source of truth shared by the read path (LocalTrackerClient,
 * which the daemon polls) and the write path (the MCP local_* tools, which agents
 * use to mutate the board). Both sides MUST resolve to the same absolute path or
 * agent writes never reach the polled directory and the run loop re-dispatches
 * forever.
 *
 * The resolution mirrors workspace.root's path handling:
 *   1. defaults to ".symphony/local" when unset,
 *   2. expands a leading "~" (the operator's HOME) and embedded environment
 *      variables ("$VAR" or "${VAR}") - unknown variables expand to empty,
 *      matching shell substitution; the leading "~" is only honored when it
 *      stands alone or is followed by a path separator,
 *   3. resolves relative paths against cwd (default process.cwd()).
 */
export function resolveBoardDir(
  configuredPath: string | undefined,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const expanded = expandPath(configuredPath ?? DEFAULT_BOARD_DIR, env);
  return path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded);
}

function expandPath(value: string, env: NodeJS.ProcessEnv): string {
  const substituted = value.replace(
    /\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, name: string) => {
      const key = name.startsWith("{") ? name.slice(1, -1) : name;
      return env[key] ?? "";
    },
  );
  const home = env.HOME ?? env.USERPROFILE;
  if (home && substituted === "~") return home;
  if (home && substituted.startsWith("~/")) return path.join(home, substituted.slice(2));
  return substituted;
}
