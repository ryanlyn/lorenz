import type { RuntimeRetryEntry } from "@symphony/runtime-events";
import { systemClock, type ClockPort, type TimerHandle } from "@symphony/ports";

export class RetryScheduler {
  private readonly timers = new Map<string, TimerHandle>();

  constructor(private readonly clock: ClockPort = systemClock) {}

  sync(retry: RuntimeRetryEntry | undefined, onDue: (retry: RuntimeRetryEntry) => void): void {
    if (!retry) return;
    this.clear(retry.issueId);
    const delayMs = Math.max(0, retry.monotonicDeadlineMs - this.clock.monotonicMs());
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
