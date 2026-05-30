import { describe, test } from "vitest";
import { safeIdentifier, workspacePath } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

describe("Bug 6: Empty identifier produces root-equal workspace path (S-209)", () => {
  test("workspacePath with empty identifier should NOT equal root", () => {
    const root = "/tmp/w";
    const result = workspacePath(root, "", 0, 1);
    assert.notEqual(result, root);
  });

  test("workspacePath with empty identifier should be strictly inside root", () => {
    const root = "/tmp/workspace";
    const result = workspacePath(root, "", 0, 1);
    assert.ok(result.startsWith(root + "/"));
  });

  test("safeIdentifier of empty string returns empty (precondition)", () => {
    assert.equal(safeIdentifier(""), "");
  });
});
