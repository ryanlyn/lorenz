import { test } from "vitest";
import fc from "fast-check";
import { retryBackoffMs } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

// Invariant 1: When a retry delay is calculated, it SHALL be non-negative.
test("retryBackoffMs - delay is always non-negative for any input combination", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      fc.constantFrom("failure" as const, "continuation" as const),
      (attempt, maxBackoff, kind) => {
        const result = retryBackoffMs(attempt, maxBackoff, kind);
        assert.ok(result >= 0);
      },
    ),
    { numRuns: 200 },
  );
});

test("retryBackoffMs - delay is non-negative even with extreme attempt values", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -2_147_483_648, max: 2_147_483_647 }),
      fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      fc.constantFrom("failure" as const, "continuation" as const),
      (attempt, maxBackoff, kind) => {
        const result = retryBackoffMs(attempt, maxBackoff, kind);
        assert.ok(result >= 0);
        // Also verify it is a finite number (not NaN or Infinity)
        assert.ok(Number.isFinite(result));
      },
    ),
    { numRuns: 200 },
  );
});

test("retryBackoffMs - delay is non-negative with zero maxBackoff", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -100, max: 1000 }),
      (attempt) => {
        const result = retryBackoffMs(attempt, 0, "failure");
        assert.ok(result >= 0);
        // With maxBackoff=0, failure delay should be capped to 0
        assert.equal(result, 0);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 2: When failure retry delay is calculated, it SHALL be monotonically non-decreasing with attempt number.
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

test("retryBackoffMs - failure delays are non-decreasing across consecutive attempts", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 50 }),
      fc.integer({ min: 10_000, max: 10_000_000 }),
      (attempt, maxBackoff) => {
        const current = retryBackoffMs(attempt, maxBackoff, "failure");
        const next = retryBackoffMs(attempt + 1, maxBackoff, "failure");
        assert.ok(next >= current);
      },
    ),
    { numRuns: 200 },
  );
});

test("retryBackoffMs - failure delays are non-decreasing even for negative attempts", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1000, max: -1 }),
      fc.integer({ min: -1000, max: -1 }),
      fc.integer({ min: 10_000, max: 100_000_000 }),
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

test("retryBackoffMs - failure delays strictly increase before hitting the cap", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 20 }),
      (attempt) => {
        // Use a very large cap so we never hit it
        const maxBackoff = Number.MAX_SAFE_INTEGER;
        const current = retryBackoffMs(attempt, maxBackoff, "failure");
        const next = retryBackoffMs(attempt + 1, maxBackoff, "failure");
        // Before the cap, exponential backoff must strictly increase
        assert.ok(next > current);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 3: When a retry delay is calculated, it SHALL never exceed the configured maximum cap.
test("retryBackoffMs - failure delay never exceeds the configured maximum cap", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -100, max: 200 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "failure");
        assert.ok(result <= maxBackoff);
      },
    ),
    { numRuns: 200 },
  );
});

test("retryBackoffMs - cap applies regardless of how large the attempt number is", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 100, max: 10_000 }),
      fc.integer({ min: 1, max: 500_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "failure");
        assert.ok(result <= maxBackoff);
      },
    ),
    { numRuns: 200 },
  );
});

test("retryBackoffMs - cap is tight: for large enough attempts the delay equals maxBackoff", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100_000_000 }),
      (maxBackoff) => {
        // With attempt=100, 10_000 * 2^99 is astronomically large,
        // so Math.min(maxBackoff, ...) must equal maxBackoff
        const result = retryBackoffMs(100, maxBackoff, "failure");
        assert.equal(result, maxBackoff);
      },
    ),
    { numRuns: 200 },
  );
});

