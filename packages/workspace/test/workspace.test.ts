import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, test, vi } from "vitest";
import {
  safeIdentifier,
  workspacePath,
  ensureInsideRoot,
  validateWorkspaceCwd,
  createWorkspaceForIssue,
  listIssueWorkspaceIdentifiers,
  removeWorkspace,
  removeIssueWorkspaces,
  shellEscape,
} from "@lorenz/cli";
import type { HookExecutionMessage, Settings } from "@lorenz/domain";
import { assert, tempDir, sampleIssue, writeExecutable, settle } from "@lorenz/test-utils";

import { runHook, syncWorkspaceSkills, type WorkspaceSkillOverlay } from "../src/index.js";

let savedPath: string | undefined;

beforeEach(() => {
  savedPath = process.env.PATH;
});

afterEach(() => {
  restoreEnv("PATH", savedPath);
});

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

/** A `.lorenz/skills` overlay from the given source directories. */
function skillOverlay(sources: string[], destDir = ".lorenz/skills"): WorkspaceSkillOverlay {
  return { sources, destDir };
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

// --- workspacePath forceSlotSuffix (gated co-residence) ---

test("workspacePath — forceSlotSuffix off (default) keeps the bare single-slot layout", () => {
  // The default (flag absent / false) is byte-identical to today: a solo run
  // (ensembleSize=1) returns the bare `<root>/<identifier>`, never a slot dir.
  assert.equal(workspacePath("/root", "MT-1", 0, 1, false), path.join("/root", "MT-1"));
  assert.equal(workspacePath("/root", "MT-1", 0, 1), path.join("/root", "MT-1"));
});

test("workspacePath — forceSlotSuffix applies the slot dir UNCONDITIONALLY even when ensembleSize=1", () => {
  // Co-residence: two slots of ONE issue may co-reside on one machine even though
  // each is a solo (ensembleSize=1) run, so the suffix must apply unconditionally
  // to give them distinct dirs.
  assert.equal(workspacePath("/root", "MT-1", 0, 1, true), path.join("/root", "MT-1", "0"));
  assert.equal(workspacePath("/root", "MT-1", 1, 1, true), path.join("/root", "MT-1", "1"));
});

test("workspacePath — forceSlotSuffix gives two co-resident same-issue slots DISTINCT paths", () => {
  const a = workspacePath("/root", "MT-1", 0, 1, true);
  const b = workspacePath("/root", "MT-1", 1, 1, true);
  assert.equal(a, path.join("/root", "MT-1", "0"));
  assert.equal(b, path.join("/root", "MT-1", "1"));
  assert.ok(a !== b);
});

test("workspacePath — forceSlotSuffix does not change the ensemble path (suffix already present)", () => {
  // When ensembleSize>1 the suffix is already applied; forcing it is a no-op.
  assert.equal(
    workspacePath("/root", "MT-1", 2, 4, true),
    workspacePath("/root", "MT-1", 2, 4, false),
  );
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
  await assert.rejects(
    () => validateWorkspaceCwd(settings, "   ", process.env),
    /invalid_workspace_cwd/,
  );
});

test('validateWorkspaceCwd — newline in path throws "invalid_workspace_cwd"', async () => {
  const root = await tempDir("ws-validate");
  const settings = makeSettings(root);
  await assert.rejects(
    () => validateWorkspaceCwd(settings, "/some/path\n/injected", process.env),
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
  const result = await validateWorkspaceCwd(settings, link, process.env);
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
  const result = await validateWorkspaceCwd(settings, path.join(linkParent, "MT-1"), process.env);

  assert.equal(result, await fs.realpath(workspace));
});

test("validateWorkspaceCwd — rejects workspace equal to workspace root", async () => {
  const root = await tempDir("ws-validate");
  const settings = makeSettings(root);
  await assert.rejects(
    () => validateWorkspaceCwd(settings, root, process.env),
    /refusing to use workspace root as cwd/,
  );
});

// --- createWorkspaceForIssue ---

test("createWorkspaceForIssue — creates directory and returns canonical path", async () => {
  const root = await tempDir("ws-create");
  const settings = makeSettings(root);
  const result = await createWorkspaceForIssue(settings, sampleIssue, process.env);
  const expected = path.join(await fs.realpath(root), safeIdentifier(sampleIssue.identifier));
  assert.equal(result, expected);
  const stat = await fs.stat(result);
  assert.ok(stat.isDirectory());
});

test("createWorkspaceForIssue — reuses existing workspace directory", async () => {
  const root = await tempDir("ws-create");
  const settings = makeSettings(root);
  const first = await createWorkspaceForIssue(settings, sampleIssue, process.env);
  const second = await createWorkspaceForIssue(settings, sampleIssue, process.env);
  assert.equal(first, second);
});

test("createWorkspaceForIssue — runs afterCreate hook on new workspace", async () => {
  const root = await tempDir("ws-create");
  const settings = makeSettings(root, { afterCreate: "touch .hook-ran" });
  const ws = await createWorkspaceForIssue(settings, sampleIssue, process.env);
  const hookFile = path.join(ws, ".hook-ran");
  const stat = await fs.stat(hookFile);
  assert.ok(stat.isFile());
});

test("createWorkspaceForIssue — default (no forceSlotSuffix) returns the bare issue dir", async () => {
  const root = await tempDir("ws-create-bare");
  const settings = makeSettings(root);
  const ws = await createWorkspaceForIssue(settings, sampleIssue, process.env, {
    slotIndex: 0,
    ensembleSize: 1,
  });
  const expected = path.join(await fs.realpath(root), safeIdentifier(sampleIssue.identifier));
  assert.equal(ws, expected);
});

test("createWorkspaceForIssue — forceSlotSuffix shards two co-resident same-issue slots into distinct dirs", async () => {
  const root = await tempDir("ws-create-coreside");
  const settings = makeSettings(root);
  const canonicalRoot = await fs.realpath(root);
  const issueRoot = path.join(canonicalRoot, safeIdentifier(sampleIssue.identifier));

  // Both runs are solo (ensembleSize=1) yet co-reside on one machine: forceSlotSuffix
  // must give them distinct `<issue>/<slotIndex>` dirs, never the shared bare path.
  const slot0 = await createWorkspaceForIssue(settings, sampleIssue, process.env, {
    slotIndex: 0,
    ensembleSize: 1,
    forceSlotSuffix: true,
  });
  const slot1 = await createWorkspaceForIssue(settings, sampleIssue, process.env, {
    slotIndex: 1,
    ensembleSize: 1,
    forceSlotSuffix: true,
  });

  assert.equal(slot0, path.join(issueRoot, "0"));
  assert.equal(slot1, path.join(issueRoot, "1"));
  assert.ok(slot0 !== slot1);
  assert.ok((await fs.stat(slot0)).isDirectory());
  assert.ok((await fs.stat(slot1)).isDirectory());
});

test("createWorkspaceForIssue — overlays configured skill directories after afterCreate", async () => {
  const root = await tempDir("ws-create-skills");
  const sources = await tempDir("ws-skill-sources");
  const skill = path.join(sources, "lorenz-land");
  await fs.mkdir(path.join(skill, "scripts"), { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "from source\n");
  await fs.writeFile(path.join(skill, "scripts", "land.sh"), "echo land\n");
  const settings = makeSettings(root, {
    afterCreate:
      "mkdir -p .lorenz/skills/lorenz-land && printf hook > .lorenz/skills/lorenz-land/SKILL.md",
  });

  const ws = await createWorkspaceForIssue(settings, sampleIssue, process.env, {
    skillOverlay: skillOverlay([skill]),
  });

  assert.equal(
    await fs.readFile(path.join(ws, ".lorenz", "skills", "lorenz-land", "SKILL.md"), "utf8"),
    "from source\n",
  );
  assert.equal(
    await fs.readFile(
      path.join(ws, ".lorenz", "skills", "lorenz-land", "scripts", "land.sh"),
      "utf8",
    ),
    "echo land\n",
  );
});

test("createWorkspaceForIssue — writes .gitignore in skills destination", async () => {
  const root = await tempDir("ws-create-skills-dest");
  const sources = await tempDir("ws-skill-sources-dest");
  const skill = path.join(sources, "lorenz-linear");
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "linear\n");
  const settings = makeSettings(root);

  const ws = await createWorkspaceForIssue(settings, sampleIssue, process.env, {
    skillOverlay: skillOverlay([skill]),
  });

  assert.equal(
    await fs.readFile(path.join(ws, ".lorenz", "skills", "lorenz-linear", "SKILL.md"), "utf8"),
    "linear\n",
  );
  assert.equal(await fs.readFile(path.join(ws, ".lorenz", "skills", ".gitignore"), "utf8"), "*\n");
});

test("createWorkspaceForIssue — refreshes skills when reusing an existing workspace", async () => {
  const root = await tempDir("ws-create-skills-refresh");
  const sources = await tempDir("ws-skill-sources-refresh");
  const skill = path.join(sources, "lorenz-push");
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "first\n");
  const settings = makeSettings(root);
  const overlay = skillOverlay([skill]);

  const first = await createWorkspaceForIssue(settings, sampleIssue, process.env, {
    skillOverlay: overlay,
  });
  await fs.writeFile(path.join(skill, "SKILL.md"), "second\n");
  const second = await createWorkspaceForIssue(settings, sampleIssue, process.env, {
    skillOverlay: overlay,
  });

  assert.equal(second, first);
  assert.equal(
    await fs.readFile(path.join(first, ".lorenz", "skills", "lorenz-push", "SKILL.md"), "utf8"),
    "second\n",
  );
});

test("createWorkspaceForIssue — copies the whole skill directory under its basename", async () => {
  const root = await tempDir("ws-create-skills-whole");
  const sources = await tempDir("ws-skill-source-whole");
  const skill = path.join(sources, "lorenz-linear");
  await fs.mkdir(path.join(skill, "scripts"), { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "linear\n");
  await fs.writeFile(path.join(skill, "scripts", "run.sh"), "echo run\n");
  const settings = makeSettings(root);

  const ws = await createWorkspaceForIssue(settings, sampleIssue, process.env, {
    skillOverlay: skillOverlay([skill]),
  });

  assert.equal(
    await fs.readFile(path.join(ws, ".lorenz", "skills", "lorenz-linear", "SKILL.md"), "utf8"),
    "linear\n",
  );
  assert.equal(
    await fs.readFile(
      path.join(ws, ".lorenz", "skills", "lorenz-linear", "scripts", "run.sh"),
      "utf8",
    ),
    "echo run\n",
  );
});

test("createWorkspaceForIssue — rejects skill source files (skills must be directories)", async () => {
  const root = await tempDir("ws-create-skill-file");
  const sources = await tempDir("ws-skill-file-source");
  const sourceFile = path.join(sources, "TEAM.md");
  await fs.writeFile(sourceFile, "team guidance\n");
  const settings = makeSettings(root);

  await assert.rejects(
    () =>
      createWorkspaceForIssue(settings, sampleIssue, process.env, {
        skillOverlay: skillOverlay([sourceFile]),
      }),
    /workspace_skill_source_unsupported/,
  );
});

test("createWorkspaceForIssue - rejects symlinked skill overlay directories", async () => {
  const root = await tempDir("ws-create-skills-symlink");
  const sources = await tempDir("ws-skill-symlink-source");
  const skill = path.join(sources, "lorenz-land");
  const outside = await tempDir("ws-skill-symlink-outside");
  const workspace = path.join(await fs.realpath(root), safeIdentifier(sampleIssue.identifier));
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "land\n");
  await fs.mkdir(workspace, { recursive: true });
  await fs.symlink(outside, path.join(workspace, ".lorenz"));
  const settings = makeSettings(root);

  await assert.rejects(
    () =>
      createWorkspaceForIssue(settings, sampleIssue, process.env, {
        skillOverlay: skillOverlay([skill]),
      }),
    /unsafe symlink/,
  );
  assert.equal(await fileExists(path.join(outside, "skills", "lorenz-land", "SKILL.md")), false);
});

test("createWorkspaceForIssue - rejects symlinked skill overlay targets", async () => {
  const root = await tempDir("ws-create-skill-target-symlink");
  const sources = await tempDir("ws-skill-target-symlink-source");
  const skill = path.join(sources, "lorenz-land");
  const outside = await tempDir("ws-skill-target-symlink-outside");
  const workspace = path.join(await fs.realpath(root), safeIdentifier(sampleIssue.identifier));
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "land\n");
  await fs.mkdir(path.join(workspace, ".lorenz", "skills"), { recursive: true });
  await fs.symlink(outside, path.join(workspace, ".lorenz", "skills", "lorenz-land"));
  const settings = makeSettings(root);

  await assert.rejects(
    () =>
      createWorkspaceForIssue(settings, sampleIssue, process.env, {
        skillOverlay: skillOverlay([skill]),
      }),
    /unsafe symlink/,
  );
  assert.equal(await fileExists(path.join(outside, "SKILL.md")), false);
});

