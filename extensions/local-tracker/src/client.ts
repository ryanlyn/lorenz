import type { Issue, RuntimeTrackerClient, Settings } from "@lorenz/domain";

import { BoardStore } from "./boardStore.js";
import { localBoardDir, localTrackerOptions } from "./options.js";

/** Minimal logging surface so a degraded board file is surfaced (default: console.warn). */
export interface LocalTrackerLogger {
  warn(message: string): void;
}

export class LocalTrackerClient implements RuntimeTrackerClient {
  private readonly store: BoardStore;

  constructor(
    private readonly settings: Settings,
    cwd: string = process.cwd(),
    env: NodeJS.ProcessEnv = process.env,
    logger: LocalTrackerLogger = { warn: (message) => console.warn(message) },
  ) {
    const dir = localBoardDir(settings, { cwd, env });
    const { idPrefix } = localTrackerOptions(settings);
    this.store = new BoardStore(dir, {
      ...(idPrefix !== undefined ? { idPrefix } : {}),
      // A malformed file in the board dir must not abort candidate discovery (and the poll);
      // skip it but log a warning so the operator can see and fix the offending file.
      onSkip: ({ id, error }) =>
        logger.warn(`local tracker: skipping malformed board file ${id} in ${dir}: ${error}`),
    });
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
