import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { test } from "vitest";
import { assert, tempDir, writeExecutable } from "@lorenz/test-utils";

const repoRoot = path.resolve(import.meta.dirname, "..");
const linearWorkflowFiles = ["WORKFLOW.md", "WORKFLOW_FULL_ACCESS.md"];
const workflowFiles = [...linearWorkflowFiles, "WORKFLOW.local.md"];

test("packaged workflow files use TypeScript workspace bootstrap hooks", async () => {
  for (const filename of workflowFiles) {
    const workflow = await fs.readFile(path.join(repoRoot, filename), "utf8");
    assert.match(workflow, /mise trust\s+mise exec -- pnpm install --frozen-lockfile/);
    assert.notMatch(workflow, /cd elixir/);
    assert.notMatch(workflow, /mix deps\.get/);
    assert.notMatch(workflow, /workspace\.before_remove/);
  }
});

test("workspace bootstrap hooks fail when clone fails without mise", async () => {
  for (const filename of workflowFiles) {
    const workflow = await fs.readFile(path.join(repoRoot, filename), "utf8");
    const hookBody = extractAfterCreateHook(workflow);
    const temp = await tempDir("lorenz-workflow-bootstrap");

    try {
      const fakeBin = path.join(temp, "bin");
      const workspace = path.join(temp, "workspace");
      await fs.mkdir(workspace);
      await writeExecutable(path.join(fakeBin, "git"), "#!/bin/sh\nexit 42\n");

      const result = await runLoginShell(
        [`PATH=${shellQuote(fakeBin)}`, `cd ${shellQuote(workspace)}`, hookBody].join("\n"),
      );

      assert.equal(
        result.exitCode,
        42,
        `${filename} should preserve clone failures when mise is unavailable`,
      );
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
});

test("TS package docs describe the durable workspace contracts", async () => {
  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");

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
    "LORENZ_WORKSPACE_ROOT",
    "LORENZ_LIVE_SSH_WORKER_HOSTS",
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
    await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
  ) as {
    scripts?: Record<string, string>;
  };

  assert.match(packageJson.scripts?.build, /\bpnpm dashboard:build\b/);
});

test("workspace scripts avoid duplicate parity aliases", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
  ) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.["test:parity"], undefined);
  assert.equal(packageJson.scripts?.["test:parity:live"], undefined);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractAfterCreateHook(workflow: string): string {
  const marker = "  after_create: |\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1);

  const hookBlock = workflow.slice(start + marker.length);
  const lines: string[] = [];
  for (const line of hookBlock.split("\n")) {
    if (line.startsWith("    ")) {
      lines.push(line.slice(4));
      continue;
    }

    if (line.length === 0) {
      lines.push(line);
      continue;
    }

    break;
  }

  return lines.join("\n").trimEnd();
}

function runLoginShell(script: string): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    execFile("/bin/bash", ["-lc", script], { timeout: 5000 }, (error: ExecFileException | null) => {
      if (error?.killed || error?.signal) {
        reject(error);
        return;
      }

      resolve({ exitCode: typeof error?.code === "number" ? error.code : 0 });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
