import { RetryScheduler } from "@lorenz/retry-scheduler";
import {
  errorMessage,
  systemClock,
  type ClockPort,
  type Issue,
  type RetryEntry,
} from "@lorenz/domain";
import type { RuntimeEventType } from "@lorenz/runtime-events";

import { runtimeRetryEntry } from "./snapshotEntries.js";

export interface RuntimeRetryTimersOptions {
  clock?: ClockPort | undefined;
  getRetryForIssue(issueId: string): RetryEntry | undefined;
  getRetriesForIssues(issueIds: readonly string[]): Map<string, RetryEntry>;
  addEvent(type: RuntimeEventType, message: string): void;
  markRuntimeError(message: string): void;
  pollInProgress(): boolean;
  queuePoll(force: boolean): void;
  pollOnce(): Promise<void>;
}

export class RuntimeRetryTimers {
  private readonly scheduler: RetryScheduler;

  constructor(private readonly options: RuntimeRetryTimersOptions) {
    this.scheduler = new RetryScheduler(options.clock ?? systemClock);
  }

  sync(issueId: string): void {
    this.syncEntry(issueId, this.options.getRetryForIssue(issueId));
  }

  private syncEntry(issueId: string, retry: RetryEntry | undefined): void {
    if (!retry) {
      this.clear(issueId);
      return;
    }
    this.scheduler.sync(runtimeRetryEntry(retry), (scheduled) => {
      try {
        const current = this.options.getRetryForIssue(scheduled.issueId);
        if (
          !current ||
          current.attempt !== scheduled.attempt ||
          current.dueAtIso !== scheduled.dueAtIso
        ) {
          return;
        }
        this.options.addEvent(
          "retry_timer_due",
          `${scheduled.issueIdentifier} attempt=${scheduled.attempt}`,
        );
        if (this.options.pollInProgress()) {
          this.options.queuePoll(true);
          return;
        }
        this.options.pollOnce().catch((error) => {
          this.recordTimerError(error);
        });
      } catch (error) {
        this.recordTimerError(error);
      }
    });
  }

  clear(issueId: string): void {
    this.scheduler.clear(issueId);
  }

  syncForIssues(issues: readonly Issue[]): void {
    if (issues.length === 0) return;
    const issueIds = issues.map((issue) => issue.id);
    const retries = this.options.getRetriesForIssues(issueIds);
    for (const issue of issues) this.syncEntry(issue.id, retries.get(issue.id));
  }

  syncSafely(issueId: string): string | null {
    try {
      this.sync(issueId);
      return null;
    } catch (error) {
      const message = `retry_timer_sync_failed ${errorMessage(error)}`;
      this.options.markRuntimeError(message);
      return message;
    }
  }

  stop(): void {
    this.scheduler.stop();
  }

  private recordTimerError(error: unknown): void {
    const message = errorMessage(error);
    this.options.markRuntimeError(message);
    this.options.addEvent("retry_timer_error", message);
  }
}
