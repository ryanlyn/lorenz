import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { test, beforeEach, afterEach } from "vitest";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import { createResumeStateStore, resumeStateMatches } from "@symphony/resume-state";
import type { ResumeState, ResumeStateStore } from "@symphony/resume-state";

let tmpDir: string;
let gitDir: string;
let store: ResumeStateStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-state-test-"));
  gitDir = path.join(tmpDir, ".git");
  await fs.mkdir(gitDir, { recursive: true });
  store = createResumeStateStore({ resolveGitDir: async () => gitDir });
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

test("resume state store uses an injected git dir resolver", async () => {
  const resolvedWorkspaces: string[] = [];
  const injectedStore = createResumeStateStore({
    resolveGitDir: async (workspace) => {
      resolvedWorkspaces.push(workspace);
      return gitDir;
    },
  });

  await injectedStore.write(tmpDir, validState());

  const encoded = JSON.parse(
    await fs.readFile(path.join(gitDir, "symphony", "resume.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(resolvedWorkspaces, [tmpDir]);
  assert.equal(encoded.agent, "claude");
  assert.equal(encoded.session_id, "sess-abc-123");
  assert.equal(encoded.workspace_path, tmpDir);
});

// --- writeResumeState + readResumeState round-trip ---

test("writeResumeState + readResumeState — round-trip preserves all fields", async () => {
  const state = validState();
  await store.write(tmpDir, state);
  const result = await store.read(tmpDir);
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

test('readResumeState — missing file returns { status: "missing" }', async () => {
  const result = await store.read(tmpDir);
  assert.equal(result.status, "missing");
});

test('readResumeState — invalid JSON returns { status: "error" }', async () => {
  const resumePath = path.join(gitDir, "symphony", "resume.json");
  await fs.mkdir(path.dirname(resumePath), { recursive: true });
  await fs.writeFile(resumePath, "not valid json {{{");
  const result = await store.read(tmpDir);
  assert.equal(result.status, "error");
});

test('readResumeState — non-git directory returns { status: "unavailable" }', async () => {
  const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-no-git-"));
  const nonGitStore = createResumeStateStore({ resolveGitDir: async () => null });
  try {
    const result = await nonGitStore.read(nonGitDir);
    assert.equal(result.status, "unavailable");
  } finally {
    await fs.rm(nonGitDir, { recursive: true, force: true });
  }
});

test("readResumeState — decodes legacy fields correctly (session_id, agent_kind, thread_id)", async () => {
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
  const result = await store.read(tmpDir);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.state.agentKind, "codex");
  assert.equal(result.state.resumeId, "legacy-sess-1");
  assert.equal(result.state.issueId, "issue-5");
});

// --- writeResumeState validation ---

test("writeResumeState — rejects empty agentKind", async () => {
  await assert.rejects(
    () => store.write(tmpDir, validState({ agentKind: "" })),
    "invalid_resume_state",
  );
});

test("writeResumeState — rejects empty resumeId", async () => {
  await assert.rejects(
    () => store.write(tmpDir, validState({ resumeId: "  " })),
    "invalid_resume_state",
  );
});

// --- deleteResumeState ---

test("deleteResumeState — removes existing file", async () => {
  await store.write(tmpDir, validState());
  const before = await store.read(tmpDir);
  assert.equal(before.status, "ok");
  await store.delete(tmpDir);
  const after = await store.read(tmpDir);
  assert.equal(after.status, "missing");
});

test("deleteResumeState — no-op when file already absent", async () => {
  await store.delete(tmpDir);
  const result = await store.read(tmpDir);
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