test("createWorkspaceForIssue - rejects skill target symlinks that point to the source", async () => {
  const root = await tempDir("ws-create-skill-target-source-symlink");
  const sources = await tempDir("ws-skill-target-source-symlink-source");
  const skill = path.join(sources, "lorenz-land");
  const workspace = path.join(await fs.realpath(root), safeIdentifier(sampleIssue.identifier));
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "land\n");
  await fs.mkdir(path.join(workspace, ".lorenz", "skills"), { recursive: true });
  await fs.symlink(skill, path.join(workspace, ".lorenz", "skills", "lorenz-land"));
  const settings = makeSettings(root);

  await assert.rejects(
    () =>
      createWorkspaceForIssue(settings, sampleIssue, process.env, {
        skillOverlay: skillOverlay([skill]),
      }),
    /unsafe symlink/,
  );
});

test("createWorkspaceForIssue - rejects symlinked skill source entries", async () => {
  const root = await tempDir("ws-create-skill-source-symlink");
  const sources = await tempDir("ws-skill-source-symlink-source");
  const outside = await tempDir("ws-skill-source-symlink-outside");
  const skill = path.join(sources, "lorenz-land");
  const secret = path.join(outside, "secret.txt");
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(secret, "do not copy\n");
  await fs.symlink(secret, path.join(skill, "SKILL.md"));
  const settings = makeSettings(root);

  await assert.rejects(
    () =>
      createWorkspaceForIssue(settings, sampleIssue, process.env, {
        skillOverlay: skillOverlay([skill]),
      }),
    /workspace_skill_source_symlink/,
  );
});

