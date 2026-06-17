import fs from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, test } from "vitest";

import { bumpReleaseVersion } from "../scripts/bump-release-version.ts";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lorenz-version-test-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("bumps first-party package versions and leaves vendored packages unchanged", async () => {
  await seedPackage("package.json", "lorenz", "0.1.0");
  await seedPackage("apps/cli/package.json", "@lorenz/cli", "0.1.0");
  await seedPackage("apps/traceviz/package.json", "@lorenz/traceviz", "0.1.0");
  await seedPackage("packages/acp/package.json", "@lorenz/acp", "0.1.0");
  await seedPackage("extensions/slack-tracker/package.json", "@lorenz/slack-tracker", "0.1.0");
  await seedPackage("vendor/codex-acp/package.json", "@agentclientprotocol/codex-acp", "0.0.45");

  const result = await bumpReleaseVersion({ workspaceRoot: tempRoot });

  assert.equal(result.previousVersion, "0.1.0");
  assert.equal(result.nextVersion, "0.1.1");
  assert.deepEqual(result.packageFiles, [
    "package.json",
    "apps/cli/package.json",
    "apps/traceviz/package.json",
    "packages/acp/package.json",
    "extensions/slack-tracker/package.json",
  ]);
  assert.equal((await readPackage("package.json")).version, "0.1.1");
  assert.equal((await readPackage("apps/cli/package.json")).version, "0.1.1");
  assert.equal((await readPackage("apps/traceviz/package.json")).version, "0.1.1");
  assert.equal((await readPackage("packages/acp/package.json")).version, "0.1.1");
  assert.equal((await readPackage("extensions/slack-tracker/package.json")).version, "0.1.1");
  assert.equal((await readPackage("vendor/codex-acp/package.json")).version, "0.0.45");
});

test("can bump from a supplied release-tag base version", async () => {
  await seedPackage("package.json", "lorenz", "0.1.0");
  await seedPackage("apps/cli/package.json", "@lorenz/cli", "0.1.0");

  const result = await bumpReleaseVersion({ workspaceRoot: tempRoot, baseVersion: "1.2.3" });

  assert.equal(result.previousVersion, "0.1.0");
  assert.equal(result.nextVersion, "1.2.4");
  assert.equal((await readPackage("package.json")).version, "1.2.4");
  assert.equal((await readPackage("apps/cli/package.json")).version, "1.2.4");
});

test("does not choose a base version below the current first-party version", async () => {
  await seedPackage("package.json", "lorenz", "1.3.0");
  await seedPackage("apps/cli/package.json", "@lorenz/cli", "1.3.0");

  const result = await bumpReleaseVersion({ workspaceRoot: tempRoot, baseVersion: "1.2.3" });

  assert.equal(result.previousVersion, "1.3.0");
  assert.equal(result.nextVersion, "1.3.1");
  assert.equal((await readPackage("package.json")).version, "1.3.1");
  assert.equal((await readPackage("apps/cli/package.json")).version, "1.3.1");
});

test("rejects mismatched first-party versions", async () => {
  await seedPackage("package.json", "lorenz", "0.1.0");
  await seedPackage("apps/cli/package.json", "@lorenz/cli", "0.1.0");
  await seedPackage("packages/acp/package.json", "@lorenz/acp", "0.2.0");

  await assert.rejects(
    bumpReleaseVersion({ workspaceRoot: tempRoot }),
    /first-party package versions must match/,
  );
});

async function seedPackage(relativePath: string, name: string, version: string): Promise<void> {
  const filePath = path.join(tempRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify({ name, version, type: "module" }, null, 2)}\n`);
}

async function readPackage(relativePath: string): Promise<{ version?: string }> {
  return JSON.parse(await fs.readFile(path.join(tempRoot, relativePath), "utf8")) as {
    version?: string;
  };
}
