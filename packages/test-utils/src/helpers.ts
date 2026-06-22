import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

/**
 * Wait a bounded amount of real time for a system to reach quiescence.
 *
 * Use this ONLY when asserting that something does NOT happen — you cannot poll
 * for the absence of an event, so a bounded wait is unavoidable. For positive
 * waits ("wait until X is true") use `vi.waitFor`/`vi.waitUntil` so the test
 * races the actual condition instead of betting on a fixed delay, or drive
 * timer-based code with `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`.
 *
 * This is the single blessed sleep: the lint bans inline
 * `new Promise(r => setTimeout(r, ms))` so quiescence waits funnel through here.
 */
export async function settle(ms = 50): Promise<void> {
  await sleep(ms);
}

export async function writeExecutable(filePath: string, source: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source);
  await fs.chmod(filePath, 0o755);
}

export const sampleIssue = {
  id: "issue-1",
  identifier: "MT-1",
  title: "Test issue",
  description: "Ship it",
  state: "Todo",
  stateType: "unstarted" as const,
  labels: ["Lorenz:Backend"],
  blockers: [],
};
