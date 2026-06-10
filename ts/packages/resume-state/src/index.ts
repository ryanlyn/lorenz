import fs from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";
import { runSsh, shellEscape, writeRemoteFile } from "@symphony/ssh";
import { isRecord, type AgentKind } from "@symphony/domain";
import { z } from "zod";

export { resumeStateMatches, type ResumeStateIdentity } from "./matcher.js";

const remoteMissingMarker = "__SYMPHONY_RESUME_STATE_MISSING__";

export interface ResumeState {
  agentKind: AgentKind;
  resumeId: string;
  sessionId?: string | null | undefined;
  issueId?: string | null | undefined;
  issueIdentifier?: string | null | undefined;
  issueState?: string | null | undefined;
  workerHost?: string | null | undefined;
  workspacePath?: string | null | undefined;
  updatedAt?: string | null | undefined;
}

type ResumeReadResult =
  | { status: "ok"; state: ResumeState }
  | { status: "missing" }
  | { status: "unavailable" }
  | { status: "error"; reason: string };

type ResolveGitDir = (
  workspace: string,
  workerHost?: string | null,
  sshTimeoutMs?: number,
) => Promise<string | null>;

export interface ResumeStateStore {
  read(
    workspace: string,
    workerHost?: string | null,
    sshTimeoutMs?: number,
  ): Promise<ResumeReadResult>;
  write(
    workspace: string,
    state: ResumeState,
    workerHost?: string | null,
    sshTimeoutMs?: number,
  ): Promise<void>;
  delete(workspace: string, workerHost?: string | null, sshTimeoutMs?: number): Promise<void>;
  path(
    workspace: string,
    workerHost?: string | null,
    sshTimeoutMs?: number,
  ): Promise<string | null>;
}

interface ResumeStateStoreOptions {
  resolveGitDir?: ResolveGitDir | undefined;
}

export function createResumeStateStore(options: ResumeStateStoreOptions = {}): ResumeStateStore {
  const resolveGitDir = options.resolveGitDir ?? resolveWorkspaceGitDir;

  return {
    read: async (workspace, workerHost, sshTimeoutMs) =>
      readResumeStateWithResolver(resolveGitDir, workspace, workerHost, sshTimeoutMs),
    write: async (workspace, state, workerHost, sshTimeoutMs) =>
      writeResumeStateWithResolver(resolveGitDir, workspace, state, workerHost, sshTimeoutMs),
    delete: async (workspace, workerHost, sshTimeoutMs) =>
      deleteResumeStateWithResolver(resolveGitDir, workspace, workerHost, sshTimeoutMs),
    path: async (workspace, workerHost, sshTimeoutMs) =>
      resumeStatePathWithResolver(resolveGitDir, workspace, workerHost, sshTimeoutMs),
  };
}

const defaultResumeStateStore = createResumeStateStore();

export async function readResumeState(
  workspace: string,
  workerHost?: string | null,
  sshTimeoutMs?: number,
): Promise<ResumeReadResult> {
  return defaultResumeStateStore.read(workspace, workerHost, sshTimeoutMs);
}

async function readResumeStateWithResolver(
  resolveGitDir: ResolveGitDir,
  workspace: string,
  workerHost?: string | null,
  sshTimeoutMs?: number,
): Promise<ResumeReadResult> {
  const resumePath = await resumeStatePathWithResolver(
    resolveGitDir,
    workspace,
    workerHost,
    sshTimeoutMs,
  );
  if (!resumePath) return { status: "unavailable" };

  try {
    const text = workerHost
      ? await readRemoteResumeState(workerHost, resumePath, sshTimeoutMs)
      : await fs.readFile(resumePath, "utf8");
    if (text === null) return { status: "missing" };
    const decoded = JSON.parse(text) as unknown;
    const state = decodeResumeState(decoded);
    return state ? { status: "ok", state } : { status: "error", reason: "invalid_resume_state" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "missing" };
    if (error instanceof SyntaxError)
      return { status: "error", reason: "resume_state_decode_failed" };
    return { status: "error", reason: "resume_state_read_failed" };
  }
}

export async function writeResumeState(
  workspace: string,
  state: ResumeState,
  workerHost?: string | null,
  sshTimeoutMs?: number,
): Promise<void> {
  return defaultResumeStateStore.write(workspace, state, workerHost, sshTimeoutMs);
}

async function writeResumeStateWithResolver(
  resolveGitDir: ResolveGitDir,
  workspace: string,
  state: ResumeState,
  workerHost?: string | null,
  sshTimeoutMs?: number,
): Promise<void> {
  if (!validResumeState(state)) throw new Error("invalid_resume_state");
  const resumePath = await resumeStatePathWithResolver(
    resolveGitDir,
    workspace,
    workerHost,
    sshTimeoutMs,
  );
  if (!resumePath) return;
  const payload = `${JSON.stringify(encodeResumeState(state), null, 2)}\n`;
  if (workerHost) {
    await writeRemoteFile(workerHost, resumePath, payload, { timeoutMs: sshTimeoutMs });
    return;
  }
  await fs.mkdir(path.dirname(resumePath), { recursive: true });
  await fs.writeFile(resumePath, payload);
}

export async function deleteResumeState(
  workspace: string,
  workerHost?: string | null,
  sshTimeoutMs?: number,
): Promise<void> {
  return defaultResumeStateStore.delete(workspace, workerHost, sshTimeoutMs);
}

