import type { ChildProcessWithoutNullStreams } from "node:child_process";

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

export async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    let closed = false;
    const timer = setTimeout(() => {
      if (!closed) child.kill("SIGKILL");
    }, 1_000);
    child.once("close", () => {
      closed = true;
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
