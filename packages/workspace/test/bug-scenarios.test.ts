import { describe, test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { safeIdentifier, workspacePath } from "@lorenz/workspace";

describe("Bug 6: Empty identifier produces root-equal workspace path", () => {
  test("safeIdentifier of empty string returns empty string (precondition)", () => {
    assert.equal(safeIdentifier(""), "");
  });

  test("workspacePath with empty identifier throws", () => {
    const root = "/tmp/w";
    assert.throws(() => workspacePath(root, "", 0, 1), /empty identifier/);
  });

  test("workspacePath with all-special-char identifier still works", () => {
    // safeIdentifier("///") replaces non-alnum chars, producing "___" (non-empty).
    const root = "/tmp/w";
    const result = workspacePath(root, "///", 0, 1);
    assert.notEqual(result, root);
    assert.ok(result.startsWith(root + "/"));
  });
});
