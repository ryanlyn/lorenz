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

function sharedWorkspaceRoot(settings: Settings): boolean {
  return settings.workspace.isolation === "none";
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

  // Shared workspaces run no lifecycle hooks (config rejects them); canonicalRoot is already
  // realpath'd and symlink-checked above, so creation is done.
  if (sharedWorkspaceRoot(settings)) return canonicalRoot;

  const target = workspacePath(canonicalRoot, identifier, slotIndex, ensembleSize);
  const created = await ensureDirectoryWithinRoot(canonicalRoot, target);
  const canonicalTarget = await validateWorkspaceCwd(settings, target);

  if (created && settings.hooks.afterCreate) {
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
  // The shared workspace is the root itself and is never owned by a single issue, so it must
  // outlive any individual run; auto-cleanup would wipe other agents' work.
  if (sharedWorkspaceRoot(settings)) return;
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
  let canonicalTarget;
  try {
    canonicalTarget = await fs.realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`invalid_workspace_cwd: missing ${candidate}`, { cause: error });
    throw error;
  }
  if (canonicalTarget === canonicalRoot && !sharedWorkspaceRoot(settings))
    throw new Error(`refusing to use workspace root as cwd: ${canonicalRoot}`);
  const candidateInsideRoot =
    insideRoot(candidate, rootPath) || insideRoot(candidate, canonicalRoot);
  if (!insideRoot(canonicalTarget, canonicalRoot) && candidateInsideRoot) {
    throw new Error(`unsafe symlink in workspace path: ${candidate}`);
  }
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

async function ensureDirectoryWithinRoot(canonicalRoot: string, target: string): Promise<boolean> {
  ensureInsideRoot(target, canonicalRoot);
  const relative = path.relative(canonicalRoot, target);
  if (relative === "") return false;
  let current = canonicalRoot;
  let created = false;
  const segments = relative.split(path.sep).filter((segment) => segment !== "");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    while (true) {
      try {
        await fs.mkdir(current);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }

      if (stat.isSymbolicLink()) throw new Error(`unsafe symlink in workspace path: ${current}`);
      if (stat.isDirectory()) break;
      if (index !== segments.length - 1)
        throw new Error(`workspace path segment is not a directory: ${current}`);
      await fs.rm(current, { recursive: true, force: true });
      created = true;
    }
  }
  return created;
}

async function createRemoteWorkspaceForIssue(
  settings: Settings,
  issue: Issue | string,
  workerHost: string,
  options: { slotIndex?: number; ensembleSize?: number },
): Promise<string> {
  const identifier = typeof issue === "string" ? issue : issue.identifier;
  const root = await remoteWorkspaceRoot(settings, workerHost);
  const workspace = sharedWorkspaceRoot(settings)
    ? root
    : remoteWorkspacePath(root, identifier, options.slotIndex ?? 0, options.ensembleSize ?? 1);

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
  const shared = sharedWorkspaceRoot(settings);
  const root = await remoteWorkspaceRoot(settings, workerHost);
  ensureRemoteInsideRoot(workspace, root);
  if (!shared && normalizeRemotePath(workspace) === normalizeRemotePath(root)) {
    throw new Error(`refusing to use workspace root as cwd: ${root}`);
  }
  const script = [
    "set -eu",
    `root=${shellEscape(root)}`,
    `workspace=${shellEscape(workspace)}`,
    "canonicalize_path() {",
    '  current="$1"',
    "  suffix=''",
    '  while [ ! -e "$current" ] && [ "$current" != "/" ]; do',
    "    segment=${current##*/}",
    '    suffix="/$segment$suffix"',
    "    current=${current%/*}",
    '    if [ -z "$current" ]; then current="/"; fi',
    "  done",
    '  if [ -d "$current" ]; then',
    '    resolved=$(cd "$current" && pwd -P)',
    "  else",
    "    parent=${current%/*}",
    '    if [ -z "$parent" ]; then parent="/"; fi',
    "    segment=${current##*/}",
    '    resolved_parent=$(cd "$parent" && pwd -P)',
    '    if [ "$resolved_parent" = "/" ]; then',
    '      resolved="/$segment"',
    "    else",
    '      resolved="$resolved_parent/$segment"',
    "    fi",
    "  fi",
    '  if [ "$resolved" = "/" ]; then',
    '    printf "/%s\\n" "${suffix#/}"',
    "  else",
    '    printf "%s\\n" "$resolved$suffix"',
    "  fi",
    "}",
    'root_real=$(canonicalize_path "$root")',
    'workspace_real=$(canonicalize_path "$workspace")',
    `printf '%s\\t%s\\t%s\\n' ${shellEscape(remoteWorkspaceMarker)} "$root_real" "$workspace_real"`,
  ].join("\n");
  const result = await runSsh(workerHost, script, {
    timeoutMs: settings.worker.sshTimeoutMs,
    stderrToStdout: true,
  });
  if (result.status !== 0)
    throw new Error(`invalid_workspace_cwd: ${workerHost} ${result.status} ${result.stdout}`);
  const parsed = parseRemoteWorkspaceValidationOutput(result.stdout);
  if (!remotePathInsideRoot(parsed.workspace, parsed.root)) {
    throw new Error(
      `invalid_workspace_cwd: symlink_escape ${workspace} -> ${parsed.workspace} outside ${parsed.root}`,
    );
  }
  if (!shared && normalizeRemotePath(parsed.workspace) === normalizeRemotePath(parsed.root)) {
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
  if (remotePathInsideRoot(target, root)) return;
  throw new Error(`workspace outside root: ${target}`);
}

function remotePathInsideRoot(target: string, root: string): boolean {
  const normalizedRoot = normalizeRemotePath(root);
  const normalizedTarget = normalizeRemotePath(target);
  if (normalizedRoot === "/") return normalizedTarget.startsWith("/");
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function normalizeRemotePath(value: string): string {
  const normalized = path.posix.normalize(value);
  return normalized.endsWith("/") && normalized !== "/" ? normalized.slice(0, -1) : normalized;
}

function insideRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function invalidWorkspaceInput(value: string): boolean {
  return !value.trim() || /[\n\r\0]/.test(value);
}
