import { test, describe } from "vitest";
import fc from "fast-check";
import { retryBackoffMs } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

test("retryBackoffMs — monotonically non-decreasing for failure kind", () => {
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

test("retryBackoffMs — floor at base when max >= 10_000", () => {
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

test("retryBackoffMs — continuation respects cap", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -10, max: 100 }),
      fc.integer({ min: 0, max: 10_000_000 }),
      (attempt, max) => {
        assert.equal(retryBackoffMs(attempt, max, "continuation"), Math.min(1_000, max));
      },
    ),
  );
});

describe("INVARIANT: result is always non-negative when maxRetryBackoffMs >= 0", () => {
  test("retryBackoffMs — result is always non-negative", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10, max: 100 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.constantFrom("failure" as const, "continuation" as const),
        (attempt, max, kind) => {
          assert.ok(retryBackoffMs(attempt, max, kind) >= 0);
        },
      ),
    );
  });
});

describe("INVARIANT: failure delay never exceeds maxRetryBackoffMs", () => {
  test("retryBackoffMs — failure delay never exceeds maxRetryBackoffMs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10, max: 100 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (attempt, max) => {
          assert.ok(retryBackoffMs(attempt, max, "failure") <= max);
        },
      ),
    );
  });
});
