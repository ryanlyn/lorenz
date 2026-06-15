import fs from "node:fs/promises";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream } from "node:fs";
import os from "node:os";
import { pipeline } from "node:stream/promises";

import { Liquid } from "liquidjs";
import { runSsh, shellEscape, startSshProcess } from "@lorenz/ssh";
import {
  errorMessage,
  type HookExecutionMessage,
  type HooksSettings,
  type Issue,
  type Settings,
} from "@lorenz/domain";
import { execa } from "execa";

const remoteWorkspaceMarker = "__LORENZ_WORKSPACE__";
const hookForceKillDelayMs = 5_000;
const hookLogMaxChars = 4_096;

const hookTemplateReferencePattern = /(?:\{\{|\{%)[\s\S]*\bissue(?:\.|\[)/;

const liquidEngine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  outputEscape: shellEscapeOutput,
});
liquidEngine.registerFilter("shell_escape", {
  raw: true,
  handler: shellEscapeOutput,
});

function shellEscapeOutput(v: unknown): string {
  if (v == null) return "''";
  if (Array.isArray(v)) return shellEscape(v.join(","));
  if (typeof v === "string") return shellEscape(v);
  return shellEscape(JSON.stringify(v));
}

export interface HookTemplateContext {
  issue?: Issue | undefined;
}

async function renderHookCommand(command: string, context: HookTemplateContext): Promise<string> {
  if (!context.issue) return command;
  if (!hookTemplateReferencePattern.test(command)) return command;
  const issue = context.issue;
  return liquidEngine.parseAndRender(command, {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? null,
      priority: issue.priority ?? null,
      state: issue.state,
      state_type: issue.stateType ?? null,
      branch_name: issue.branchName ?? null,
      url: issue.url ?? null,
      assignee_id: issue.assigneeId ?? null,
      blocked_by: issue.blockers.map(issueRefHookContext),
      labels: issue.labels,
      assigned_to_worker: issue.assignedToWorker ?? true,
      created_at: issue.createdAt ?? null,
      updated_at: issue.updatedAt ?? null,
    },
  }) as Promise<string>;
}

function issueRefHookContext(issue: Issue["blockers"][number]): Record<string, unknown> {
  return {
    id: issue.id ?? null,
    identifier: issue.identifier ?? null,
    state: issue.state ?? null,
    state_type: issue.stateType ?? null,
  };
}

export interface WorkspaceCreateOptions {
  slotIndex?: number | undefined;
  ensembleSize?: number | undefined;
  workerHost?: string | null | undefined;
  forceSlotSuffix?: boolean | undefined;
  abortSignal?: AbortSignal | undefined;
  onHookEvent?: ((event: HookExecutionMessage) => void) | undefined;
  /**
   * Skill directories to overlay into the prepared workspace, with the executor-chosen
   * destination. Assembled by the composition root (configured `agent.skills` unioned with
   * mounted tool packs' bundled skills); omitted means no overlay runs.
   */
  skillOverlay?: WorkspaceSkillOverlay | undefined;
}

/** Resolved skill overlay: absolute source directories and the workspace-relative destination. */
export interface WorkspaceSkillOverlay {
  /** Absolute skill directories; each is copied whole to `<destDir>/<basename>`. */
  sources: string[];
  /** Workspace-relative destination, e.g. `.codex/skills` or `.claude/skills`. */
  destDir: string;
}

export interface WorkspaceRunHookOptions {
  abortSignal?: AbortSignal | undefined;
  validateCwd?: (() => Promise<string>) | undefined;
  hookName?: HookExecutionMessage["hookName"] | undefined;
  onHookEvent?: ((event: HookExecutionMessage) => void) | undefined;
}

export interface WorkspaceHookEventOptions {
  onHookEvent?: ((event: HookExecutionMessage) => void) | undefined;
}

interface WorkspaceSkillSourcePlan {
  /** Absolute source directory. */
  source: string;
  /** Skill directory name placed under the destination (the source basename). */
  target: string;
  /** Directory to run `tar` from for the remote transfer (the source's parent). */
  archiveCwd: string;
  /** Entry archived and extracted into the destination (equals {@link target}). */
  archiveEntry: string;
}

export function safeIdentifier(identifier: unknown): string {
  if (typeof identifier !== "string") return "";
  return identifier.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function sharedWorkspaceRoot(settings: Settings): boolean {
  return settings.workspace.isolation === "none";
}

/**
 * The local workspace directory for an issue's run.
 *
 * By default (`forceSlotSuffix = false`) the slot index is appended ONLY for an
 * ensemble (`ensembleSize > 1`); a solo run returns the bare `<root>/<identifier>`.
 *
 * `forceSlotSuffix` is the gated co-residence override: when two run slots of the
 * SAME issue may co-reside on one machine (`slotsPerMachine > 1` with the
 * co-residence opt-in), each is its own solo (`ensembleSize = 1`) run yet must NOT
 * share the bare path, so the slot suffix is applied UNCONDITIONALLY. It is set
 * only on the gated co-residence path and NEVER alters the default single-slot
 * layout (which depends on the bare path).
 */
export function workspacePath(
  root: string,
  issueIdentifier: string,
  slotIndex = 0,
  ensembleSize = 1,
  forceSlotSuffix = false,
): string {
  const safe = safeIdentifier(issueIdentifier);
  if (!safe) throw new Error("empty identifier produces invalid workspace path");
  const issueRoot = path.join(root, safe);
  return ensembleSize > 1 || forceSlotSuffix ? path.join(issueRoot, String(slotIndex)) : issueRoot;
}

export async function createWorkspaceForIssue(
  settings: Settings,
  issue: Issue | string,
  options: WorkspaceCreateOptions = {},
): Promise<string> {
  if (options.workerHost)
    return createRemoteWorkspaceForIssue(settings, issue, options.workerHost, options);

  const identifier = typeof issue === "string" ? issue : issue.identifier;
  const slotIndex = options.slotIndex ?? 0;
  const ensembleSize = options.ensembleSize ?? 1;
  const forceSlotSuffix = options.forceSlotSuffix ?? false;

  const rootPath = path.resolve(settings.workspace.root);
  await fs.mkdir(rootPath, { recursive: true });
  await rejectFinalSymlink(rootPath);
  const canonicalRoot = await fs.realpath(rootPath);

  // Shared workspaces run no lifecycle hooks (config rejects them); canonicalRoot is already
  // realpath'd and symlink-checked above, so creation is done.
  if (sharedWorkspaceRoot(settings)) {
    await applyWorkspaceSkillOverlay(settings, canonicalRoot, null, options);
    return canonicalRoot;
  }

  const target = workspacePath(canonicalRoot, identifier, slotIndex, ensembleSize, forceSlotSuffix);
  const created = await ensureDirectoryWithinRoot(canonicalRoot, target);
  const canonicalTarget = await validateWorkspaceCwd(settings, target);

  if (created && settings.hooks.afterCreate) {
    await runHook(
      settings.hooks.afterCreate,
      canonicalTarget,
      settings.hooks,
      null,
      {
        abortSignal: options.abortSignal,
        hookName: "after_create",
        onHookEvent: options.onHookEvent,
        validateCwd: async () => validateWorkspaceCwd(settings, canonicalTarget),
      },
      typeof issue === "string" ? undefined : issue,
    );
  }

  await applyWorkspaceSkillOverlay(settings, canonicalTarget, null, options);

  return canonicalTarget;
}

/** Run the configured skill overlay for a prepared workspace, sourcing the SSH timeout from settings. */
async function applyWorkspaceSkillOverlay(
  settings: Settings,
  workspace: string,
  workerHost: string | null,
  options: WorkspaceCreateOptions,
): Promise<void> {
  if (!options.skillOverlay) return;
  await syncWorkspaceSkills(workspace, options.skillOverlay, workerHost, {
    abortSignal: options.abortSignal,
    timeoutMs: settings.worker.sshTimeoutMs,
  });
}

export async function syncWorkspaceSkills(
  workspace: string,
  overlay: WorkspaceSkillOverlay,
  workerHost?: string | null,
  options: { abortSignal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
): Promise<void> {
  if (overlay.sources.length === 0) return;
  if (options.abortSignal?.aborted) throw new Error("workspace_skill_sync_canceled");
  const plans = await workspaceSkillSourcePlans(overlay.sources);
  const destSegments = skillDestinationSegments(overlay.destDir);
  if (workerHost) {
    await syncRemoteWorkspaceSkills(workerHost, workspace, plans, destSegments, {
      abortSignal: options.abortSignal,
      timeoutMs: options.timeoutMs,
    });
    return;
  }
  await syncLocalWorkspaceSkills(workspace, plans, destSegments);
}

/** Split an executor-provided destination (e.g. `.codex/skills`) into safe path segments. */
function skillDestinationSegments(destDir: string): string[] {
  const segments = destDir.split(/[\\/]+/).filter((segment) => segment !== "");
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === ".."))
    throw new Error(`workspace_skill_destination_invalid: ${destDir}`);
  return segments;
}

export async function removeWorkspace(
  settings: Settings,
  workspace: string,
  issue?: Issue,
  options: WorkspaceHookEventOptions = {},
): Promise<string[]> {
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
      await runHook(
        settings.hooks.beforeRemove,
        canonicalTarget,
        settings.hooks,
        null,
        {
          hookName: "before_remove",
          onHookEvent: options.onHookEvent,
          validateCwd: async () => validateWorkspaceCwd(settings, canonicalTarget),
        },
        issue,
      );
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
  issue?: Issue,
  options: WorkspaceHookEventOptions = {},
): Promise<string[]> {
  const canonicalWorkspace = await validateWorkspaceCwd(settings, workspace, workerHost);

  if (settings.hooks.beforeRemove) {
    try {
      await runRemoteHook(
        workerHost,
        canonicalWorkspace,
        settings.hooks.beforeRemove,
        settings.hooks,
        { hookName: "before_remove", onHookEvent: options.onHookEvent },
        { issue },
      );
    } catch {
      // before_remove is best-effort; cleanup should continue.
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
  issue?: Issue,
  options: WorkspaceHookEventOptions = {},
): Promise<void> {
  const resolvedIdentifier = typeof identifier === "string" ? identifier : issue?.identifier;
  if (typeof resolvedIdentifier !== "string") return;
  // The shared workspace is the root itself and is never owned by a single issue, so it must
  // outlive any individual run; auto-cleanup would wipe other agents' work.
  if (sharedWorkspaceRoot(settings)) return;
  if (workerHost) {
    try {
      await removeRemoteIssueWorkspaces(settings, resolvedIdentifier, workerHost, issue, options);
    } catch {
      // Issue-level cleanup is best effort.
    }
    return;
  }
  if (await exists(settings.workspace.root)) {
    try {
      const canonicalRoot = await fs.realpath(settings.workspace.root);
      await removeWorkspace(
        settings,
        path.join(canonicalRoot, safeIdentifier(resolvedIdentifier)),
        issue,
        options,
      );
    } catch {
      // Issue-level cleanup is best effort.
    }
  }
  for (const host of settings.worker.sshHosts) {
    try {
      await removeRemoteIssueWorkspaces(settings, resolvedIdentifier, host, issue, options);
    } catch {
      // Continue cleaning other worker hosts.
    }
  }
}

export async function removeRemoteIssueWorkspaces(
  settings: Settings,
  identifier: unknown,
  workerHost: string,
  issue?: Issue,
  options: WorkspaceHookEventOptions = {},
): Promise<void> {
  if (typeof identifier !== "string") return;
  const root = await remoteWorkspaceRoot(settings, workerHost);
  await removeRemoteWorkspace(
    settings,
    path.posix.join(root, safeIdentifier(identifier)),
    workerHost,
    issue,
    options,
  );
}

/**
 * Names of per-issue workspace directories that currently exist under the workspace root,
 * locally and on every configured SSH worker. Directories are created as
 * `safeIdentifier(issue.identifier)`, so the returned names are the (sanitized) issue
 * identifiers that may still own a workspace. Hosts that cannot be listed are skipped:
 * the result feeds best-effort cleanup, never correctness.
 */
export async function listIssueWorkspaceIdentifiers(settings: Settings): Promise<string[]> {
  if (sharedWorkspaceRoot(settings)) return [];
  const names = new Set<string>();

  if (await exists(settings.workspace.root)) {
    try {
      const canonicalRoot = await fs.realpath(settings.workspace.root);
      for (const entry of await fs.readdir(canonicalRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    } catch {
      // Local listing is best effort.
    }
  }

  for (const host of settings.worker.sshHosts) {
    try {
      const root = await remoteWorkspaceRoot(settings, host);
      const result = await runSsh(
        host,
        `[ -d ${shellEscape(root)} ] && find ${shellEscape(root)} -mindepth 1 -maxdepth 1 -type d -exec basename {} \\; || true`,
        { timeoutMs: settings.worker.sshTimeoutMs, stderrToStdout: false },
      );
      if (result.status !== 0) continue;
      for (const line of result.stdout.split("\n")) {
        const name = line.trim();
        if (name) names.add(name);
      }
    } catch {
      // Continue listing other worker hosts.
    }
  }

  return [...names];
}

export async function runHook(
  command: string,
  cwd: string,
  hooks: HooksSettings,
  workerHost?: string | null,
  options: WorkspaceRunHookOptions = {},
  issue?: Issue,
): Promise<void> {
  const templateContext: HookTemplateContext = { issue };
  if (workerHost) return runRemoteHook(workerHost, cwd, command, hooks, options, templateContext);
  if (options.abortSignal?.aborted) throw new Error("hook canceled");
  const hookCwd = options.validateCwd ? await options.validateCwd() : cwd;
  if (options.abortSignal?.aborted) throw new Error("hook canceled");

  let rendered: string;
  try {
    rendered = await renderHookCommand(command, templateContext);
  } catch (error) {
    const logError = truncateHookLogText(errorMessage(error));
    emitHookEvent(options, {
      status: "failed",
      command,
      cwd: hookCwd,
      hookName: options.hookName,
      exitCode: null,
      error: logError.text,
      errorTruncated: logError.truncated,
    });
    throw error;
  }
  emitHookEvent(options, {
    status: "started",
    command: rendered,
    cwd: hookCwd,
    hookName: options.hookName,
  });
  const subprocess = execa("bash", ["-lc", rendered], {
    cwd: hookCwd,
    all: true,
    reject: false,
    stdin: "ignore",
    detached: true,
  });
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let terminationRequested = false;
  let abortHandler: (() => void) | undefined;

  const killProcessGroup = (signal: NodeJS.Signals): void => {
    if (subprocess.pid === undefined) return;
    try {
      process.kill(-subprocess.pid, signal);
    } catch {
      /* process already exited */
    }
  };

  const forceKillProcessGroup = (): void => {
    forceKillTimer ??= setTimeout(() => {
      killProcessGroup("SIGKILL");
    }, hookForceKillDelayMs);
  };

  const clearForceKillTimer = (): void => {
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  };

  const clearTimers = (): void => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (!terminationRequested) clearForceKillTimer();
    if (abortHandler) options.abortSignal?.removeEventListener("abort", abortHandler);
  };

  const terminate = (error: Error, reject: (reason: Error) => void): void => {
    terminationRequested = true;
    killProcessGroup("SIGTERM");
    forceKillProcessGroup();
    reject(error);
  };

  const races: Array<Promise<unknown>> = [subprocess];
  if (Number.isFinite(hooks.timeoutMs) && hooks.timeoutMs > 0) {
    races.push(
      new Promise<never>((_resolve, reject) => {
        timeoutTimer = setTimeout(() => {
          terminate(new Error(`hook timed out after ${hooks.timeoutMs}ms`), reject);
        }, hooks.timeoutMs);
      }),
    );
  }
  if (options.abortSignal) {
    races.push(
      new Promise<never>((_resolve, reject) => {
        abortHandler = () => terminate(new Error("hook canceled"), reject);
        options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
      }),
    );
  }

  void subprocess.then(clearForceKillTimer, clearForceKillTimer);

  let result: Awaited<typeof subprocess>;
  try {
    result = (await Promise.race(races).finally(clearTimers)) as Awaited<typeof subprocess>;
  } catch (error) {
    const logError = truncateHookLogText(errorMessage(error));
    emitHookEvent(options, {
      status: "failed",
      command: rendered,
      cwd: hookCwd,
      hookName: options.hookName,
      exitCode: null,
      error: logError.text,
      errorTruncated: logError.truncated,
    });
    throw error;
  }

  const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
  const output = truncateHookLogText(result.all ?? "");
  if (result.exitCode !== 0) {
    const errorOutput = truncateHookLogText((result.all ?? "").trim());
    const error = new Error(`hook failed with status ${exitCode}: ${errorOutput.text}`);
    emitHookEvent(options, {
      status: "failed",
      command: rendered,
      cwd: hookCwd,
      hookName: options.hookName,
      exitCode,
      output: output.text,
      outputTruncated: output.truncated,
      error: error.message,
      errorTruncated: errorOutput.truncated,
    });
    throw error;
  }
  emitHookEvent(options, {
    status: "completed",
    command: rendered,
    cwd: hookCwd,
    hookName: options.hookName,
    exitCode,
    output: output.text,
    outputTruncated: output.truncated,
  });
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

async function workspaceSkillSourcePlans(sources: string[]): Promise<WorkspaceSkillSourcePlan[]> {
  const plans: WorkspaceSkillSourcePlan[] = [];
  for (const source of sources) {
    let stat;
    try {
      stat = await fs.lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`workspace_skill_source_missing: ${source}`, { cause: error });
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`workspace_skill_source_symlink: ${source}`);
    }
    // A skill is a directory; its whole tree ships into `<destDir>/<basename>`.
    if (!stat.isDirectory()) {
      throw new Error(`workspace_skill_source_unsupported: ${source}`);
    }

    const normalized = path.resolve(source);
    await rejectSourceTreeSymlinks(normalized);
    const target = path.basename(normalized);
    if (target === "" || target === "." || target === "..")
      throw new Error(`workspace_skill_source_invalid: ${source}`);
    plans.push({
      source: normalized,
      target,
      archiveCwd: path.dirname(normalized),
      archiveEntry: target,
    });
  }
  return plans;
}

async function rejectSourceTreeSymlinks(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`workspace_skill_source_symlink: ${entryPath}`);
    if (entry.isDirectory()) await rejectSourceTreeSymlinks(entryPath);
  }
}

async function syncLocalWorkspaceSkills(
  workspace: string,
  plans: WorkspaceSkillSourcePlan[],
  destSegments: string[],
): Promise<void> {
  const skillsRoot = path.join(workspace, ...destSegments);
  await ensureDirectoryPathWithoutSymlinks(workspace, skillsRoot);
  for (const plan of plans) {
    const target = path.join(skillsRoot, plan.target);
    await rejectExistingSymlink(target);
    if (await sameRealPath(plan.source, target)) continue;
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(plan.source, target, {
      dereference: true,
      force: true,
      recursive: true,
    });
  }
}

async function syncRemoteWorkspaceSkills(
  workerHost: string,
  workspace: string,
  plans: WorkspaceSkillSourcePlan[],
  destSegments: string[],
  options: { abortSignal?: AbortSignal | undefined; timeoutMs?: number | undefined },
): Promise<void> {
  const skillsRoot = path.posix.join(workspace, ...destSegments);
  for (const plan of plans) {
    await syncRemoteWorkspaceSkill(workerHost, skillsRoot, plan, options);
  }
}

async function syncRemoteWorkspaceSkill(
  workerHost: string,
  skillsRoot: string,
  plan: WorkspaceSkillSourcePlan,
  options: { abortSignal?: AbortSignal | undefined; timeoutMs?: number | undefined },
): Promise<void> {
  if (options.abortSignal?.aborted) throw new Error("workspace_skill_sync_canceled");
  if (
    options.timeoutMs === undefined ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs <= 0
  )
    throw new Error(`invalid_ssh_timeout: ${options.timeoutMs}`);
  const timeoutMs = options.timeoutMs;
  const skillsParent = path.posix.dirname(skillsRoot);
  const targetGuard = `
target=${shellEscape(path.posix.join(skillsRoot, plan.target))}
if [ -L "$target" ]; then
  printf '%s\\n' "unsafe symlink in workspace path: $target" >&2
  exit 1
fi
rm -rf "$target"`;
  const command = [
    "set -eu",
    `skills_parent=${shellEscape(skillsParent)}`,
    `skills_root=${shellEscape(skillsRoot)}`,
    'if [ -L "$skills_parent" ] || [ -L "$skills_root" ]; then',
    "  printf '%s\\n' \"unsafe symlink in workspace path: $skills_root\" >&2",
    "  exit 1",
    "fi",
    'mkdir -p "$skills_parent"',
    'if [ -L "$skills_parent" ] || [ ! -d "$skills_parent" ]; then',
    "  printf '%s\\n' \"unsafe workspace skill path: $skills_parent\" >&2",
    "  exit 1",
    "fi",
    'mkdir -p "$skills_root"',
    'if [ -L "$skills_root" ] || [ ! -d "$skills_root" ]; then',
    "  printf '%s\\n' \"unsafe workspace skill path: $skills_root\" >&2",
    "  exit 1",
    "fi",
    targetGuard,
    `tar -C ${shellEscape(skillsRoot)} -xf -`,
  ]
    .filter(Boolean)
    .join("\n");
  const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "lorenz-skill-archive-"));
  const archivePath = path.join(archiveDir, "skill.tar");

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let terminationRequested = false;
  let abortHandler: (() => void) | undefined;

  const clearTimers = (): void => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (!terminationRequested && forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    if (abortHandler) options.abortSignal?.removeEventListener("abort", abortHandler);
  };

  try {
    const archiveResult = await execa(
      "tar",
      ["-C", plan.archiveCwd, "-cf", archivePath, "--", plan.archiveEntry],
      {
        ...(options.abortSignal ? { cancelSignal: options.abortSignal } : {}),
        reject: false,
        stdin: "ignore",
      },
    );
    if (options.abortSignal?.aborted) throw new Error("workspace_skill_sync_canceled");
    if (archiveResult.exitCode !== 0) {
      throw new Error(
        `workspace_skill_archive_failed: ${plan.source} ${archiveResult.exitCode} ${archiveResult.stderr}`.trim(),
      );
    }

    const remote = startSshProcess(workerHost, command);
    const remoteStdout = collectStreamText(remote.stdout);
    const remoteStderr = collectStreamText(remote.stderr);
    const remoteExit = waitForProcessExit(remote);
    const forceKill = (): void => {
      forceKillTimer ??= setTimeout(() => {
        remote.kill("SIGKILL");
      }, hookForceKillDelayMs);
    };
    const terminate = (error: Error, reject: (reason: Error) => void): void => {
      terminationRequested = true;
      remote.kill("SIGTERM");
      forceKill();
      reject(error);
    };
    const pipeResult = pipeline(createReadStream(archivePath), remote.stdin).then(
      () => null,
      (error: unknown) => error,
    );
    const syncResult = Promise.all([remoteExit, remoteStdout, remoteStderr, pipeResult]);
    void syncResult.then(
      () => {
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      },
      () => {
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      },
    );

    const races: Array<Promise<unknown>> = [syncResult];
    races.push(
      new Promise<never>((_resolve, reject) => {
        timeoutTimer = setTimeout(() => {
          terminate(
            new Error(`workspace_skill_remote_sync_timeout: ${workerHost} ${timeoutMs}`),
            reject,
          );
        }, timeoutMs);
      }),
    );
    if (options.abortSignal) {
      races.push(
        new Promise<never>((_resolve, reject) => {
          abortHandler = () => terminate(new Error("workspace_skill_sync_canceled"), reject);
          options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
        }),
      );
    }

    const [remoteResult, remoteOutput, remoteError, pipeError] = (await Promise.race(races).finally(
      clearTimers,
    )) as Awaited<typeof syncResult>;
    if (options.abortSignal?.aborted) throw new Error("workspace_skill_sync_canceled");
    if (remoteResult.exitCode !== 0) {
      const output = `${remoteOutput}${remoteOutput && remoteError ? "\n" : ""}${remoteError}`;
      throw new Error(
        `workspace_skill_remote_sync_failed: ${workerHost} ${remoteResult.exitCode} ${output}`.trim(),
      );
    }
    if (pipeError) {
      throw new Error(
        `workspace_skill_remote_sync_failed: ${workerHost} ${errorMessage(pipeError)}`,
      );
    }
  } finally {
    clearTimers();
    await fs.rm(archiveDir, { recursive: true, force: true });
  }
}

