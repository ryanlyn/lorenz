import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, test } from "vitest";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: workspaceRoot });

describe("eslint config", () => {
  test.each(["serve.ts", "future-source.ts"])("lints TraceViz source file %s", async (fileName) => {
    await expect(
      eslint.isPathIgnored(path.join(workspaceRoot, "apps/traceviz", fileName)),
    ).resolves.toBe(false);
  });

  test("keeps TraceViz build output ignored", async () => {
    await expect(
      eslint.isPathIgnored(path.join(workspaceRoot, "apps/traceviz/dist/server.js")),
    ).resolves.toBe(true);
  });
});
