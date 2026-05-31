import fs from "node:fs/promises";
import path from "node:path";

import { runSsh, shellEscape } from "@symphony/ssh";
import type { HooksSettings, Issue, Settings } from "@symphony/domain";
import { execa } from "execa";

const remoteWorkspaceMarker = "__SYMPHONY_WORKSPACE__";

export function safeIdentifier(identifier: unknown): string {
  if (typeof identifier !== "string") return "";
  return identifier.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function workspacePath(
  root: string,
  issueIdentifier: string,
  slotIndex = 0,
  ensembleSize = 1,
): string {
  const safe = safeIdentifier(issueIdentifier);
  if (!safe) throw new Error("empty identifier produces invalid workspace path");
  const issueRoot = path.join(root, safe);
  return ensembleSize > 1 ? path.join(issueRoot, String(slotIndex)) : issueRoot;
}

export async function createWorkspaceForIssue(
  settings: Settings,
  issue: Issue | string,
  options: { slotIndex?: number; ensembleSize?: number; workerHost?: string | null } = {},
): Promise<string> {
  if (options.workerHost)
    return createRemoteWorkspaceForIssue(settings, issue, options.workerHost, options);

  const identifier = typeof issue === "string" ? issue : issue.identifier;
  const slotIndex = options.slotIndex ?? 0;
  const ensembleSize = options.ensembleSize ?? 1;

  const rootPath = path.resolve(settings.workspace.root);
  await fs.mkdir(rootPath, { recursive: true });
  await rejectFinalSymlink(rootPath);
  const canonicalRoot = await fs.realpath(rootPath);
  const target = workspacePath(canonicalRoot, identifier, slotIndex, ensembleSize);
  const existed = await exists(target);
  await ensureDirectoryWithinRoot(canonicalRoot, target);
  const canonicalTarget = await validateWorkspaceCwd(settings, target);

  if (!existed && settings.hooks.afterCreate) {
    await runHook(settings.hooks.afterCreate, canonicalTarget, settings.hooks);
  }

  return canonicalTarget;
}

export async function removeWorkspace(settings: Settings, workspace: string): Promise<string[]> {
  if (!(await exists(settings.workspace.root))) return [];
  const candidate = path.resolve(workspace);
  const canonicalRoot = await fs.realpath(settings.workspace.root);

  if (candidate === canonicalRoot) {
    throw new Error(`refusing to remove workspace root: ${canonicalRoot}`);
  }

  if (!(await exists(candidate))) return [];
  if ((await fs.realpath(candidate)) === canonicalRoot) {
    throw new Error(`refusing to remove workspace root: ${canonicalRoot}`);
  }
  const canonicalTarget = await validateWorkspaceCwd(settings, candidate);

  if (settings.hooks.beforeRemove) {
    try {
      await runHook(settings.hooks.beforeRemove, canonicalTarget, settings.hooks);
    } catch {
      // before_remove is best effort; cleanup should continue.
    }
  }

  await fs.rm(candidate, { recursive: true, force: true });
  return [canonicalTarget];
}

export async function removeRemoteWorkspace(
  settings: Settings,
  workspace: string,
  workerHost: string,
): Promise<string[]> {
  const canonicalWorkspace = await validateWorkspaceCwd(settings, workspace, workerHost);

  if (settings.hooks.beforeRemove) {
    try {
      await runRemoteHook(
        workerHost,
        canonicalWorkspace,
        settings.hooks.beforeRemove,
        settings.hooks,
      );
    } catch {
      // before_remove is best effort; cleanup should continue.
    }
  }

  const result = await runSsh(workerHost, `rm -rf ${shellEscape(canonicalWorkspace)}`, {
    timeoutMs: settings.hooks.timeoutMs,
    stderrToStdout: true,
  });
  if (result.status !== 0)
    throw new Error(`workspace_remove_failed: ${workerHost} ${result.status} ${result.stdout}`);
  return [];
}

export async function removeIssueWorkspaces(
  settings: Settings,
  identifier: unknown,
  workerHost?: string | null,
): Promise<void> {
  if (typeof identifier !== "string") return;
  if (workerHost) {
    try {
      await removeRemoteIssueWorkspaces(settings, identifier, workerHost);
    } catch {
      // Issue-level cleanup is best effort.
    }
    return;
  }
  if (await exists(settings.workspace.root)) {
    try {
      const canonicalRoot = await fs.realpath(settings.workspace.root);
      await removeWorkspace(settings, path.join(canonicalRoot, safeIdentifier(identifier)));
    } catch {
      // Issue-level cleanup is best effort.
    }
  }
  for (const host of settings.worker.sshHosts) {
    try {
      await removeRemoteIssueWorkspaces(settings, identifier, host);
    } catch {
      // Continue cleaning other worker hosts.
    }
  }
}

export async function removeRemoteIssueWorkspaces(
  settings: Settings,
  identifier: unknown,
  workerHost: string,
): Promise<void> {
  if (typeof identifier !== "string") return;
  const root = await remoteWorkspaceRoot(settings, workerHost);
  await removeRemoteWorkspace(
    settings,
    path.posix.join(root, safeIdentifier(identifier)),
    workerHost,
  );
}

export async function runHook(
  command: string,
  cwd: string,
  hooks: HooksSettings,
  workerHost?: string | null,
): Promise<void> {
  if (workerHost) return runRemoteHook(workerHost, cwd, command, hooks);

  const result = await execa("bash", ["-lc", command], {
    cwd,
    timeout: hooks.timeoutMs,
    all: true,
    reject: false,
    stdin: "ignore",
  });
  if (result.timedOut) throw new Error(`hook timed out after ${hooks.timeoutMs}ms`);
  if (result.exitCode !== 0)
    throw new Error(`hook failed with status ${result.exitCode}: ${(result.all ?? "").trim()}`);
}

export function ensureInsideRoot(target: string, root: string): void {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`workspace outside root: ${target}`);
}

