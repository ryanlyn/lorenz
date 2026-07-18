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
  if (options.processGroup === true && process.platform === "win32" && child.pid !== undefined) {
    await stopWindowsProcessTree(child);
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

async function stopWindowsProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    await runWindowsCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } catch (error) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    throw error;
  }
}

async function runWindowsCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      reject(
        new Error(`${command} failed: ${stderr.trim() || error.message}`, {
          cause: error,
        }),
      );
    });
  });
}
