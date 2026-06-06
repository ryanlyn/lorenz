import fs from "node:fs/promises";
import path from "node:path";

import { test } from "vitest";

import { assert } from "./assert.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const linearWorkflowFiles = ["WORKFLOW.md", "WORKFLOW_FULL_ACCESS.md"];
const workflowFiles = [...linearWorkflowFiles, "WORKFLOW.local.md"];

test("packaged workflow files use TypeScript workspace bootstrap hooks", async () => {
  for (const filename of workflowFiles) {
    const workflow = await fs.readFile(path.join(repoRoot, "ts", filename), "utf8");
    assert.match(
      workflow,
      /mise trust\s+cd ts && mise trust && mise exec -- pnpm install --frozen-lockfile/,
    );
    assert.notMatch(workflow, /cd elixir/);
    assert.notMatch(workflow, /mix deps\.get/);
    assert.notMatch(workflow, /workspace\.before_remove/);
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

test("workspace build script includes the dashboard build", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(repoRoot, "ts", "package.json"), "utf8"),
  ) as {
    scripts?: Record<string, string>;
  };

  assert.match(packageJson.scripts?.build, /\bpnpm dashboard:build\b/);
});

test("workspace scripts avoid duplicate parity aliases", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(repoRoot, "ts", "package.json"), "utf8"),
  ) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.["test:parity"], undefined);
  assert.equal(packageJson.scripts?.["test:parity:live"], undefined);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
