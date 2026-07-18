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
  if (pid === undefined) return;
  let taskkillError: Error | undefined;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      await runWindowsCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
      return;
    } catch (error) {
      taskkillError = error instanceof Error ? error : new Error(String(error));
    }
  }

  try {
    await runWindowsCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      windowsDescendantCleanupScript,
      String(pid),
      String(child.exitCode === null && child.signalCode === null),
    ]);
  } catch (error) {
    const cleanupError = error instanceof Error ? error : new Error(String(error));
    throw new AggregateError(
      taskkillError ? [taskkillError, cleanupError] : [cleanupError],
      `failed to terminate Windows process tree ${pid}`,
      { cause: error },
    );
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

const windowsDescendantCleanupScript = String.raw`
$ErrorActionPreference = "Stop"
$rootProcessId = [uint32]$args[0]
$stopRoot = $args[1] -eq "true"
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$known = [System.Collections.Generic.HashSet[uint32]]::new()
$descendants = [System.Collections.Generic.List[uint32]]::new()
[void]$known.Add($rootProcessId)
do {
  $found = $false
  foreach ($item in $processes) {
    $processId = [uint32]$item.ProcessId
    $parentProcessId = [uint32]$item.ParentProcessId
    if ($processId -ne $rootProcessId -and $known.Contains($parentProcessId) -and $known.Add($processId)) {
      [void]$descendants.Add($processId)
      $found = $true
    }
  }
} while ($found)
for ($index = $descendants.Count - 1; $index -ge 0; $index--) {
  Stop-Process -Id $descendants[$index] -Force -ErrorAction SilentlyContinue
}
if ($stopRoot) {
  Stop-Process -Id $rootProcessId -Force -ErrorAction SilentlyContinue
}
`;