async function ensureDirectoryPathWithoutSymlinks(root: string, target: string): Promise<void> {
  ensureInsideRoot(target, root);
  const relative = path.relative(root, target);
  let current = root;
  const segments = relative.split(path.sep).filter((segment) => segment !== "");
  for (const segment of segments) {
    current = path.join(current, segment);
    while (true) {
      try {
        await fs.mkdir(current);
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
      if (!stat.isDirectory())
        throw new Error(`workspace path segment is not a directory: ${current}`);
      break;
    }
  }
}

async function rejectExistingSymlink(filePath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`unsafe symlink in workspace path: ${filePath}`);
}

async function sameRealPath(left: string, right: string): Promise<boolean> {
  try {
    const [leftReal, rightReal] = await Promise.all([fs.realpath(left), fs.realpath(right)]);
    return leftReal === rightReal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function collectStreamText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    output += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return output.trim();
}

async function waitForProcessExit(
  subprocess: ChildProcessWithoutNullStreams,
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve) => {
    subprocess.on("close", (exitCode) => resolve({ exitCode }));
  });
}

async function createRemoteWorkspaceForIssue(
  settings: Settings,
  issue: Issue | string,
  workerHost: string,
  options: WorkspaceCreateOptions,
): Promise<string> {
  const identifier = typeof issue === "string" ? issue : issue.identifier;
  const root = await remoteWorkspaceRoot(settings, workerHost, options);
  const workspace = sharedWorkspaceRoot(settings)
    ? root
    : remoteWorkspacePath(
        root,
        identifier,
        options.slotIndex ?? 0,
        options.ensembleSize ?? 1,
        options.forceSlotSuffix ?? false,
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
    abortSignal: options.abortSignal,
  });
  if (result.status !== 0)
    throw new Error(`workspace_prepare_failed: ${workerHost} ${result.status} ${result.stdout}`);
  const parsed = parseRemoteWorkspaceOutput(result.stdout);
  const canonicalWorkspace = await validateRemoteWorkspaceCwd(
    settings,
    parsed.workspace,
    workerHost,
    options,
  );

  if (parsed.created && settings.hooks.afterCreate) {
    await runRemoteHook(
      workerHost,
      canonicalWorkspace,
      settings.hooks.afterCreate,
      settings.hooks,
      { ...options, hookName: "after_create" },
      { issue: typeof issue === "string" ? undefined : issue },
    );
  }

  await applyWorkspaceSkillOverlay(settings, canonicalWorkspace, workerHost, options);

  return canonicalWorkspace;
}

