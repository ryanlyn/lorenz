export type RetryKind = "failure" | "continuation";

const MIN_RETRY_DELAY_MS = 1_000;

export function retryBackoffMs(
  attempt: number,
  maxRetryBackoffMs: number,
  retryKind: RetryKind,
): number {
  if (retryKind === "continuation")
    return Math.max(0, Math.min(MIN_RETRY_DELAY_MS, maxRetryBackoffMs));
  const uncapped = Math.max(MIN_RETRY_DELAY_MS, 10_000 * 2 ** Math.max(0, attempt - 1));
  return Math.max(0, Math.min(maxRetryBackoffMs, uncapped));
}
