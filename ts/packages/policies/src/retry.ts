export type RetryKind = "failure" | "continuation";

const MIN_RETRY_DELAY_MS = 1_000;

export function retryBackoffMs(
  attempt: number,
  maxRetryBackoffMs: number,
  retryKind: RetryKind,
): number {
  if (retryKind === "continuation")
    return Math.max(0, Math.min(MIN_RETRY_DELAY_MS, maxRetryBackoffMs));
  // Fix: maxRetryBackoffMs now acts as a hard ceiling on retry delay.
  // Previously, Math.max(MIN_RETRY_DELAY_MS, ...) ignored the configured max when it was
  // below 1000ms. Now the configured maxRetryBackoffMs is always the upper bound on retry
  // delay, enforcing the invariant that callers can cap retry timing from above.
  // The result is always non-negative (clamped to 0 at minimum).
  const uncapped = Math.max(MIN_RETRY_DELAY_MS, 10_000 * 2 ** Math.max(0, attempt - 1));
  return Math.max(0, Math.min(maxRetryBackoffMs, uncapped));
}
