import { describe, test } from "vitest";
import { retryBackoffMs } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

describe("Bug 2: No minimum delay floor — cap=0 produces zero delay", () => {
  test("retryBackoffMs(1, 0, 'failure') should be > 0", () => {
    const result = retryBackoffMs(1, 0, "failure");
    assert.ok(result > 0);
  });

  test("retryBackoffMs(5, 0, 'failure') should be > 0", () => {
    const result = retryBackoffMs(5, 0, "failure");
    assert.ok(result > 0);
  });

  test("retryBackoffMs(1, 0, 'failure') should enforce a minimum floor", () => {
    const result = retryBackoffMs(1, 0, "failure");
    assert.ok(result >= 1000);
  });
});

describe("Bug 3: Negative cap produces negative delay", () => {
  test("retryBackoffMs(1, -1, 'failure') should be >= 0", () => {
    const result = retryBackoffMs(1, -1, "failure");
    assert.ok(result >= 0);
  });

  test("retryBackoffMs(1, -100, 'failure') should be >= 0", () => {
    const result = retryBackoffMs(1, -100, "failure");
    assert.ok(result >= 0);
  });

  test("retryBackoffMs(3, -999999, 'failure') should be >= 0", () => {
    const result = retryBackoffMs(3, -999999, "failure");
    assert.ok(result >= 0);
  });
});

describe("Bug 5: Continuation bypasses cap", () => {
  test("retryBackoffMs(1, 500, 'continuation') should be <= 500", () => {
    const result = retryBackoffMs(1, 500, "continuation");
    assert.ok(result <= 500);
  });

  test("retryBackoffMs(1, 100, 'continuation') should be <= 100", () => {
    const result = retryBackoffMs(1, 100, "continuation");
    assert.ok(result <= 100);
  });

  test("retryBackoffMs(10, 1, 'continuation') should be <= 1", () => {
    const result = retryBackoffMs(10, 1, "continuation");
    assert.ok(result <= 1);
  });
});
