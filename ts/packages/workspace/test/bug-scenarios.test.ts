import { describe, test } from "vitest";
import { safeIdentifier, workspacePath } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

describe("Bug 6: Empty identifier produces root-equal workspace path (S-209)", () => {
  test("safeIdentifier of empty string returns empty string (precondition)", () => {
    // This documents the behavior of safeIdentifier — it returns "" for "".
    // The bug is that workspacePath does not guard against this.
    assert.equal(safeIdentifier(""), "");
  });

  test("workspacePath with empty identifier should NOT equal root", () => {
    // path.join("/tmp/w", "") === "/tmp/w", so the workspace path equals root.
    // The invariant: workspace path must be a STRICT descendant of root.
    const root = "/tmp/w";
    const result = workspacePath(root, "", 0, 1);
    assert.notEqual(result, root);
  });

  test("workspacePath with empty identifier should be strictly inside root", () => {
    // A strict descendant must start with root + "/" (i.e., be a subdirectory).
    const root = "/tmp/workspace";
    const result = workspacePath(root, "", 0, 1);
    assert.ok(result.startsWith(root + "/"));
  });

  test("string sanitized to non-empty does not trigger the bug (contrast)", () => {
    // safeIdentifier("///") replaces non-alnum chars, producing "___" (non-empty).
    // So this case does NOT collide with root — it works correctly.
    const root = "/tmp/w";
    const result = workspacePath(root, "///", 0, 1);
    assert.notEqual(result, root);
    assert.ok(result.startsWith(root + "/"));
  });
});
