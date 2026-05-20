import type { RuntimeRetryEntry } from "@symphony/runtime-events";

export class RetryScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  sync(retry: RuntimeRetryEntry | undefined, onDue: (retry: RuntimeRetryEntry) => void): void {
    if (!retry) return;
    this.clear(retry.issueId);
    const dueTime = new Date(retry.dueAt).getTime();
    const delayMs = Math.max(0, dueTime - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(retry.issueId);
      onDue(retry);
    }, delayMs);
    timer.unref?.();
    this.timers.set(retry.issueId, timer);
  }

  clear(issueId: string): void {
    const timer = this.timers.get(issueId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(issueId);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