test("retryBackoffMs - failure delay with maxBackoff of 1 is always exactly 1 or 0", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -100, max: 1000 }),
      (attempt) => {
        const result = retryBackoffMs(attempt, 1, "failure");
        // Math.min(1, 10_000 * ...) = 1 since 10_000 * 2^x >= 10_000 > 1
        assert.equal(result, 1);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 4: When a retry delay is calculated, the minimum delay floor SHALL prevent zero-delay storms.
test("retryBackoffMs - failure delay has a positive floor preventing zero-delay storms when max allows", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -100, max: 200 }),
      fc.integer({ min: 10_000, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "failure");
        // The base delay is 10_000ms so when max >= 10_000, delay must be at least 10_000
        assert.ok(result >= 10_000);
      },
    ),
    { numRuns: 200 },
  );
});

test("retryBackoffMs - failure delay floor is exactly 10_000 for attempt <= 1 when max >= 10_000", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1000, max: 1 }),
      fc.integer({ min: 10_000, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "failure");
        // For attempt <= 1, Math.max(0, attempt-1) = 0, so delay = 10_000 * 2^0 = 10_000
        assert.equal(result, 10_000);
      },
    ),
    { numRuns: 200 },
  );
});

test("retryBackoffMs - continuation delay is always positive preventing zero-delay storms", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "continuation");
        assert.ok(result > 0);
      },
    ),
    { numRuns: 200 },
  );
});

test("retryBackoffMs - failure delay with maxBackoff=0 results in zero (floor does not apply)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -100, max: 200 }),
      (attempt) => {
        const result = retryBackoffMs(attempt, 0, "failure");
        // When maxBackoff=0, Math.min(0, anything) = 0, so the floor is defeated
        assert.equal(result, 0);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 5: When a continuation retry is scheduled, it SHALL use a fixed short delay regardless of attempt number.
test("retryBackoffMs - continuation retry uses a fixed delay regardless of attempt number", () => {
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

test("retryBackoffMs - continuation delay is constant across different attempt/max combinations", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: -1000, max: 1000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      (attempt1, attempt2, max1, max2) => {
        const result1 = retryBackoffMs(attempt1, max1, "continuation");
        const result2 = retryBackoffMs(attempt2, max2, "continuation");
        assert.equal(result1, result2);
      },
    ),
    { numRuns: 200 },
  );
});

test("retryBackoffMs - continuation delay is constant even with extreme values", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -2_147_483_648, max: 2_147_483_647 }),
      fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "continuation");
        assert.equal(result, 1_000);
      },
    ),
    { numRuns: 200 },
  );
});

// Additional structural property: exponential growth factor is 2x between successive attempts
test("retryBackoffMs - failure delay doubles between consecutive attempts before cap", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 2, max: 15 }),
      (attempt) => {
        // Use a cap large enough to never be reached for these attempt values
        const maxBackoff = Number.MAX_SAFE_INTEGER;
        const current = retryBackoffMs(attempt, maxBackoff, "failure");
        const next = retryBackoffMs(attempt + 1, maxBackoff, "failure");
        // Exponential backoff: next should be exactly 2x current
        assert.equal(next, current * 2);
      },
    ),
    { numRuns: 200 },
  );
});

// Negative test: continuation delay does NOT respect the maxBackoff cap
// (This is an observable property of the current implementation)
test("retryBackoffMs - continuation delay can exceed maxBackoff (does not respect cap)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 999 }),
      fc.integer({ min: -1000, max: 1000 }),
      (maxBackoff, attempt) => {
        const result = retryBackoffMs(attempt, maxBackoff, "continuation");
        // continuation always returns 1000, even when maxBackoff < 1000
        assert.equal(result, 1_000);
        assert.ok(result > maxBackoff);
      },
    ),
    { numRuns: 200 },
  );
});

// Verify the exact formula: for failure kind, delay = min(max, 10_000 * 2^max(0, attempt-1))
test("retryBackoffMs - failure delay matches the exponential formula exactly", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -10, max: 40 }),
      fc.integer({ min: 0, max: 100_000_000 }),
      (attempt, maxBackoff) => {
        const result = retryBackoffMs(attempt, maxBackoff, "failure");
        const expected = Math.min(
          maxBackoff,
          10_000 * 2 ** Math.max(0, attempt - 1),
        );
        assert.equal(result, expected);
      },
    ),
    { numRuns: 200 },
  );
});
