import { test } from "vitest";
import fc from "fast-check";
import { retryBackoffMs } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

// Invariant 1: Delay is always a non-negative finite number for any inputs.
// This guards against NaN, Infinity, or negative delays that could cause
// infinite loops or invalid timer arguments in the orchestrator.
test("retryBackoffMs - delay is always non-negative and finite for the full input domain", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -2_147_483_648, max: 2_147_483_647 }),
      fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      fc.constantFrom("failure" as const, "continuation" as const),
      (attempt, maxBackoff, kind) => {
        const result = retryBackoffMs(attempt, maxBackoff, kind);
        assert.ok(result >= 0);
        assert.ok(Number.isFinite(result));
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 2: Failure delays are monotonically non-decreasing with attempt number.
// This ensures that higher attempt numbers never produce shorter waits, which would
// defeat the purpose of exponential backoff as a congestion-avoidance mechanism.
test("retryBackoffMs - failure delays are monotonically non-decreasing with attempt number", () => {
  fc.assert(
    fc.property(
      fc.nat({ max: 100 }),
      fc.nat({ max: 100 }),
      fc.integer({ min: 1, max: 100_000_000 }),
      (a, b, maxBackoff) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const delayLo = retryBackoffMs(lo, maxBackoff, "failure");
        const delayHi = retryBackoffMs(hi, maxBackoff, "failure");
        assert.ok(delayHi >= delayLo);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 3: Failure delay never exceeds the configured maximum cap.
// This guarantees that operators can bound worst-case wait times via configuration,
// ensuring SLA compliance regardless of retry count.
test("retryBackoffMs - failure delay never exceeds the configured maximum cap", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -100, max: 10_000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "failure");
        assert.ok(result <= maxBackoff);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 4: The cap is reachable -- sufficiently high attempt numbers saturate at maxBackoff.
// This confirms the cap is tight rather than a loose upper bound that is never actually hit.
test("retryBackoffMs - cap is tight: sufficiently high attempts saturate at maxBackoff", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100_000_000 }),
      (maxBackoff) => {
        // After enough retries, the delay must equal the cap exactly
        const result = retryBackoffMs(100, maxBackoff, "failure");
        assert.equal(result, maxBackoff);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 5: When max allows, failure delays have a positive floor preventing zero-delay storms.
// A zero delay in failure retries would cause a tight retry loop that overwhelms the upstream.
test("retryBackoffMs - failure delay has a positive floor when maxBackoff permits", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -100, max: 200 }),
      fc.integer({ min: 10_000, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "failure");
        assert.ok(result >= 10_000);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 6: Continuation retry uses a constant short delay independent of attempt and maxBackoff.
// Continuations are not errors -- they are normal protocol flow (e.g., max_tokens reached),
// so they should retry quickly without exponential growth.
test("retryBackoffMs - continuation retry uses a fixed delay regardless of inputs", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "continuation");
        assert.equal(result, 1_000);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 7: Failure delays strictly increase before hitting the cap (exponential growth).
// This ensures the backoff actually ramps up rather than staying flat, providing
// meaningful separation between early and late retries.
test("retryBackoffMs - failure delays strictly increase before hitting the cap", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 2, max: 15 }),
      (attempt) => {
        // Use a cap large enough to never be reached for these attempt values
        const maxBackoff = Number.MAX_SAFE_INTEGER;
        const current = retryBackoffMs(attempt, maxBackoff, "failure");
        const next = retryBackoffMs(attempt + 1, maxBackoff, "failure");
        assert.ok(next > current);
      },
    ),
    { numRuns: 200 },
  );
});

// Pinned domain examples: verify specific retry attempts yield expected delays.
// These encode domain knowledge about the retry schedule rather than reimplementing the formula.
test("retryBackoffMs - known retry schedule values", () => {
  // First retry (attempt 0 or 1): base delay of 10s
  assert.equal(retryBackoffMs(0, 120_000, "failure"), 10_000);
  assert.equal(retryBackoffMs(1, 120_000, "failure"), 10_000);
  // Second retry: 20s
  assert.equal(retryBackoffMs(2, 120_000, "failure"), 20_000);
  // Third retry: 40s
  assert.equal(retryBackoffMs(3, 120_000, "failure"), 40_000);
  // Fourth retry: 80s
  assert.equal(retryBackoffMs(4, 120_000, "failure"), 80_000);
  // Fifth retry: would be 160s but capped at 120s
  assert.equal(retryBackoffMs(5, 120_000, "failure"), 120_000);
  // Zero cap means zero delay
  assert.equal(retryBackoffMs(5, 0, "failure"), 0);
});
