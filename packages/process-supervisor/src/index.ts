import type { ChildProcess } from "node:child_process";

const DEFAULT_FORCE_KILL_DELAY_MS = 5_000;

export interface ChildTerminationAdapter {
  terminate(signal: NodeJS.Signals): void;
}

export interface ChildSupervisionOptions<T> {
  completion: PromiseLike<T>;
  termination: ChildTerminationAdapter;
  timeout?: {
    afterMs: number;
    error: () => Error;
  };
  cancellation?: {
    signal: AbortSignal;
    error: () => Error;
  };
  forceKillAfterMs?: number;
}

interface Destroyable {
  destroy(): unknown;
}

type DirectChild = Pick<ChildProcess, "kill"> & {
  stdin?: Destroyable | null | undefined;
  stdout?: Destroyable | null | undefined;
  stderr?: Destroyable | null | undefined;
};

export function processGroupTerminationAdapter(
  processGroupLeaderPid: number | undefined,
): ChildTerminationAdapter {
  return {
    terminate(signal) {
      if (processGroupLeaderPid === undefined) return;
      try {
        process.kill(-processGroupLeaderPid, signal);
      } catch {
        // Process completion can race with termination.
      }
    },
  };
}

export function directChildTerminationAdapter(child: DirectChild): ChildTerminationAdapter {
  return {
    terminate(signal) {
      try {
        child.kill(signal);
      } catch {
        // Process completion can race with termination.
      }
      if (signal !== "SIGKILL") return;
      destroy(child.stdin);
      destroy(child.stdout);
      destroy(child.stderr);
    },
  };
}

export async function superviseChild<T>(options: ChildSupervisionOptions<T>): Promise<T> {
  const forceKillAfterMs = options.forceKillAfterMs ?? DEFAULT_FORCE_KILL_DELAY_MS;
  if (!Number.isFinite(forceKillAfterMs) || forceKillAfterMs < 0) {
    throw new Error(`invalid_force_kill_delay: ${forceKillAfterMs}`);
  }
  if (
    options.timeout &&
    (!Number.isFinite(options.timeout.afterMs) || options.timeout.afterMs < 0)
  ) {
    throw new Error(`invalid_child_timeout: ${options.timeout.afterMs}`);
  }
  return new Promise<T>((resolve, reject) => {
    let outcomeSettled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    const clearTriggerResources = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (abortHandler) {
        options.cancellation?.signal.removeEventListener("abort", abortHandler);
        abortHandler = undefined;
      }
    };

    const clearAllResources = (): void => {
      clearTriggerResources();
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
    };

    const requestTermination = (error: Error): void => {
      if (outcomeSettled) return;
      outcomeSettled = true;
      clearTriggerResources();
      options.termination.terminate("SIGTERM");
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        options.termination.terminate("SIGKILL");
      }, forceKillAfterMs);
      reject(error);
    };

    void Promise.resolve(options.completion).then(
      (value) => {
        clearAllResources();
        if (outcomeSettled) return;
        outcomeSettled = true;
        resolve(value);
      },
      (error: unknown) => {
        clearAllResources();
        if (outcomeSettled) return;
        outcomeSettled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );

    const timeout = options.timeout;
    if (timeout) {
      timeoutTimer = setTimeout(() => {
        timeoutTimer = undefined;
        requestTermination(timeout.error());
      }, timeout.afterMs);
    }

    const cancellation = options.cancellation;
    if (cancellation) {
      abortHandler = () => requestTermination(cancellation.error());
      cancellation.signal.addEventListener("abort", abortHandler, { once: true });
      if (cancellation.signal.aborted) abortHandler();
    }
  });
}

function destroy(stream: Destroyable | null | undefined): void {
  try {
    stream?.destroy();
  } catch {
    // Stream completion can race with termination.
  }
}
