import fs from "node:fs/promises";
import path from "node:path";

import { test } from "vitest";

import { assert } from "./assert.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const workflowFiles = ["WORKFLOW.md", "WORKFLOW_FULL_ACCESS.md"];

test("packaged workflow files remain aligned with canonical workflow fixtures", async () => {
  for (const filename of workflowFiles) {
    const canonical = await fs.readFile(path.join(repoRoot, "elixir", filename), "utf8");
    const ts = await fs.readFile(path.join(repoRoot, "ts", filename), "utf8");
    assert.equal(ts, canonical, filename);
  }
});

test("TS package docs describe the durable workspace contracts", async () => {
  const readme = await fs.readFile(path.join(repoRoot, "ts", "README.md"), "utf8");

  for (const required of [
    "## Requirements",
    "## Run",
    "## Workspace Layout",
    "## Configuration",
    "### Full Reference",
    "## Linear",
    "## Workflow Prompt",
    "## Skills",
    "## Observability",
    "## Testing",
    "## Live Tests",
    "## Packaging",
    "## Compatibility Contracts",
    "## License",
    "--logs-root",
    "SYMPHONY_WORKSPACE_ROOT",
    "SYMPHONY_LIVE_SSH_WORKER_HOSTS",
  ]) {
    assert.match(readme, new RegExp(escapeRegExp(required)));
  }

  for (const outdated of [
    /Eli(?:xir)/,
    new RegExp(`${escapeRegExp("TypeScript")}\\s+p${escapeRegExp("ort")}`),
    /byte[- ]identical/,
    new RegExp(`copied\\s+${escapeRegExp("from")}`),
    new RegExp(`${escapeRegExp("LIVE_E2E")}[_-]${escapeRegExp("MATRIX")}`),
    new RegExp(`${escapeRegExp("pnpm proof:")}p${escapeRegExp("arity")}`),
  ]) {
    assert.notMatch(readme, outdated);
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
