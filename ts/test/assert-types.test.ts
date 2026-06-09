import { test } from "vitest";

import { assert } from "./assert.js";

test("assert.equal accepts an optional assertion message", () => {
  assert.equal("matching", "matching");
  assert.equal("matching", "matching", "fixture-name");
});
