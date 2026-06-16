import fs from "node:fs/promises";
import path from "node:path";

import { test } from "vitest";
import { parse as parseYaml } from "yaml";
import { assert } from "@lorenz/test-utils";

const repoRoot = path.resolve(import.meta.dirname, "..");

type WorkflowStep = {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

test("make-all lockfile cache does not restore stale build outputs", async () => {
  const workflowText = await fs.readFile(
    path.join(repoRoot, ".github/workflows/make-all.yml"),
    "utf8",
  );
  const workflow = parseYaml(workflowText) as Workflow;

  const cacheSteps = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => typeof step.uses === "string" && step.uses.includes("actions/cache"));

  const lockfileCachePaths = cacheSteps
    .filter((step) => String(step.with?.key ?? "").includes("hashFiles('pnpm-lock.yaml')"))
    .flatMap((step) => pathEntries(step.with?.path));
  const cacheKeys = cacheSteps.flatMap((step) => [
    String(step.with?.key ?? ""),
    ...pathEntries(step.with?.["restore-keys"]),
  ]);

  assert.deepEqual(
    lockfileCachePaths.filter((entry) => /^(?:apps|packages)\/\*\/dist$/.test(entry)),
    [],
  );
  assert.deepEqual(
    lockfileCachePaths.filter(
      (entry) => entry === "node_modules" || /^(?:apps|packages)\/\*\/node_modules$/.test(entry),
    ),
    ["node_modules", "apps/*/node_modules", "packages/*/node_modules"],
  );
  assert.deepEqual(
    cacheKeys.filter((entry) => entry.includes("ts-deps-build")),
    [],
  );
});

function pathEntries(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
