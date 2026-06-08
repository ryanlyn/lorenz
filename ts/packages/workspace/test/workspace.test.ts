import fs from "node:fs/promises";
import path from "node:path";

import { test, vi } from "vitest";
import {
  safeIdentifier,
  workspacePath,
  ensureInsideRoot,
  validateWorkspaceCwd,
  createWorkspaceForIssue,
  removeWorkspace,
  removeIssueWorkspaces,
  shellEscape,
} from "@symphony/cli";
import type { Settings } from "@symphony/domain";

import { assert } from "../../../test/assert.js";
import { tempDir, sampleIssue } from "../../../test/helpers.js";
import { runHook } from "../src/index.js";

function makeSettings(
  root: string,
  hooks: Partial<Settings["hooks"]> = {},
  workspace: Partial<Settings["workspace"]> = {},
): Settings {
  return {
    workspace: { root, isolation: "per-agent", ...workspace },
    worker: { sshHosts: [], sshTimeoutMs: 5_000 },
    hooks: { timeoutMs: 5_000, ...hooks },
  } as unknown as Settings;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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

test('validateWorkspaceCwd — blank input throws "invalid_workspace_cwd"', async () => {
  const root = await tempDir("ws-validate");
  const settings = makeSettings(root);
  await assert.rejects(() => validateWorkspaceCwd(settings, "   "), /invalid_workspace_cwd/);
});

test('validateWorkspaceCwd — newline in path throws "invalid_workspace_cwd"', async () => {
  const root = await tempDir("ws-validate");
  const settings = makeSettings(root);
  await assert.rejects(
    () => validateWorkspaceCwd(settings, "/some/path\n/injected"),
    /invalid_workspace_cwd/,
  );
});

test("validateWorkspaceCwd — accepts final symlinks that resolve inside the root", async () => {
  const root = await tempDir("ws-validate");
  const real = path.join(root, "real");
  const link = path.join(root, "link");
  await fs.mkdir(real);
  await fs.symlink(real, link);
  const settings = makeSettings(root);
  const result = await validateWorkspaceCwd(settings, link);
  assert.equal(result, await fs.realpath(real));
});

test("validateWorkspaceCwd — accepts symlinked components that resolve inside the root", async () => {
  const root = await tempDir("ws-validate");
  const canonicalRoot = await fs.realpath(root);
  const realParent = path.join(canonicalRoot, "real-parent");
  const workspace = path.join(realParent, "MT-1");
  const linkParent = path.join(canonicalRoot, "link-parent");
  await fs.mkdir(workspace, { recursive: true });
  await fs.symlink(realParent, linkParent);

  const settings = makeSettings(root);
  const result = await validateWorkspaceCwd(settings, path.join(linkParent, "MT-1"));

  assert.equal(result, await fs.realpath(workspace));
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

test("runHook — abort terminates subprocesses before they write later markers", async () => {
  const root = await tempDir("ws-hook-abort");
  const settings = makeSettings(root);
  const started = path.join(root, "started.txt");
  const marker = path.join(root, "marker.txt");
  const controller = new AbortController();
  const command = [
    `printf started > ${shellEscape(started)}`,
    `sleep 0.2`,
    `printf late > ${shellEscape(marker)}`,
  ].join("\n");

  const promise = runHook(command, root, settings.hooks, null, {
    abortSignal: controller.signal,
  });

  await vi.waitFor(async () => {
    assert.equal(await fileExists(started), true);
  });
  controller.abort();

  await assert.rejects(() => promise, /hook canceled/);
  await new Promise((resolve) => setTimeout(resolve, 350));

  assert.equal(await fileExists(marker), false);
});

test("createWorkspaceForIssue — replaces a stale final file and runs afterCreate", async () => {
  const root = await tempDir("ws-create");
  const stalePath = path.join(root, safeIdentifier(sampleIssue.identifier));
  await fs.writeFile(stalePath, "stale");
  const settings = makeSettings(root, { afterCreate: "touch .hook-ran" });

  const ws = await createWorkspaceForIssue(settings, sampleIssue);

  assert.equal(ws, await fs.realpath(stalePath));
  assert.ok((await fs.stat(ws)).isDirectory());
  assert.ok((await fs.stat(path.join(ws, ".hook-ran"))).isFile());
});

test("createWorkspaceForIssue — retries when an existing segment disappears before lstat", async () => {
  const root = await tempDir("ws-create");
  const issueRoot = path.join(root, safeIdentifier(sampleIssue.identifier));
  await fs.mkdir(issueRoot);
  const canonicalIssueRoot = await fs.realpath(issueRoot);
  const realLstat = fs.lstat;
  let injected = false;
  const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (filePath, options) => {
    if (!injected && path.resolve(String(filePath)) === canonicalIssueRoot) {
      injected = true;
      throw Object.assign(new Error("transient missing path"), { code: "ENOENT" });
    }
    return realLstat(filePath, options);
  });

  try {
    const settings = makeSettings(root);
    const ws = await createWorkspaceForIssue(settings, sampleIssue, {
      slotIndex: 0,
      ensembleSize: 2,
    });

    assert.equal(ws, path.join(canonicalIssueRoot, "0"));
    assert.ok((await fs.stat(ws)).isDirectory());
    assert.equal(injected, true);
  } finally {
    lstatSpy.mockRestore();
  }
});

// --- shared workspace (isolation: "none") ---

test("createWorkspaceForIssue — shared mode returns the root for every issue", async () => {
  const root = await tempDir("ws-shared");
  const settings = makeSettings(root, {}, { isolation: "none" });
  const canonicalRoot = await fs.realpath(root);
  const first = await createWorkspaceForIssue(settings, sampleIssue);
  const second = await createWorkspaceForIssue(settings, { ...sampleIssue, identifier: "MT-2" });
  assert.equal(first, canonicalRoot);
  assert.equal(second, canonicalRoot);
});

test("validateWorkspaceCwd — shared mode allows the root as cwd", async () => {
  const root = await tempDir("ws-shared");
  const settings = makeSettings(root, {}, { isolation: "none" });
  const result = await validateWorkspaceCwd(settings, root);
  assert.equal(result, await fs.realpath(root));
});

test("removeIssueWorkspaces — shared mode never deletes the root", async () => {
  const root = await tempDir("ws-shared");
  const settings = makeSettings(root, {}, { isolation: "none" });
  await createWorkspaceForIssue(settings, sampleIssue);
  await removeIssueWorkspaces(settings, sampleIssue.identifier);
  const stat = await fs.stat(root);
  assert.ok(stat.isDirectory());
});

test("createWorkspaceForIssue — shared mode never runs the afterCreate hook", async () => {
  const root = await tempDir("ws-shared");
  // Hooks can never reach this path through parseConfig (it rejects them); construct directly to
  // prove the shared code path itself runs no hooks, independent of config validation.
  const settings = makeSettings(root, { afterCreate: "touch .hook-ran" }, { isolation: "none" });
  const ws = await createWorkspaceForIssue(settings, sampleIssue);
  await assert.rejects(
    () => fs.stat(path.join(ws, ".hook-ran")),
    (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("removeIssueWorkspaces — shared mode never runs the beforeRemove hook", async () => {
  const root = await tempDir("ws-shared");
  const marker = path.join(root, "before-remove-ran");
  const settings = makeSettings(
    root,
    { beforeRemove: `touch ${JSON.stringify(marker)}` },
    { isolation: "none" },
  );
  await createWorkspaceForIssue(settings, sampleIssue);
  await removeIssueWorkspaces(settings, sampleIssue.identifier);
  await assert.rejects(
    () => fs.stat(marker),
    (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
  );
});

// --- removeWorkspace ---

test("removeWorkspace — removes existing workspace directory", async () => {
  const root = await tempDir("ws-remove");
  const settings = makeSettings(root);
  const ws = await createWorkspaceForIssue(settings, sampleIssue);
  const removed = await removeWorkspace(settings, ws);
  assert.deepEqual(removed, [ws]);
  await assert.rejects(
    () => fs.stat(ws),
    (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("removeWorkspace — refuses to remove workspace root", async () => {
  const root = await tempDir("ws-remove");
  const settings = makeSettings(root);
  await assert.rejects(() => removeWorkspace(settings, root), /refusing to remove workspace root/);
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
