import { describe, test } from "vitest";
import fc from "fast-check";

import { assert } from "../../../test/assert.js";

import { MIN_RETRY_DELAY_MS, retryBackoffMs } from "@symphony/policies";

test("INVARIANT: When failure retry delay is calculated, it SHALL be monotonically non-decreasing with attempt number", () => {
  fc.assert(
    fc.property(
      fc.nat({ max: 50 }),
      fc.nat({ max: 50 }),
      fc.integer({ min: 10_000, max: 10_000_000 }),
      (a, b, max) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        assert.ok(retryBackoffMs(hi, max, "failure") >= retryBackoffMs(lo, max, "failure"));
      },
    ),
  );
});

test("INVARIANT: When maxBackoff permits, failure delays SHALL have a positive floor preventing zero-delay storms", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -10, max: 100 }),
      fc.integer({ min: 10_000, max: 10_000_000 }),
      (attempt, max) => {
        assert.ok(retryBackoffMs(attempt, max, "failure") >= 10_000);
      },
    ),
  );
});

test("INVARIANT: When a continuation retry is scheduled, it SHALL always return a fixed MIN_RETRY_DELAY_MS delay", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -10, max: 100 }),
      fc.integer({ min: 0, max: 10_000_000 }),
      (attempt, max) => {
        assert.equal(retryBackoffMs(attempt, max, "continuation"), MIN_RETRY_DELAY_MS);
      },
    ),
  );
});

describe("INVARIANT: failure delay never exceeds maxRetryBackoffMs when max >= 10_000", () => {
  test("retryBackoffMs — failure delay never exceeds maxRetryBackoffMs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10, max: 100 }),
        fc.integer({ min: 10_000, max: 10_000_000 }),
        (attempt, max) => {
          assert.ok(retryBackoffMs(attempt, max, "failure") <= max);
        },
      ),
    );
  });
});
