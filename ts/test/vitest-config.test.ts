import { test } from "vitest";

import config from "../vitest.config.ts";

import { assert } from "./assert.js";

test("Vitest discovers app TS and TSX tests", () => {
  const include = config.test?.include ?? [];

  for (const requiredGlob of [
    "packages/*/test/**/*.test.ts",
    "packages/*/test/**/*.test.tsx",
    "apps/*/test/**/*.test.ts",
    "apps/*/test/**/*.test.tsx",
  ]) {
    assert.equal(include.includes(requiredGlob), true, requiredGlob);
  }
});