export async function validateWorkspaceCwd(
  settings: Settings,
  workspace: string,
  workerHost?: string | null,
): Promise<string> {
  if (workerHost) return validateRemoteWorkspaceCwd(settings, workspace, workerHost);
  if (invalidWorkspaceInput(workspace)) throw new Error("invalid_workspace_cwd: blank");
  const rootPath = path.resolve(settings.workspace.root);
  await rejectFinalSymlink(rootPath);
  const canonicalRoot = await fs.realpath(rootPath);
  const candidate = path.resolve(workspace);
  if (!(await exists(candidate))) throw new Error(`invalid_workspace_cwd: missing ${candidate}`);
  await rejectFinalSymlink(candidate);
  await rejectPathSymlinksWithinRoot(canonicalRoot, candidate);
  const canonicalTarget = await fs.realpath(candidate);
  if (canonicalTarget === canonicalRoot)
    throw new Error(`refusing to use workspace root as cwd: ${canonicalRoot}`);
  ensureInsideRoot(canonicalTarget, canonicalRoot);
  return canonicalTarget;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function rejectFinalSymlink(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) throw new Error(`unsafe symlink in workspace path: ${filePath}`);
}

async function ensureDirectoryWithinRoot(canonicalRoot: string, target: string): Promise<void> {
  ensureInsideRoot(target, canonicalRoot);
  const relative = path.relative(canonicalRoot, target);
  if (relative === "") return;
  let current = canonicalRoot;
  const segments = relative.split(path.sep).filter((segment) => segment !== "");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`unsafe symlink in workspace path: ${current}`);
    if (stat.isDirectory()) continue;
    if (index !== segments.length - 1)
      throw new Error(`workspace path segment is not a directory: ${current}`);
    throw new Error(`workspace path segment is not a directory: ${current}`);
  }
}

async function rejectPathSymlinksWithinRoot(
  canonicalRoot: string,
  candidate: string,
): Promise<void> {
  const relative = path.relative(canonicalRoot, candidate);
  if (relative === "") return;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    const canonicalTarget = await fs.realpath(candidate);
    ensureInsideRoot(canonicalTarget, canonicalRoot);
    return;
  }
  let current = canonicalRoot;
  for (const segment of relative.split(path.sep).filter((item) => item !== "")) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`unsafe symlink in workspace path: ${current}`);
  }
}

async function createRemoteWorkspaceForIssue(
  settings: Settings,
  issue: Issue | string,
  workerHost: string,
  options: { slotIndex?: number; ensembleSize?: number },
): Promise<string> {
  const identifier = typeof issue === "string" ? issue : issue.identifier;
  const root = await remoteWorkspaceRoot(settings, workerHost);
  const workspace = remoteWorkspacePath(
    root,
    identifier,
    options.slotIndex ?? 0,
    options.ensembleSize ?? 1,
  );

  const script = [
    "set -eu",
    `workspace=${shellEscape(workspace)}`,
    'if [ -d "$workspace" ]; then',
    "  created=0",
    'elif [ -e "$workspace" ]; then',
    '  rm -rf "$workspace"',
    '  mkdir -p "$workspace"',
    "  created=1",
    "else",
    '  mkdir -p "$workspace"',
    "  created=1",
    "fi",
    'cd "$workspace"',
    `printf '%s\\t%s\\t%s\\n' ${shellEscape(remoteWorkspaceMarker)} "$created" "$(pwd -P)"`,
  ].join("\n");
  const result = await runSsh(workerHost, script, {
    timeoutMs: settings.hooks.timeoutMs,
    stderrToStdout: true,
  });
  if (result.status !== 0)
    throw new Error(`workspace_prepare_failed: ${workerHost} ${result.status} ${result.stdout}`);
  const parsed = parseRemoteWorkspaceOutput(result.stdout);
  const canonicalWorkspace = await validateWorkspaceCwd(settings, parsed.workspace, workerHost);

  if (parsed.created && settings.hooks.afterCreate) {
    await runRemoteHook(workerHost, canonicalWorkspace, settings.hooks.afterCreate, settings.hooks);
  }

  return canonicalWorkspace;
}

