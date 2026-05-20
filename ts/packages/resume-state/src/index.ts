import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { runSsh, shellEscape, writeRemoteFile } from "@symphony/ssh";
import type { AgentKind, Issue } from "@symphony/domain";
import { z } from "zod";

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

export type ResumeReadResult =
  | { status: "ok"; state: ResumeState }
  | { status: "missing" }
  | { status: "unavailable" }
  | { status: "error"; reason: string };

export async function readResumeState(
  workspace: string,
  workerHost?: string | null,
  sshTimeoutMs?: number | undefined,
): Promise<ResumeReadResult> {
  const resumePath = await resumeStatePath(workspace, workerHost, sshTimeoutMs);
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
  sshTimeoutMs?: number | undefined,
): Promise<void> {
  if (!validResumeState(state)) throw new Error("invalid_resume_state");
  const resumePath = await resumeStatePath(workspace, workerHost, sshTimeoutMs);
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
  sshTimeoutMs?: number | undefined,
): Promise<void> {
  const resumePath = await resumeStatePath(workspace, workerHost, sshTimeoutMs);
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

export async function resumeStatePath(
  workspace: string,
  workerHost?: string | null,
  sshTimeoutMs?: number | undefined,
): Promise<string | null> {
  try {
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
      const gitDir = result.stdout.trim();
      return path.posix.join(
        path.posix.isAbsolute(gitDir) ? gitDir : path.posix.join(workspace, gitDir),
        "symphony",
        "resume.json",
      );
    }
    const { stdout } = await execa("git", ["-C", workspace, "rev-parse", "--git-dir"]);
    const gitDir = stdout.trim();
    const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(workspace, gitDir);
    return path.join(absoluteGitDir, "symphony", "resume.json");
  } catch {
    return null;
  }
}

async function readRemoteResumeState(
  workerHost: string,
  resumePath: string,
  sshTimeoutMs?: number | undefined,
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

export function resumeStateMatches(
  state: ResumeState,
  input: { agentKind: AgentKind; issue: Issue; workspacePath: string; workerHost?: string | null },
): boolean {
  return (
    state.agentKind === input.agentKind &&
    state.resumeId.trim() !== "" &&
    storedStringMatches(state.issueId, input.issue.id) &&
    storedStringMatches(state.issueIdentifier, input.issue.identifier) &&
    storedStringMatches(state.issueState, input.issue.state) &&
    storedStringMatches(state.workspacePath, input.workspacePath) &&
    storedNullableMatches(state.workerHost, input.workerHost ?? null)
  );
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

function storedStringMatches(
  stored: string | null | undefined,
  current: string | null | undefined,
): boolean {
  return (
    typeof stored === "string" &&
    stored.trim() !== "" &&
    typeof current === "string" &&
    current.trim() !== "" &&
    stored === current
  );
}

function storedNullableMatches(
  stored: string | null | undefined,
  current: string | null | undefined,
): boolean {
  if (current === null || current === undefined) return stored === null || stored === undefined;
  return storedStringMatches(stored, current);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
