import fs from "node:fs/promises";
import path from "node:path";

import { test } from "vitest";

import { assert } from "./assert.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const workflowFiles = ["WORKFLOW.md", "WORKFLOW_FULL_ACCESS.md"];

test("packaged workflow files remain byte-identical to Elixir workflows", async () => {
  for (const filename of workflowFiles) {
    const elixir = await fs.readFile(path.join(repoRoot, "elixir", filename), "utf8");
    const ts = await fs.readFile(path.join(repoRoot, "ts", filename), "utf8");
    assert.equal(ts, elixir, filename);
  }
});

test("TS package docs cover the scoped Elixir parity surfaces", async () => {
  const readme = await fs.readFile(path.join(repoRoot, "ts", "README.md"), "utf8");

  for (const required of [
    "## Run",
    "## Configuration",
    "## Workflow Prompt",
    "## Observability",
    "## Live E2E",
    "## Packaging",
    "## Parity Scope",
    "--logs-root",
    "pnpm proof:parity",
  ]) {
    assert.match(readme, new RegExp(escapeRegExp(required)));
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