async function validateRemoteWorkspaceCwd(
  settings: Settings,
  workspace: string,
  workerHost: string,
): Promise<string> {
  if (invalidWorkspaceInput(workspace)) throw new Error("invalid_workspace_cwd: blank");
  const root = await remoteWorkspaceRoot(settings, workerHost);
  ensureRemoteInsideRoot(workspace, root);
  if (normalizeRemotePath(workspace) === normalizeRemotePath(root)) {
    throw new Error(`refusing to use workspace root as cwd: ${root}`);
  }
  const script = [
    "set -eu",
    `root=${shellEscape(root)}`,
    `workspace=${shellEscape(workspace)}`,
    'root_real=$(cd "$root" && pwd -P)',
    'workspace_real=$(cd "$workspace" && pwd -P)',
    `printf '%s\\t%s\\t%s\\n' ${shellEscape(remoteWorkspaceMarker)} "$root_real" "$workspace_real"`,
  ].join("\n");
  const result = await runSsh(workerHost, script, {
    timeoutMs: settings.worker.sshTimeoutMs,
    stderrToStdout: true,
  });
  if (result.status !== 0)
    throw new Error(`invalid_workspace_cwd: ${workerHost} ${result.status} ${result.stdout}`);
  const parsed = parseRemoteWorkspaceValidationOutput(result.stdout);
  ensureRemoteInsideRoot(parsed.workspace, parsed.root);
  if (normalizeRemotePath(parsed.workspace) === normalizeRemotePath(parsed.root)) {
    throw new Error(`refusing to use workspace root as cwd: ${parsed.root}`);
  }
  return parsed.workspace;
}

async function runRemoteHook(
  workerHost: string,
  workspace: string,
  command: string,
  hooks: HooksSettings,
): Promise<void> {
  const result = await runSsh(workerHost, `cd ${shellEscape(workspace)} && ${command}`, {
    timeoutMs: hooks.timeoutMs,
    stderrToStdout: true,
  });
  if (result.status !== 0)
    throw new Error(`workspace hook failed with status ${result.status}: ${result.stdout.trim()}`);
}

async function remoteWorkspaceRoot(settings: Settings, workerHost: string): Promise<string> {
  const root = settings.workspace.rootExpression ?? settings.workspace.root;
  if (root === "~" || root.startsWith("~/")) {
    const result = await runSsh(workerHost, 'printf "%s\\n" "$HOME"', {
      timeoutMs: settings.worker.sshTimeoutMs,
      stderrToStdout: true,
    });
    if (result.status !== 0)
      throw new Error(`remote_home_lookup_failed: ${workerHost} ${result.status} ${result.stdout}`);
    const home = result.stdout.trim();
    if (!home) throw new Error(`remote_home_lookup_failed: ${workerHost} empty_home`);
    return root === "~" ? home : path.posix.join(home, root.slice(2));
  }
  return root;
}

function remoteWorkspacePath(
  root: string,
  identifier: string,
  slotIndex: number,
  ensembleSize: number,
): string {
  const issueRoot = path.posix.join(root, safeIdentifier(identifier));
  return ensembleSize > 1 ? path.posix.join(issueRoot, String(slotIndex)) : issueRoot;
}

function parseRemoteWorkspaceOutput(output: string): { created: boolean; workspace: string } {
  for (const line of output.split(/\r?\n/)) {
    const [marker, created, workspace] = line.split("\t");
    if (marker === remoteWorkspaceMarker && workspace) {
      return { created: created === "1", workspace };
    }
  }
  throw new Error(`workspace_prepare_failed: missing remote workspace marker`);
}

function parseRemoteWorkspaceValidationOutput(output: string): { root: string; workspace: string } {
  for (const line of output.split(/\r?\n/)) {
    const [marker, root, workspace] = line.split("\t");
    if (marker === remoteWorkspaceMarker && root && workspace) return { root, workspace };
  }
  throw new Error("invalid_workspace_cwd: missing remote workspace marker");
}

function ensureRemoteInsideRoot(target: string, root: string): void {
  const normalizedRoot = normalizeRemotePath(root);
  const normalizedTarget = normalizeRemotePath(target);
  if (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`))
    return;
  throw new Error(`workspace outside root: ${target}`);
}

function normalizeRemotePath(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized.endsWith("/") && normalized !== "/" ? normalized.slice(0, -1) : normalized;
}

function invalidWorkspaceInput(value: string): boolean {
  return !value.trim() || /[\n\r\0]/.test(value);
}