test("createWorkspaceForIssue - replaces skill targets before refreshing", async () => {
  const root = await tempDir("ws-create-skill-nested-symlink");
  const sources = await tempDir("ws-skill-nested-symlink-source");
  const outside = await tempDir("ws-skill-nested-symlink-outside");
  const skill = path.join(sources, "lorenz-land");
  const workspace = path.join(await fs.realpath(root), safeIdentifier(sampleIssue.identifier));
  await fs.mkdir(path.join(skill, "scripts"), { recursive: true });
  await fs.writeFile(path.join(skill, "scripts", "land.sh"), "echo land\n");
  await fs.mkdir(path.join(workspace, ".lorenz", "skills", "lorenz-land"), { recursive: true });
  await fs.symlink(outside, path.join(workspace, ".lorenz", "skills", "lorenz-land", "scripts"));
  const settings = makeSettings(root);

  const ws = await createWorkspaceForIssue(settings, sampleIssue, process.env, {
    skillOverlay: skillOverlay([skill]),
  });

  const scriptsPath = path.join(ws, ".lorenz", "skills", "lorenz-land", "scripts");
  assert.equal((await fs.lstat(scriptsPath)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(path.join(scriptsPath, "land.sh"), "utf8"), "echo land\n");
  assert.equal(await fileExists(path.join(outside, "land.sh")), false);
});

test("syncWorkspaceSkills - replaces remote skill targets before extracting", async () => {
  const root = await tempDir("ws-remote-skill-nested-symlink");
  const trace = path.join(root, "ssh.trace");
  const sources = await tempDir("ws-remote-skill-nested-symlink-source");
  const outside = await tempDir("ws-remote-skill-nested-symlink-outside");
  const workspace = path.join(root, "remote", "MT-1");
  const skill = path.join(sources, "lorenz-land");
  await fs.mkdir(path.join(skill, "scripts"), { recursive: true });
  await fs.writeFile(path.join(skill, "scripts", "land.sh"), "echo land\n");
  await fs.mkdir(path.join(workspace, ".lorenz", "skills", "lorenz-land"), { recursive: true });
  await fs.symlink(outside, path.join(workspace, ".lorenz", "skills", "lorenz-land", "scripts"));
  await installFakeSsh(
    root,
    trace,
    `#!/bin/sh
for arg in "$@"; do last_arg="$arg"; done
eval "$last_arg"
`,
  );

  await syncWorkspaceSkills(workspace, skillOverlay([skill]), process.env, "localhost", {
    timeoutMs: 5_000,
  });

  const scriptsPath = path.join(workspace, ".lorenz", "skills", "lorenz-land", "scripts");
  assert.equal((await fs.lstat(scriptsPath)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(path.join(scriptsPath, "land.sh"), "utf8"), "echo land\n");
  assert.equal(await fileExists(path.join(outside, "land.sh")), false);
});

test("syncWorkspaceSkills - archives remote skill sources with hyphen-prefixed names", async () => {
  const root = await tempDir("ws-remote-skill-hyphen");
  const trace = path.join(root, "ssh.trace");
  const sources = await tempDir("ws-remote-skill-hyphen-source");
  const workspace = path.join(root, "remote", "MT-1");
  const skill = path.join(sources, "-team-skill");
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "team\n");
  await installFakeSsh(
    root,
    trace,
    `#!/bin/sh
for arg in "$@"; do last_arg="$arg"; done
eval "$last_arg"
`,
  );

  await syncWorkspaceSkills(workspace, skillOverlay([skill]), process.env, "localhost", {
    timeoutMs: 5_000,
  });

  assert.equal(
    await fs.readFile(path.join(workspace, ".lorenz", "skills", "-team-skill", "SKILL.md"), "utf8"),
    "team\n",
  );
});

test("syncWorkspaceSkills - archives overlapping remote skill sources before deleting targets", async () => {
  const root = await tempDir("ws-remote-skill-overlap");
  const trace = path.join(root, "ssh.trace");
  const workspace = path.join(root, "remote", "MT-1");
  const skillsRoot = path.join(workspace, ".lorenz", "skills");
  await fs.mkdir(path.join(skillsRoot, "lorenz-land"), { recursive: true });
  await fs.writeFile(path.join(skillsRoot, "lorenz-land", "SKILL.md"), "land\n");
  await installFakeSsh(
    root,
    trace,
    `#!/bin/sh
for arg in "$@"; do last_arg="$arg"; done
eval "$last_arg"
`,
  );

  await syncWorkspaceSkills(
    workspace,
    skillOverlay([path.join(skillsRoot, "lorenz-land")]),
    process.env,
    "localhost",
    { timeoutMs: 5_000 },
  );

  assert.equal(
    await fs.readFile(path.join(skillsRoot, "lorenz-land", "SKILL.md"), "utf8"),
    "land\n",
  );
});

test("syncWorkspaceSkills - times out remote skill sync ssh transfers", async () => {
  const root = await tempDir("ws-remote-skills-timeout");
  const trace = path.join(root, "ssh.trace");
  const sources = await tempDir("ws-remote-skill-timeout-source");
  const skill = path.join(sources, "lorenz-land");
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, "SKILL.md"), "land\n");
  await installFakeSsh(
    root,
    trace,
    `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> ${shellEscape(trace)}
while :; do sleep 1; done
`,
  );

  await assert.rejects(
    () =>
      syncWorkspaceSkills(
        "/remote/workspaces/MT-1",
        skillOverlay([skill]),
        process.env,
        "localhost",
        {
          timeoutMs: 50,
        },
      ),
    /workspace_skill_remote_sync_timeout: localhost 50/,
  );
});

