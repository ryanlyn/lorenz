import path from "node:path";

import type { Issue, RuntimeTrackerClient, Settings } from "@symphony/domain";

import { BoardStore } from "./boardStore.js";

const DEFAULT_DIR = ".symphony/board";

export class LocalTrackerClient implements RuntimeTrackerClient {
  private readonly store: BoardStore;

  constructor(
    private readonly settings: Settings,
    cwd: string = process.cwd(),
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const configured = expandPath(settings.tracker.path ?? DEFAULT_DIR, env);
    const dir = path.isAbsolute(configured) ? configured : path.join(cwd, configured);
    this.store = new BoardStore(dir);
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.store.byStatus(this.settings.tracker.activeStates);
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    return this.store.getByIds(ids);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    return this.store.byStatus(states);
  }
}

/**
 * Mirror workspace.root's path handling so a configured tracker.path can use a leading "~"
 * (the operator's HOME) and embedded environment variables ("$VAR" or "${VAR}"). Unknown
 * variables expand to empty, matching shell substitution; the leading "~" is only honored
 * when it stands alone or is followed by a path separator.
 */
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
