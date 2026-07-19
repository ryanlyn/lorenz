import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { actionForStopReason } from "@lorenz/policies";

// --- actionForStopReason ---

test("actionForStopReason — all known stop reasons produce defined actions", () => {
  const known: Array<[string, string]> = [
    ["end_turn", "continue"],
    ["max_tokens", "continue"],
    ["max_turn_requests", "continue"],
    ["cancelled", "cancel"],
    ["refusal", "retry"],
  ];
  for (const [reason, expected] of known) {
    assert.equal(actionForStopReason(reason as never), expected);
  }
});

test('actionForStopReason — unknown/unexpected string returns "retry"', () => {
  assert.equal(actionForStopReason("something_unknown" as never), "retry");
  assert.equal(actionForStopReason("" as never), "retry");
});

// "refusal" is not handled by an explicit branch in the implementation;
// it falls through to the default "retry" return. This test confirms that
// "refusal" and an arbitrary unknown reason both follow the same default path.
test('actionForStopReason — "refusal" intentionally falls through to default "retry" path', () => {
  const refusalResult = actionForStopReason("refusal" as never);
  const unknownResult = actionForStopReason("totally_made_up" as never);
  assert.equal(refusalResult, "retry");
  assert.equal(unknownResult, "retry");
  // Both produce "retry" via the same default fallthrough
  assert.equal(refusalResult, unknownResult);
});