test("createWorkspaceForIssue — installs skills into shared workspaces", async () => {
  const root = await tempDir("ws-shared-skills");
  const sources = await tempDir("ws-shared-skill-source");
  const skill = path.join(sources, "lorenz-debug");
  await fs.mkdir(skill);
  await fs.writeFile(path.join(skill, "SKILL.md"), "debug\n");
  const settings = makeSettings(root, {}, { isolation: "none" });

  const ws = await createWorkspaceForIssue(settings, sampleIssue, process.env, {
    skillOverlay: skillOverlay([skill]),
  });

  assert.equal(ws, await fs.realpath(root));
  assert.equal(
    await fs.readFile(path.join(ws, ".lorenz", "skills", "lorenz-debug", "SKILL.md"), "utf8"),
    "debug\n",
  );
});

test("createWorkspaceForIssue — rejects missing configured skill sources", async () => {
  const root = await tempDir("ws-create-missing-skill");
  const missing = path.join(root, "missing-skill");
  const settings = makeSettings(root);

  await assert.rejects(
    () =>
      createWorkspaceForIssue(settings, sampleIssue, process.env, {
        skillOverlay: skillOverlay([missing]),
      }),
    /workspace_skill_source_missing/,
  );
});
test("createWorkspaceForIssue — renders Liquid template variables in afterCreate hook", async () => {
  const root = await tempDir("ws-create-tpl");
  const settings = makeSettings(root, {
    afterCreate: "printf '%s' {{ issue.identifier }} > .issue-id",
  });
  const ws = await createWorkspaceForIssue(settings, sampleIssue, process.env);
  const content = await fs.readFile(path.join(ws, ".issue-id"), "utf8");
  assert.equal(content, sampleIssue.identifier);
});

