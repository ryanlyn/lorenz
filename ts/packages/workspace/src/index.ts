import fs from "node:fs/promises";
import path from "node:path";

import { Liquid } from "liquidjs";
import { runSsh, shellEscape } from "@symphony/ssh";
import {
  errorMessage,
  type HookExecutionMessage,
  type HooksSettings,
  type Issue,
  type Settings,
} from "@symphony/domain";
import { execa } from "execa";

const remoteWorkspaceMarker = "__SYMPHONY_WORKSPACE__";
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
  abortSignal?: AbortSignal | undefined;
  onHookEvent?: ((event: HookExecutionMessage) => void) | undefined;
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
  options: WorkspaceCreateOptions = {},
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

  return canonicalTarget;
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
