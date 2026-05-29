import { match } from "ts-pattern";

// --- PollState discriminated union ---

export type PollState =
  | { kind: "idle"; lastPollAt: Date | null; lastError: string | null }
  | {
      kind: "polling";
      startedAt: Date;
      promise: Promise<void>;
      waiters: Array<{ resolve: () => void }>;
    };

// --- PollEvent discriminated union ---

export type PollEvent =
  | { kind: "poll_requested" }
  | { kind: "poll_completed"; at: Date }
  | { kind: "poll_failed"; error: string; at: Date };

// --- Pure transition function ---

export function pollTransition(state: PollState, event: PollEvent): PollState | null {
  return match([state, event] as const)
    .with([{ kind: "idle" }, { kind: "poll_requested" }], () => {
      // Caller is responsible for setting the promise and waiters externally
      // We produce a placeholder that gets replaced by PollMachine.requestPoll
      return null; // Signal to PollMachine to handle construction
    })
    .with([{ kind: "polling" }, { kind: "poll_requested" }], () => {
      // Already polling - caller adds a waiter; no state shape change
      return null;
    })
    .with([{ kind: "polling" }, { kind: "poll_completed" }], ([, ev]) => ({
      kind: "idle" as const,
      lastPollAt: ev.at,
      lastError: null,
    }))
    .with([{ kind: "polling" }, { kind: "poll_failed" }], ([, ev]) => ({
      kind: "idle" as const,
      lastPollAt: ev.at,
      lastError: ev.error,
    }))
    .otherwise(() => null);
}

// --- PollMachine (stateful wrapper) ---

export class PollMachine {
  private _state: PollState = { kind: "idle", lastPollAt: null, lastError: null };

  get state(): PollState {
    return this._state;
  }

  /**
   * Request a poll. If already polling, returns a promise that resolves when
   * the current poll completes. If idle, starts a new poll using the provided
   * executor.
   */
  async requestPoll(executor: () => Promise<void>): Promise<void> {
    if (this._state.kind === "polling") {
      // Coalesce: add a waiter to the current polling state
      const pollingState = this._state;
      return new Promise<void>((resolve) => {
        pollingState.waiters.push({ resolve });
      });
    }

    // idle -> polling
    let resolveWaiter: () => void;
    const waiterPromise = new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    });

    const promise = executor().then(
      () => {
        this._complete(new Date());
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this._fail(message, new Date());
      },
    );

    this._state = {
      kind: "polling",
      startedAt: new Date(),
      promise,
      waiters: [{ resolve: resolveWaiter! }],
    };

    return waiterPromise;
  }

  private _complete(at: Date): void {
    if (this._state.kind !== "polling") return;
    const waiters = this._state.waiters;
    this._state = { kind: "idle", lastPollAt: at, lastError: null };
    for (const w of waiters) w.resolve();
  }

  private _fail(error: string, at: Date): void {
    if (this._state.kind !== "polling") return;
    const waiters = this._state.waiters;
    this._state = { kind: "idle", lastPollAt: at, lastError: error };
    for (const w of waiters) w.resolve();
  }
}