test("runHook — renders Liquid template variables when issue is provided", async () => {
  const root = await tempDir("ws-hook-tpl");
  const settings = makeSettings(root);
  const outFile = path.join(root, "title.txt");
  await runHook(
    `printf '%s' {{ issue.title }} > ${JSON.stringify(outFile)}`,
    root,
    settings.hooks,
    process.env,
    null,
    {},
    sampleIssue,
  );
  const content = await fs.readFile(outFile, "utf8");
  assert.equal(content, sampleIssue.title);
});

test("runHook — shell-escapes issue fields to prevent injection", async () => {
  const root = await tempDir("ws-hook-inject");
  const settings = makeSettings(root);
  const outFile = path.join(root, "escaped.txt");
  const maliciousIssue = {
    ...sampleIssue,
    title: '"; rm -rf / #',
  };
  await runHook(
    `printf '%s' {{ issue.title }} > ${JSON.stringify(outFile)}`,
    root,
    settings.hooks,
    process.env,
    null,
    {},
    maliciousIssue,
  );
  const content = await fs.readFile(outFile, "utf8");
  assert.equal(content, '"; rm -rf / #');
});

test("runHook — keeps raw issue values for Liquid conditionals and comparisons", async () => {
  const root = await tempDir("ws-hook-logic");
  const settings = makeSettings(root);
  const outFile = path.join(root, "logic.txt");
  const command = [
    `{% if issue.branch_name %}printf branch{% else %}printf no-branch{% endif %} > ${JSON.stringify(outFile)}`,
    `{% if issue.state == "Todo" %}printf ":todo"{% endif %} >> ${JSON.stringify(outFile)}`,
  ].join("\n");

  await runHook(
    command,
    root,
    settings.hooks,
    process.env,
    null,
    {},
    { ...sampleIssue, branchName: null },
  );

  const content = await fs.readFile(outFile, "utf8");
  assert.equal(content, "no-branch:todo");
});