async function validateRemoteWorkspaceCwd(
  settings: Settings,
  workspace: string,
  workerHost: string,
  options: WorkspaceRunHookOptions = {},
): Promise<string> {
  if (invalidWorkspaceInput(workspace)) throw new Error("invalid_workspace_cwd: blank");
  const shared = sharedWorkspaceRoot(settings);
  const root = await remoteWorkspaceRoot(settings, workerHost, options);
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
    abortSignal: options.abortSignal,
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
  options: WorkspaceRunHookOptions = {},
  templateContext: HookTemplateContext = {},
): Promise<void> {
  let rendered: string;
  try {
    rendered = await renderHookCommand(command, templateContext);
  } catch (error) {
    const logError = truncateHookLogText(errorMessage(error));
    emitHookEvent(options, {
      status: "failed",
      command,
      cwd: workspace,
      hookName: options.hookName,
      workerHost,
      exitCode: null,
      error: logError.text,
      errorTruncated: logError.truncated,
    });
    throw error;
  }
  emitHookEvent(options, {
    status: "started",
    command: rendered,
    cwd: workspace,
    hookName: options.hookName,
    workerHost,
  });
  let result: Awaited<ReturnType<typeof runSsh>>;
  try {
    result = await runSsh(workerHost, `cd ${shellEscape(workspace)} && ${rendered}`, {
      timeoutMs: hooks.timeoutMs,
      stderrToStdout: true,
      abortSignal: options.abortSignal,
    });
  } catch (error) {
    const logError = truncateHookLogText(errorMessage(error));
    emitHookEvent(options, {
      status: "failed",
      command: rendered,
      cwd: workspace,
      hookName: options.hookName,
      workerHost,
      exitCode: null,
      error: logError.text,
      errorTruncated: logError.truncated,
    });
    throw error;
  }
  const output = truncateHookLogText(result.stdout);
  if (result.status !== 0) {
    const errorOutput = truncateHookLogText(result.stdout.trim());
    const error = new Error(
      `workspace hook failed with status ${result.status}: ${errorOutput.text}`,
    );
    emitHookEvent(options, {
      status: "failed",
      command: rendered,
      cwd: workspace,
      hookName: options.hookName,
      workerHost,
      exitCode: result.status,
      output: output.text,
      outputTruncated: output.truncated,
      error: error.message,
      errorTruncated: errorOutput.truncated,
    });
    throw error;
  }
  emitHookEvent(options, {
    status: "completed",
    command: rendered,
    cwd: workspace,
    hookName: options.hookName,
    workerHost,
    exitCode: result.status,
    output: output.text,
    outputTruncated: output.truncated,
  });
}

function emitHookEvent(options: WorkspaceRunHookOptions, event: HookExecutionMessage): void {
  options.onHookEvent?.(event);
}

function truncateHookLogText(text: string): { text: string; truncated: boolean } {
  if (text.length <= hookLogMaxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, hookLogMaxChars)}\n[truncated ${text.length - hookLogMaxChars} chars]`,
    truncated: true,
  };
}

async function remoteWorkspaceRoot(
  settings: Settings,
  workerHost: string,
  options: WorkspaceRunHookOptions = {},
): Promise<string> {
  const root = settings.workspace.rootExpression ?? settings.workspace.root;
  if (root === "~" || root.startsWith("~/")) {
    const result = await runSsh(workerHost, 'printf "%s\\n" "$HOME"', {
      timeoutMs: settings.worker.sshTimeoutMs,
      stderrToStdout: true,
      abortSignal: options.abortSignal,
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
  forceSlotSuffix = false,
): string {
  const issueRoot = path.posix.join(root, safeIdentifier(identifier));
  return ensembleSize > 1 || forceSlotSuffix
    ? path.posix.join(issueRoot, String(slotIndex))
    : issueRoot;
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
