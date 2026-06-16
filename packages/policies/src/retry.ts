export type RetryKind = "failure" | "continuation";

export const MIN_RETRY_DELAY_MS = 1_000;

export function retryBackoffMs(
  attempt: number,
  maxRetryBackoffMs: number,
  retryKind: RetryKind,
): number {
  if (retryKind === "continuation") return MIN_RETRY_DELAY_MS;
  return Math.min(maxRetryBackoffMs, 10_000 * 2 ** Math.max(0, attempt - 1));
}
