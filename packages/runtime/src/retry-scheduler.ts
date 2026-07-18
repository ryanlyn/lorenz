import type { RuntimeRetryEntry } from "@lorenz/runtime-events";
import { systemClock, type ClockPort, type TimerHandle } from "@lorenz/domain";

export const RETRY_SCHEDULER_SYNC_DELAY_MS = 5;

interface ScheduledRetry {
  timer: TimerHandle;
  /** Identity of the retry the timer was armed for; an unchanged retry is not re-armed. */
  attempt: number;
  dueAtIso: string;
  monotonicDeadlineMs: number;
}

export class RetryScheduler {
  private readonly timers = new Map<string, ScheduledRetry>();

  constructor(private readonly clock: ClockPort = systemClock) {}

  sync(retry: RuntimeRetryEntry | undefined, onDue: (retry: RuntimeRetryEntry) => void): void {
    if (!retry) return;
    // Re-arming is skipped when a live timer already covers this exact retry
    // (same attempt and deadline). sync() runs for every retrying issue on
    // every poll, and with a push-driven tracker polls can be near-continuous;
    // unconditionally clearing and recreating the timer each time churns a
    // fresh unique-duration timer per poll. Node keeps a per-duration timer
    // list (timerListMap) alive until that duration's ORIGINAL deadline even
    // after clearTimeout, so the churn accumulates thousands of empty timer
    // lists - a steady memory drain in a long-running daemon.
    const existing = this.timers.get(retry.issueId);
    if (
      existing &&
      existing.attempt === retry.attempt &&
      existing.dueAtIso === retry.dueAtIso &&
      existing.monotonicDeadlineMs === retry.monotonicDeadlineMs
    ) {
      return;
    }
    this.clear(retry.issueId);
    // setTimeout uses a different clock source than the system clock
    //   So it is possible that the timeOut fires <=1ms early BEFORE it is scheduled.
    //   When that happens, sortForDispatch will ignore the issue because its time isn't due yet.
    // We fix this by adding a small delay to the timeout to ensure it fires after the issue is eligible.
    // The delay is rounded up to whole milliseconds: monotonic clocks are
    // fractional, and fractional durations each mint their own entry in Node's
    // internal per-duration timer table.
    const delayMs = Math.ceil(
      Math.max(0, retry.monotonicDeadlineMs - this.clock.monotonicMs()) +
        RETRY_SCHEDULER_SYNC_DELAY_MS,
    );
    const timer = this.clock.setTimeout(() => {
      this.timers.delete(retry.issueId);
      onDue(retry);
    }, delayMs);
    timer.unref?.();
    this.timers.set(retry.issueId, {
      timer,
      attempt: retry.attempt,
      dueAtIso: retry.dueAtIso,
      monotonicDeadlineMs: retry.monotonicDeadlineMs,
    });
  }

  clear(issueId: string): void {
    const scheduled = this.timers.get(issueId);
    if (!scheduled) return;
    this.clock.clearTimeout(scheduled.timer);
    this.timers.delete(issueId);
  }

  stop(): void {
    for (const scheduled of this.timers.values()) this.clock.clearTimeout(scheduled.timer);
    this.timers.clear();
  }
}
