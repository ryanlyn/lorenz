export type RetryKind = "failure" | "continuation";

export function retryBackoffMs(
  attempt: number,
  maxRetryBackoffMs: number,
  retryKind: RetryKind,
): number {
  if (retryKind === "continuation") return 1_000;
  return Math.min(maxRetryBackoffMs, 10_000 * 2 ** Math.max(0, attempt - 1));
}
