export interface ClockPort {
  now(): Date;
  monotonicMs(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface TimerHandle {
  unref?: (() => void) | undefined;
}

export const systemClock: ClockPort = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
