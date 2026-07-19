import fs from "node:fs/promises";
import path from "node:path";

import { test } from "vitest";
import { parse as parseYaml } from "yaml";
import { assert } from "@lorenz/test-utils";

const repoRoot = path.resolve(import.meta.dirname, "..");

type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

test("the clean release build compiles workspace packages before the dashboard", async () => {
  const packageText = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
  const packageJson = JSON.parse(packageText) as { scripts?: Record<string, string> };
  const buildScript = packageJson.scripts?.build ?? "";

  const typeScriptBuildIndex = buildScript.indexOf("tsc --build");
  const dashboardBuildIndex = buildScript.indexOf("pnpm dashboard:build");
  assert.ok(typeScriptBuildIndex >= 0);
  assert.ok(dashboardBuildIndex > typeScriptBuildIndex);

  const workflowText = await fs.readFile(
    path.join(repoRoot, ".github/workflows/make-all.yml"),
    "utf8",
  );
  const workflow = parseYaml(workflowText) as Workflow;
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);

  const cleanBuildIndex = steps.findIndex((step) => step.name === "Run clean release build");
  const checkIndex = steps.findIndex((step) => step.name === "Run mise check");
  assert.ok(cleanBuildIndex >= 0);
  assert.equal(steps[cleanBuildIndex]?.run, "pnpm build");
  assert.ok(checkIndex > cleanBuildIndex);
});

test("scheduled releases push their commit and tag only after packaging", async () => {
  const workflowText = await fs.readFile(
    path.join(repoRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  const workflow = parseYaml(workflowText) as Workflow;
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);

  const bumpIndex = steps.findIndex((step) => step.name === "Bump scheduled release version");
  const packIndex = steps.findIndex((step) => step.name === "Pack npx tarball");
  const commitIndex = steps.findIndex((step) => step.name === "Commit scheduled release");

  assert.ok(bumpIndex >= 0);
  assert.notMatch(steps[bumpIndex]?.run ?? "", /git push/);
  assert.ok(packIndex > bumpIndex);
  assert.ok(commitIndex > packIndex);
  assert.match(steps[commitIndex]?.run ?? "", /git push origin "HEAD:\$\{GITHUB_REF_NAME\}"/);
  assert.match(steps[commitIndex]?.run ?? "", /git push origin "\$tag"/);
});

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
