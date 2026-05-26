import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { test, beforeEach, afterEach } from "vitest";
import {
  readResumeState,
  writeResumeState,
  deleteResumeState,
  resumeStateMatches,
} from "@symphony/cli";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import type { ResumeState } from "@symphony/resume-state";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-state-test-"));
  await execa("git", ["init", tmpDir]);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function validState(overrides: Partial<ResumeState> = {}): ResumeState {
  return {
    agentKind: "claude",
    resumeId: "sess-abc-123",
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    issueState: "In Progress",
    workerHost: null,
    workspacePath: tmpDir,
    ...overrides,
  };
}

// --- writeResumeState + readResumeState round-trip ---

test("writeResumeState + readResumeState — round-trip preserves all fields", async () => {
  const state = validState();
  await writeResumeState(tmpDir, state);
  const result = await readResumeState(tmpDir);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.state.agentKind, state.agentKind);
  assert.equal(result.state.resumeId, state.resumeId);
  assert.equal(result.state.issueId, state.issueId);
  assert.equal(result.state.issueIdentifier, state.issueIdentifier);
  assert.equal(result.state.issueState, state.issueState);
  assert.equal(result.state.workspacePath, state.workspacePath);
});

// --- readResumeState ---

test("readResumeState — missing file returns { status: \"missing\" }", async () => {
  const result = await readResumeState(tmpDir);
  assert.equal(result.status, "missing");
});

test("readResumeState — invalid JSON returns { status: \"error\" }", async () => {
  const { stdout } = await execa("git", ["-C", tmpDir, "rev-parse", "--git-dir"]);
  const gitDir = path.isAbsolute(stdout.trim()) ? stdout.trim() : path.join(tmpDir, stdout.trim());
  const resumePath = path.join(gitDir, "symphony", "resume.json");
  await fs.mkdir(path.dirname(resumePath), { recursive: true });
  await fs.writeFile(resumePath, "not valid json {{{");
  const result = await readResumeState(tmpDir);
  assert.equal(result.status, "error");
});

test("readResumeState — non-git directory returns { status: \"unavailable\" }", async () => {
  const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-no-git-"));
  try {
    const result = await readResumeState(nonGitDir);
    assert.equal(result.status, "unavailable");
  } finally {
    await fs.rm(nonGitDir, { recursive: true, force: true });
  }
});

test("readResumeState — decodes legacy fields correctly (session_id, agent_kind, thread_id)", async () => {
  const { stdout } = await execa("git", ["-C", tmpDir, "rev-parse", "--git-dir"]);
  const gitDir = path.isAbsolute(stdout.trim()) ? stdout.trim() : path.join(tmpDir, stdout.trim());
  const resumePath = path.join(gitDir, "symphony", "resume.json");
  await fs.mkdir(path.dirname(resumePath), { recursive: true });
  const legacy = {
    agent_kind: "codex",
    session_id: "legacy-sess-1",
    thread_id: "thread-99",
    issue_id: "issue-5",
    issue_identifier: "ENG-5",
    issue_state: "Todo",
    worker_host: null,
    workspace_path: "/tmp/ws",
  };
  await fs.writeFile(resumePath, JSON.stringify(legacy));
  const result = await readResumeState(tmpDir);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.state.agentKind, "codex");
  assert.equal(result.state.resumeId, "legacy-sess-1");
  assert.equal(result.state.issueId, "issue-5");
});

// --- writeResumeState validation ---

test("writeResumeState — rejects empty agentKind", async () => {
  await assert.rejects(
    () => writeResumeState(tmpDir, validState({ agentKind: "" })),
    "invalid_resume_state",
  );
});

test("writeResumeState — rejects empty resumeId", async () => {
  await assert.rejects(
    () => writeResumeState(tmpDir, validState({ resumeId: "  " })),
    "invalid_resume_state",
  );
});

// --- deleteResumeState ---

test("deleteResumeState — removes existing file", async () => {
  await writeResumeState(tmpDir, validState());
  const before = await readResumeState(tmpDir);
  assert.equal(before.status, "ok");
  await deleteResumeState(tmpDir);
  const after = await readResumeState(tmpDir);
  assert.equal(after.status, "missing");
});

test("deleteResumeState — no-op when file already absent", async () => {
  await deleteResumeState(tmpDir);
  const result = await readResumeState(tmpDir);
  assert.equal(result.status, "missing");
});

// --- resumeStateMatches ---

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-1",
    title: "Test",
    state: "In Progress",
    labels: [],
    blockers: [],
    ...overrides,
  };
}

test("resumeStateMatches — full match returns true", () => {
  const state = validState();
  const result = resumeStateMatches(state, {
    agentKind: "claude",
    issue: makeIssue(),
    workspacePath: tmpDir,
    workerHost: null,
  });
  assert.equal(result, true);
});

test("resumeStateMatches — mismatched issueState returns false", () => {
  const state = validState({ issueState: "In Progress" });
  const result = resumeStateMatches(state, {
    agentKind: "claude",
    issue: makeIssue({ state: "Done" }),
    workspacePath: tmpDir,
    workerHost: null,
  });
  assert.equal(result, false);
});

test("resumeStateMatches — missing optional workerHost still matches when current is null", () => {
  const state = validState({ workerHost: undefined });
  const result = resumeStateMatches(state, {
    agentKind: "claude",
    issue: makeIssue(),
    workspacePath: tmpDir,
    workerHost: null,
  });
  assert.equal(result, true);
});

test("resumeStateMatches — blank resumeId always returns false", () => {
  const state = validState({ resumeId: "" });
  const result = resumeStateMatches(state, {
    agentKind: "claude",
    issue: makeIssue(),
    workspacePath: tmpDir,
    workerHost: null,
  });
  assert.equal(result, false);
});
