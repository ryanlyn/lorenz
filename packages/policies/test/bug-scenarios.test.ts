import { describe, test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { retryBackoffMs } from "@lorenz/policies";

describe("Bug 2: No minimum delay floor — cap=0 produces zero delay", () => {
  test("retryBackoffMs(1, 0, 'failure') should be 0 (cap=0 forces zero)", () => {
    const result = retryBackoffMs(1, 0, "failure");
    assert.ok(result >= 0);
    assert.equal(result, 0);
  });

  test("retryBackoffMs(5, 0, 'failure') should be >= 0 (cap is hard ceiling)", () => {
    const result = retryBackoffMs(5, 0, "failure");
    assert.ok(result >= 0);
    assert.equal(result, 0);
  });

  test("retryBackoffMs(1, 500, 'failure') should be capped at 500", () => {
    const result = retryBackoffMs(1, 500, "failure");
    assert.ok(result <= 500);
    assert.ok(result >= 0);
  });
});

describe("Bug 3: Negative cap produces negative delay", () => {
  test("retryBackoffMs(1, -1, 'failure') returns negative cap directly", () => {
    const result = retryBackoffMs(1, -1, "failure");
    assert.equal(result, -1);
  });

  test("retryBackoffMs(1, -100, 'failure') returns negative cap directly", () => {
    const result = retryBackoffMs(1, -100, "failure");
    assert.equal(result, -100);
  });

  test("retryBackoffMs(3, -999999, 'failure') returns negative cap directly", () => {
    const result = retryBackoffMs(3, -999999, "failure");
    assert.equal(result, -999999);
  });
});

describe("Bug 5: Continuation always returns fixed 1_000ms", () => {
  test("retryBackoffMs(1, 500, 'continuation') should be 1_000", () => {
    const result = retryBackoffMs(1, 500, "continuation");
    assert.equal(result, 1_000);
  });

  test("retryBackoffMs(1, 100, 'continuation') should be 1_000", () => {
    const result = retryBackoffMs(1, 100, "continuation");
    assert.equal(result, 1_000);
  });

  test("retryBackoffMs(10, 1, 'continuation') should be 1_000", () => {
    const result = retryBackoffMs(10, 1, "continuation");
    assert.equal(result, 1_000);
  });
});