async function deleteResumeStateWithResolver(
  resolveGitDir: ResolveGitDir,
  workspace: string,
  workerHost?: string | null,
  sshTimeoutMs?: number,
): Promise<void> {
  const resumePath = await resumeStatePathWithResolver(
    resolveGitDir,
    workspace,
    workerHost,
    sshTimeoutMs,
  );
  if (!resumePath) return;
  if (workerHost) {
    const result = await runSsh(workerHost, `rm -f ${shellEscape(resumePath)}`, {
      stderrToStdout: true,
      timeoutMs: sshTimeoutMs,
    });
    if (result.status !== 0)
      throw new Error(`resume_state_delete_failed: ${result.status} ${result.stdout}`);
    return;
  }
  await fs.rm(resumePath, { force: true });
}

async function resumeStatePathWithResolver(
  resolveGitDir: ResolveGitDir,
  workspace: string,
  workerHost?: string | null,
  sshTimeoutMs?: number,
): Promise<string | null> {
  try {
    const gitDir = await resolveGitDir(workspace, workerHost, sshTimeoutMs);
    if (!gitDir) return null;
    return resumePathForGitDir(workspace, gitDir, workerHost);
  } catch {
    return null;
  }
}

async function resolveWorkspaceGitDir(
  workspace: string,
  workerHost?: string | null,
  sshTimeoutMs?: number,
): Promise<string | null> {
  if (workerHost) {
    const result = await runSsh(
      workerHost,
      `git -C ${shellEscape(workspace)} rev-parse --git-dir`,
      {
        stderrToStdout: true,
        timeoutMs: sshTimeoutMs,
      },
    );
    if (result.status !== 0) return null;
    return result.stdout.trim();
  }
  const { stdout } = await execa("git", ["-C", workspace, "rev-parse", "--git-dir"]);
  return stdout.trim();
}

function resumePathForGitDir(
  workspace: string,
  gitDir: string,
  workerHost?: string | null,
): string {
  if (workerHost) {
    return path.posix.join(
      path.posix.isAbsolute(gitDir) ? gitDir : path.posix.join(workspace, gitDir),
      "symphony",
      "resume.json",
    );
  }
  const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(workspace, gitDir);
  return path.join(absoluteGitDir, "symphony", "resume.json");
}

async function readRemoteResumeState(
  workerHost: string,
  resumePath: string,
  sshTimeoutMs?: number,
): Promise<string | null> {
  const result = await runSsh(
    workerHost,
    [
      `if [ -f ${shellEscape(resumePath)} ]; then`,
      `  cat ${shellEscape(resumePath)}`,
      "else",
      `  printf '%s' ${shellEscape(remoteMissingMarker)}`,
      "fi",
    ].join("\n"),
    { stderrToStdout: true, timeoutMs: sshTimeoutMs },
  );
  if (result.status !== 0) throw new Error("resume_state_read_failed");
  return result.stdout === remoteMissingMarker ? null : result.stdout;
}

const storedNonBlankStringSchema = z.string().refine((value) => value.trim() !== "");
const storedNullableStringSchema = z.preprocess(
  (value) => (typeof value === "string" && value !== "" ? value : null),
  z.string().nullable(),
);

const resumeStateSchema = z.preprocess(
  (value) => {
    if (!isRecord(value)) return value;
    const sessionId = value.session_id ?? value.sessionId;
    return {
      agentKind: value.agent ?? value.agent_kind ?? value.agentKind,
      resumeId: sessionId ?? value.resume_id ?? value.resumeId ?? value.thread_id ?? value.threadId,
      sessionId,
      issueId: value.issue_id ?? value.issueId,
      issueIdentifier: value.issue_identifier ?? value.issueIdentifier,
      issueState: value.issue_state ?? value.issueState,
      workerHost: value.worker_host ?? value.workerHost,
      workspacePath: value.workspace_path ?? value.workspacePath,
      updatedAt: value.updated_at ?? value.updatedAt,
    };
  },
  z.object({
    agentKind: storedNonBlankStringSchema,
    resumeId: storedNonBlankStringSchema,
    sessionId: storedNullableStringSchema,
    issueId: storedNullableStringSchema,
    issueIdentifier: storedNullableStringSchema,
    issueState: storedNullableStringSchema,
    workerHost: storedNullableStringSchema,
    workspacePath: storedNullableStringSchema,
    updatedAt: storedNullableStringSchema,
  }),
);

function decodeResumeState(data: unknown): ResumeState | null {
  const result = resumeStateSchema.safeParse(data);
  return result.success ? result.data : null;
}

function encodeResumeState(state: ResumeState): Record<string, unknown> {
  const sessionId = state.sessionId ?? state.resumeId;
  return {
    agent: state.agentKind,
    session_id: sessionId,
    // Legacy keys are kept during the migration so old readers can still resume.
    agent_kind: state.agentKind,
    resume_id: state.resumeId,
    issue_id: state.issueId ?? null,
    issue_identifier: state.issueIdentifier ?? null,
    issue_state: state.issueState ?? null,
    worker_host: state.workerHost ?? null,
    workspace_path: state.workspacePath ?? null,
    updated_at: state.updatedAt ?? new Date().toISOString(),
  };
}

function validResumeState(state: ResumeState): boolean {
  return state.agentKind.trim() !== "" && state.resumeId.trim() !== "";
}
