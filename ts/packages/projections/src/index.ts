import type {
  RuntimeAppStatus,
  RuntimeBlockedEntry,
  RuntimeEvent,
  RuntimePollStatus,
  RuntimeRetryEntry,
  RuntimeRunHistoryEntry,
  RuntimeRunningEntry,
  RuntimeSnapshot,
} from "@symphony/runtime-events";
import type { UsageTotals } from "@symphony/domain";

export interface RuntimeProjectionInput {
  appStatus: RuntimeAppStatus;
  workflowPath: string;
  poll: {
    status: RuntimePollStatus;
    candidates: number;
    eligible: number;
    lastPollAt: string | null;
    nextPollAt: string | null;
    lastError: string | null;
  };
  running: RuntimeRunningEntry[];
  retrying: RuntimeRetryEntry[];
  blocked: RuntimeBlockedEntry[];
  usageTotals: UsageTotals;
  rateLimits: unknown;
  logFile: string | null;
}

export class ProjectionActor {
  private recentEvents: RuntimeEvent[] = [];
  private runHistory: RuntimeRunHistoryEntry[] = [];

  recordEvent(event: RuntimeEvent): void {
    this.recentEvents = [event, ...this.recentEvents].slice(0, 20);
  }

  recordRunHistory(entry: RuntimeRunHistoryEntry): void {
    this.runHistory = [entry, ...this.runHistory].slice(0, 50);
  }

  snapshot(input: RuntimeProjectionInput): RuntimeSnapshot {
    return {
      appStatus: input.appStatus,
      workflowPath: input.workflowPath,
      poll: { ...input.poll },
      running: input.running.map((entry) => ({ ...entry, usageTotals: { ...entry.usageTotals } })),
      retrying: input.retrying.map((entry) => ({ ...entry })),
      blocked: input.blocked.map((entry) => ({ ...entry })),
      runHistory: this.runHistory.map((entry) => ({
        ...entry,
        usageTotals: entry.usageTotals ? { ...entry.usageTotals } : undefined,
      })),
      usageTotals: { ...input.usageTotals },
      rateLimits: input.rateLimits,
      logFile: input.logFile,
      recentEvents: this.recentEvents.map((event) => ({ ...event })),
    };
  }
}
