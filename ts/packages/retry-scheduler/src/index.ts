import type { RuntimeRetryEntry } from "@symphony/runtime-events";
import { systemClock, type ClockPort, type TimerHandle } from "@symphony/ports";

export const RETRY_SCHEDULER_SYNC_DELAY_MS = 5;

export class RetryScheduler {
  private readonly timers = new Map<string, TimerHandle>();

  constructor(private readonly clock: ClockPort = systemClock) {}

  sync(retry: RuntimeRetryEntry | undefined, onDue: (retry: RuntimeRetryEntry) => void): void {
    if (!retry) return;
    this.clear(retry.issueId);
    // setTimeout uses a different clock source than the system clock
    //   So it is possible that the timeOut fires <=1ms early BEFORE it is scheduled.
    //   When that happens, sortForDispatch will ignore the issue because its time isn't due yet.
    // We fix this by adding a small delay to the timeout to ensure it fires after the issue is eligible.
    const delayMs =
      Math.max(0, retry.monotonicDeadlineMs - this.clock.monotonicMs()) + RETRY_SCHEDULER_SYNC_DELAY_MS;
    const timer = this.clock.setTimeout(() => {
      this.timers.delete(retry.issueId);
      onDue(retry);
    }, delayMs);
    timer.unref?.();
    this.timers.set(retry.issueId, timer);
  }

  clear(issueId: string): void {
    const timer = this.timers.get(issueId);
    if (!timer) return;
    this.clock.clearTimeout(timer);
    this.timers.delete(issueId);
  }

  stop(): void {
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
  }
}