test("runHook — renders loops over issue arrays as shell-safe words", async () => {
  const root = await tempDir("ws-hook-loop");
  const settings = makeSettings(root);
  const outFile = path.join(root, "labels.txt");
  const issue = { ...sampleIssue, labels: ["backend", "needs review"] };
  const command = [
    `for label in {% for label in issue.labels %}{{ label }} {% endfor %}; do`,
    '  printf "<%s>" "$label"',
    `done > ${JSON.stringify(outFile)}`,
  ].join("\n");

  await runHook(command, root, settings.hooks, process.env, null, {}, issue);

  const content = await fs.readFile(outFile, "utf8");
  assert.equal(content, "<backend><needs review>");
});

test("runHook — exposes blocked_by issue refs in hook templates", async () => {
  const root = await tempDir("ws-hook-blockers");
  const settings = makeSettings(root);
  const outFile = path.join(root, "blockers.txt");
  const issue = {
    ...sampleIssue,
    blockers: [{ identifier: "MT-0", state: "Todo", stateType: "unstarted" as const }],
  };
  const command = [
    `for blocker in {% for blocker in issue.blocked_by %}{{ blocker.identifier }} {% endfor %}; do`,
    '  printf "%s" "$blocker"',
    `done > ${JSON.stringify(outFile)}`,
  ].join("\n");

  await runHook(command, root, settings.hooks, process.env, null, {}, issue);

  const content = await fs.readFile(outFile, "utf8");
  assert.equal(content, "MT-0");
});

test("runHook — supports raw filter for deliberate unescaped output", async () => {
  const root = await tempDir("ws-hook-raw");
  const settings = makeSettings(root);
  const outFile = path.join(root, "raw-filter.txt");
  await runHook(
    `printf '%s' "{{ issue.identifier | raw }}" > ${JSON.stringify(outFile)}`,
    root,
    settings.hooks,
    process.env,
    null,
    {},
    sampleIssue,
  );

  const content = await fs.readFile(outFile, "utf8");
  assert.equal(content, sampleIssue.identifier);
});

test("runHook — supports explicit shell_escape filter without double escaping", async () => {
  const root = await tempDir("ws-hook-shell-escape-filter");
  const settings = makeSettings(root);
  const outFile = path.join(root, "shell-escape-filter.txt");
  const issue = { ...sampleIssue, title: "quoted ' value" };
  await runHook(
    `printf '%s' {{ issue.title | shell_escape }} > ${JSON.stringify(outFile)}`,
    root,
    settings.hooks,
    process.env,
    null,
    {},
    issue,
  );

  const content = await fs.readFile(outFile, "utf8");
  assert.equal(content, issue.title);
});

test("runHook — fails loudly for unknown issue template variables", async () => {
  const root = await tempDir("ws-hook-unknown");
  const settings = makeSettings(root);
  const outFile = path.join(root, "unknown.txt");

  await assert.rejects(
    () =>
      runHook(
        `printf '%s' {{ issue.not_a_field }} > ${JSON.stringify(outFile)}`,
        root,
        settings.hooks,
        process.env,
        null,
        {},
        sampleIssue,
      ),
    /undefined variable|not_a_field/i,
  );
});

test("runHook — leaves non-issue double-brace syntax untouched", async () => {
  const root = await tempDir("ws-hook-non-issue");
  const settings = makeSettings(root);
  const outFile = path.join(root, "go-template.txt");
  await runHook(
    `printf '%s' '{{.State.Running}}' > ${JSON.stringify(outFile)}`,
    root,
    settings.hooks,
    process.env,
    null,
    {},
    sampleIssue,
  );

  const content = await fs.readFile(outFile, "utf8");
  assert.equal(content, "{{.State.Running}}");
});

test("runHook — passes command through unmodified when no issue context", async () => {
  const root = await tempDir("ws-hook-no-tpl");
  const settings = makeSettings(root);
  const outFile = path.join(root, "raw.txt");
  await runHook(
    `printf "%s" "{{ issue.identifier }}" > ${JSON.stringify(outFile)}`,
    root,
    settings.hooks,
    process.env,
  );
  const content = await fs.readFile(outFile, "utf8");
  assert.equal(content, "{{ issue.identifier }}");
});

