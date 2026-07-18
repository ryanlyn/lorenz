import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface StopChildOptions {
  processGroup?: boolean | undefined;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function stopChild(
  child: ChildProcessWithoutNullStreams,
  options: StopChildOptions = {},
): Promise<void> {
  if (
    options.processGroup === true &&
    process.platform === "win32" &&
    child.pid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    await stopWindowsProcessTree(child.pid);
    return;
  }

  const processGroupId =
    options.processGroup === true && process.platform !== "win32" ? child.pid : undefined;
  const sendSignal = (signal: NodeJS.Signals): void => {
    if (processGroupId !== undefined) {
      try {
        process.kill(-processGroupId, signal);
        return;
      } catch {
        // Fall back to the direct child when its process group has already exited.
      }
    }
    child.kill(signal);
  };
  const processGroupExists = (): boolean => {
    if (processGroupId === undefined) return false;
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch {
      return false;
    }
  };

  if (child.exitCode !== null || child.signalCode !== null) {
    if (!processGroupExists()) return;
    sendSignal("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    sendSignal("SIGKILL");
    return;
  }

  await new Promise<void>((resolve) => {
    let closed = false;
    const timer = setTimeout(() => {
      if (!closed || processGroupExists()) sendSignal("SIGKILL");
      if (processGroupId !== undefined) resolve();
    }, 1_000);
    child.once("close", () => {
      closed = true;
      if (processGroupExists()) return;
      clearTimeout(timer);
      resolve();
    });
    sendSignal("SIGTERM");
  });
}

async function stopWindowsProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        reject(
          new Error(`taskkill failed for process tree ${pid}: ${stderr.trim() || error.message}`, {
            cause: error,
          }),
        );
      },
    );
  });
}
