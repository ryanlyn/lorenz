import fs from "node:fs/promises";
import path from "node:path";

import { test } from "vitest";
import {
  safeIdentifier,
  workspacePath,
  ensureInsideRoot,
  validateWorkspaceCwd,
  createWorkspaceForIssue,
  removeWorkspace,
} from "@symphony/cli";
import type { Settings } from "@symphony/domain";

import { assert } from "../../../test/assert.js";
import { tempDir, sampleIssue } from "../../../test/helpers.js";

function makeSettings(root: string, hooks: Partial<Settings["hooks"]> = {}): Settings {
  return {
    workspace: { root },
    worker: { sshHosts: [], sshTimeoutMs: 5_000 },
    hooks: { timeoutMs: 5_000, ...hooks },
  } as unknown as Settings;
}

// --- safeIdentifier ---

test("safeIdentifier — strips non-alphanumeric characters", () => {
  assert.equal(safeIdentifier("MT-1"), "MT-1");
  assert.equal(safeIdentifier("feat/branch name!@#$%"), "feat_branch_name_____");
  assert.equal(safeIdentifier("hello world"), "hello_world");
  assert.equal(safeIdentifier("dots.and_underscores"), "dots.and_underscores");
});

test("safeIdentifier — empty/non-string returns empty", () => {
  assert.equal(safeIdentifier(""), "");
  assert.equal(safeIdentifier(null), "");
  assert.equal(safeIdentifier(undefined), "");
  assert.equal(safeIdentifier(123), "");
});

// --- workspacePath ---

test("workspacePath — single slot omits slot index subdirectory", () => {
  const result = workspacePath("/root", "MT-1", 0, 1);
  assert.equal(result, path.join("/root", "MT-1"));
});

test("workspacePath — ensemble adds slot index subdirectory", () => {
  const result = workspacePath("/root", "MT-1", 2, 4);
  assert.equal(result, path.join("/root", "MT-1", "2"));
});

// --- ensureInsideRoot ---

test("ensureInsideRoot — path within root does not throw", () => {
  ensureInsideRoot("/root/workspace/MT-1", "/root/workspace");
});

test("ensureInsideRoot — path outside root throws", () => {
  assert.throws(
    () => ensureInsideRoot("/other/place", "/root/workspace"),
    /workspace outside root/,
  );
});

test("ensureInsideRoot — root itself does not throw", () => {
  ensureInsideRoot("/root/workspace", "/root/workspace");
});

// --- validateWorkspaceCwd ---

test("validateWorkspaceCwd — blank input throws \"invalid_workspace_cwd\"", async () => {
  const root = await tempDir("ws-validate");
  const settings = makeSettings(root);
  await assert.rejects(
    () => validateWorkspaceCwd(settings, "   "),
    /invalid_workspace_cwd/,
  );
});

test("validateWorkspaceCwd — newline in path throws \"invalid_workspace_cwd\"", async () => {
  const root = await tempDir("ws-validate");
  const settings = makeSettings(root);
  await assert.rejects(
    () => validateWorkspaceCwd(settings, "/some/path\n/injected"),
    /invalid_workspace_cwd/,
  );
});

test("validateWorkspaceCwd — rejects directory targets that are symlinks", async () => {
  const root = await tempDir("ws-validate");
  const real = path.join(root, "real");
  const link = path.join(root, "link");
  await fs.mkdir(real);
  await fs.symlink(real, link);
  const settings = makeSettings(root);
  await assert.rejects(
    () => validateWorkspaceCwd(settings, link),
    /unsafe symlink/,
  );
});

test("validateWorkspaceCwd — rejects workspace equal to workspace root", async () => {
  const root = await tempDir("ws-validate");
  const settings = makeSettings(root);
  await assert.rejects(
    () => validateWorkspaceCwd(settings, root),
    /refusing to use workspace root as cwd/,
  );
});

// --- createWorkspaceForIssue ---

test("createWorkspaceForIssue — creates directory and returns canonical path", async () => {
  const root = await tempDir("ws-create");
  const settings = makeSettings(root);
  const result = await createWorkspaceForIssue(settings, sampleIssue);
  const expected = path.join(await fs.realpath(root), safeIdentifier(sampleIssue.identifier));
  assert.equal(result, expected);
  const stat = await fs.stat(result);
  assert.ok(stat.isDirectory());
});

test("createWorkspaceForIssue — reuses existing workspace directory", async () => {
  const root = await tempDir("ws-create");
  const settings = makeSettings(root);
  const first = await createWorkspaceForIssue(settings, sampleIssue);
  const second = await createWorkspaceForIssue(settings, sampleIssue);
  assert.equal(first, second);
});

test("createWorkspaceForIssue — runs afterCreate hook on new workspace", async () => {
  const root = await tempDir("ws-create");
  const settings = makeSettings(root, { afterCreate: "touch .hook-ran" });
  const ws = await createWorkspaceForIssue(settings, sampleIssue);
  const hookFile = path.join(ws, ".hook-ran");
  const stat = await fs.stat(hookFile);
  assert.ok(stat.isFile());
});

// --- removeWorkspace ---

test("removeWorkspace — removes existing workspace directory", async () => {
  const root = await tempDir("ws-remove");
  const settings = makeSettings(root);
  const ws = await createWorkspaceForIssue(settings, sampleIssue);
  const removed = await removeWorkspace(settings, ws);
  assert.deepEqual(removed, [ws]);
  await assert.rejects(() => fs.stat(ws), (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT");
});

test("removeWorkspace — refuses to remove workspace root", async () => {
  const root = await tempDir("ws-remove");
  const settings = makeSettings(root);
  await assert.rejects(
    () => removeWorkspace(settings, root),
    /refusing to remove workspace root/,
  );
});

test("removeWorkspace — runs beforeRemove hook before deletion", async () => {
  const root = await tempDir("ws-remove");
  const markerFile = path.join(root, "hook-marker");
  const settings = makeSettings(root, {
    beforeRemove: `touch ${JSON.stringify(markerFile)}`,
  });
  const ws = await createWorkspaceForIssue(settings, sampleIssue);
  await removeWorkspace(settings, ws);
  const stat = await fs.stat(markerFile);
  assert.ok(stat.isFile());
});

test("removeWorkspace — nonexistent workspace returns empty array", async () => {
  const root = await tempDir("ws-remove");
  const settings = makeSettings(root);
  const result = await removeWorkspace(settings, path.join(root, "does-not-exist"));
  assert.deepEqual(result, []);
});