test("runHook — emits start and completion hook execution events", async () => {
  const root = await tempDir("ws-hook-events");
  const settings = makeSettings(root);
  const events: HookExecutionMessage[] = [];
  const command = `printf "%s" "ok"`;

  await runHook(command, root, settings.hooks, process.env, null, {
    hookName: "before_run",
    onHookEvent: (event) => events.push(event),
  });

  assert.deepEqual(
    events.map((event) => event.status),
    ["started", "completed"],
  );
  assert.equal(events[0]!.command, command);
  assert.equal(events[0]!.cwd, root);
  assert.equal(events[0]!.hookName, "before_run");
  assert.equal(events[1]!.exitCode, 0);
  assert.equal(events[1]!.output, "ok");
  assert.equal(events[1]!.outputTruncated, false);
});

test("runHook — emits exit code and error details on hook failure", async () => {
  const root = await tempDir("ws-hook-failure-events");
  const settings = makeSettings(root);
  const events: HookExecutionMessage[] = [];
  const command = `printf "%s" "failed"; exit 17`;

  await assert.rejects(
    () =>
      runHook(command, root, settings.hooks, process.env, null, {
        hookName: "after_run",
        onHookEvent: (event) => events.push(event),
      }),
    /hook failed with status 17: failed/,
  );

  assert.deepEqual(
    events.map((event) => event.status),
    ["started", "failed"],
  );
  assert.equal(events[1]!.hookName, "after_run");
  assert.equal(events[1]!.exitCode, 17);
  assert.equal(events[1]!.output, "failed");
  assert.match(events[1]!.error ?? "", /hook failed with status 17: failed/);
});

test("createWorkspaceForIssue — refuses afterCreate when cwd is swapped to an out-of-root symlink", async () => {
  const root = await tempDir("ws-create");
  const canonicalRoot = await fs.realpath(root);
  const outside = await tempDir("ws-create-outside");
  const marker = path.join(outside, "hook-ran");
  const workspace = path.join(canonicalRoot, safeIdentifier(sampleIssue.identifier));
  const realRealpath = fs.realpath;
  let swapped = false;
  const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (filePath, options) => {
    const resolved = await realRealpath(filePath, options);
    if (!swapped && path.resolve(String(filePath)) === workspace) {
      swapped = true;
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.symlink(outside, workspace);
    }
    return resolved;
  });

  try {
    const settings = makeSettings(root, {
      afterCreate: `touch ${JSON.stringify(marker)}`,
    });

    await assert.rejects(
      () => createWorkspaceForIssue(settings, sampleIssue, process.env),
      /unsafe symlink in workspace path|workspace outside root/,
    );
    assert.equal(swapped, true);
    assert.equal(await fileExists(marker), false);
  } finally {
    realpathSpy.mockRestore();
  }
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

  const promise = runHook(command, root, settings.hooks, process.env, null, {
    abortSignal: controller.signal,
  });

  await vi.waitFor(async () => {
    assert.equal(await fileExists(started), true);
  });
  controller.abort();

  await assert.rejects(() => promise, /hook canceled/);
  // Asserting an absence (the aborted hook must never write the late marker).
  // This cannot be polled for, so settle past the hook's own `sleep 0.2` then
  // confirm the marker never appeared.
  await settle(350);

  assert.equal(await fileExists(marker), false);
});

test("createWorkspaceForIssue — replaces a stale final file and runs afterCreate", async () => {
  const root = await tempDir("ws-create");
  const stalePath = path.join(root, safeIdentifier(sampleIssue.identifier));
  await fs.writeFile(stalePath, "stale");
  const settings = makeSettings(root, { afterCreate: "touch .hook-ran" });

  const ws = await createWorkspaceForIssue(settings, sampleIssue, process.env);

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
    const ws = await createWorkspaceForIssue(settings, sampleIssue, process.env, {
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
  const first = await createWorkspaceForIssue(settings, sampleIssue, process.env);
  const second = await createWorkspaceForIssue(
    settings,
    { ...sampleIssue, identifier: "MT-2" },
    process.env,
  );
  assert.equal(first, canonicalRoot);
  assert.equal(second, canonicalRoot);
});

test("validateWorkspaceCwd — shared mode allows the root as cwd", async () => {
  const root = await tempDir("ws-shared");
  const settings = makeSettings(root, {}, { isolation: "none" });
  const result = await validateWorkspaceCwd(settings, root, process.env);
  assert.equal(result, await fs.realpath(root));
});

test("removeIssueWorkspaces — shared mode never deletes the root", async () => {
  const root = await tempDir("ws-shared");
  const settings = makeSettings(root, {}, { isolation: "none" });
  await createWorkspaceForIssue(settings, sampleIssue, process.env);
  await removeIssueWorkspaces(settings, sampleIssue.identifier, process.env);
  const stat = await fs.stat(root);
  assert.ok(stat.isDirectory());
});

test("createWorkspaceForIssue — shared mode never runs the afterCreate hook", async () => {
  const root = await tempDir("ws-shared");
  // Hooks can never reach this path through parseConfig (it rejects them); construct directly to
  // prove the shared code path itself runs no hooks, independent of config validation.
  const settings = makeSettings(root, { afterCreate: "touch .hook-ran" }, { isolation: "none" });
  const ws = await createWorkspaceForIssue(settings, sampleIssue, process.env);
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
  await createWorkspaceForIssue(settings, sampleIssue, process.env);
  await removeIssueWorkspaces(settings, sampleIssue.identifier, process.env);
  await assert.rejects(
    () => fs.stat(marker),
    (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
  );
});

// --- removeWorkspace ---

test("removeWorkspace — removes existing workspace directory", async () => {
  const root = await tempDir("ws-remove");
  const settings = makeSettings(root);
  const ws = await createWorkspaceForIssue(settings, sampleIssue, process.env);
  const removed = await removeWorkspace(settings, ws, process.env);
  assert.deepEqual(removed, [ws]);
  await assert.rejects(
    () => fs.stat(ws),
    (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("removeWorkspace — refuses to remove workspace root", async () => {
  const root = await tempDir("ws-remove");
  const settings = makeSettings(root);
  await assert.rejects(
    () => removeWorkspace(settings, root, process.env),
    /refusing to remove workspace root/,
  );
});

test("removeWorkspace — runs beforeRemove hook before deletion", async () => {
  const root = await tempDir("ws-remove");
  const markerFile = path.join(root, "hook-marker");
  const events: HookExecutionMessage[] = [];
  const settings = makeSettings(root, {
    beforeRemove: `touch ${JSON.stringify(markerFile)}`,
  });
  const ws = await createWorkspaceForIssue(settings, sampleIssue, process.env);
  await removeWorkspace(settings, ws, process.env, undefined, {
    onHookEvent: (event) => events.push(event),
  });
  const stat = await fs.stat(markerFile);
  assert.ok(stat.isFile());
  assert.deepEqual(
    events.map((event) => event.status),
    ["started", "completed"],
  );
  assert.equal(events[0]!.hookName, "before_remove");
  assert.equal(events[1]!.exitCode, 0);
});

test("removeIssueWorkspaces — passes issue context to beforeRemove hook", async () => {
  const root = await tempDir("ws-remove-issue-context");
  const markerFile = path.join(root, "issue-marker");
  const settings = makeSettings(root, {
    beforeRemove: `printf '%s' {{ issue.identifier }} > ${JSON.stringify(markerFile)}`,
  });
  await createWorkspaceForIssue(settings, sampleIssue, process.env);

  await removeIssueWorkspaces(settings, sampleIssue.identifier, process.env, null, sampleIssue);

  const content = await fs.readFile(markerFile, "utf8");
  assert.equal(content, sampleIssue.identifier);
});

test("removeWorkspace — nonexistent workspace returns empty array", async () => {
  const root = await tempDir("ws-remove");
  const settings = makeSettings(root);
  const result = await removeWorkspace(settings, path.join(root, "does-not-exist"), process.env);
  assert.deepEqual(result, []);
});

test("listIssueWorkspaceIdentifiers returns existing workspace directory names", async () => {
  const root = await tempDir("ws-list");
  const settings = makeSettings(root);
  await createWorkspaceForIssue(settings, "MT-7", process.env);
  await createWorkspaceForIssue(settings, "MT-9", process.env);
  await fs.writeFile(path.join(root, "not-a-workspace.txt"), "ignore me\n");

  const names = await listIssueWorkspaceIdentifiers(settings, process.env);
  assert.deepEqual(names.sort(), ["MT-7", "MT-9"]);
});

test("listIssueWorkspaceIdentifiers is empty for missing roots and shared workspaces", async () => {
  const missing = makeSettings(path.join(await tempDir("ws-list-missing"), "nope"));
  assert.deepEqual(await listIssueWorkspaceIdentifiers(missing, process.env), []);

  const sharedRoot = await tempDir("ws-list-shared");
  const shared = makeSettings(sharedRoot, {}, { isolation: "none" });
  await fs.mkdir(path.join(sharedRoot, "MT-1"), { recursive: true });
  assert.deepEqual(await listIssueWorkspaceIdentifiers(shared, process.env), []);
});

async function installFakeSsh(root: string, trace: string, source: string): Promise<void> {
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  await writeExecutable(path.join(bin, "ssh"), source);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  await fs.writeFile(trace, "");
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
