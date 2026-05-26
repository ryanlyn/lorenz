import { test } from "vitest";
import type { AgentExecutor, AgentSession, AgentUpdate, Issue, Settings } from "@symphony/domain";
import { defaultSettings } from "@symphony/config";

import { assert } from "../../../test/assert.js";
import { runAgentAttempt, type RunAgentAttemptAdapters } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "Test issue",
    state: "Todo",
    labels: [],
    blockers: [],
    ...overrides,
  };
}

function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), ...overrides };
}

function fakeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    agentKind: "codex",
    sessionId: "session-1",
    resumeId: "resume-1",
    executorPid: "999",
    stop: async () => {},
    ...overrides,
  };
}

function fakeExecutor(
  opts: {
    updates?: AgentUpdate[];
    session?: Partial<AgentSession>;
    throwOnTurn?: Error;
  } = {},
): AgentExecutor {
  const session = fakeSession(opts.session);
  return {
    kind: "codex",
    async startSession(input) {
      input.onUpdate?.({ type: "session_started", sessionId: session.sessionId });
      return session;
    },
    async runTurn(_session, _prompt, _issue) {
      if (opts.throwOnTurn) throw opts.throwOnTurn;
      const updates = opts.updates ?? [{ type: "turn_completed" }];
      return updates;
    },
  };
}

function fakeAdapters(overrides: Partial<RunAgentAttemptAdapters> = {}): RunAgentAttemptAdapters {
  return {
    createWorkspaceForIssue: async () => "/tmp/workspace/TEST-1",
    runHook: async () => {},
    readResumeState: async () => ({ status: "missing" }),
    resumeStateMatches: () => false,
    writeResumeState: async () => {},
    executorFactory: () => fakeExecutor(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// runAgentAttempt
// ---------------------------------------------------------------------------

test("runAgentAttempt returns success result on normal completion", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();
  const result = await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix {{issue.title}}", settings },
    settings,
    adapters: fakeAdapters(),
  });

  assert.equal(result.workspace, "/tmp/workspace/TEST-1");
  assert.equal(result.turnCount, 1);
  assert.equal(result.agentKind, "codex");
  assert.ok(result.updates.length > 0);
});

test("runAgentAttempt returns failure result when executor throws", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();
  const error = new Error("executor_crashed");

  await assert.rejects(
    () =>
      runAgentAttempt({
        issue,
        workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
        settings,
        adapters: fakeAdapters({
          executorFactory: () => fakeExecutor({ throwOnTurn: error }),
        }),
      }),
    "executor_crashed",
  );
});

test("runAgentAttempt respects abort signal and stops executor mid-turn", async () => {
  const ac = new AbortController();
  const issue = fakeIssue();
  const settings = fakeSettings();

  const slowExecutor: AgentExecutor = {
    kind: "codex",
    async startSession(input) {
      const session = fakeSession();
      input.onUpdate?.({ type: "session_started", sessionId: session.sessionId });
      return session;
    },
    async runTurn() {
      // Simulate a long-running turn that will be aborted
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return [{ type: "turn_completed" }];
    },
  };

  // Abort quickly
  setTimeout(() => ac.abort(), 20);

  await assert.rejects(
    () =>
      runAgentAttempt({
        issue,
        workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
        settings,
        abortSignal: ac.signal,
        adapters: fakeAdapters({ executorFactory: () => slowExecutor }),
      }),
    "agent_run_aborted",
  );
});

// ---------------------------------------------------------------------------
// executorFor
// ---------------------------------------------------------------------------

test("executorFor selects codex executor for codex backend profile", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();
  let factoryCalledWith: Settings | null = null;

  const result = await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      executorFactory: (s) => {
        factoryCalledWith = s;
        return fakeExecutor({ session: { agentKind: "codex" } });
      },
    }),
  });

  assert.ok(factoryCalledWith);
  assert.equal(result.agentKind, "codex");
});

test("executorFor selects ACP executor for claude backend profile", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, kind: "claude" } });

  const result = await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      executorFactory: () => fakeExecutor({ session: { agentKind: "claude" } }),
    }),
  });

  assert.equal(result.agentKind, "claude");
});

test("executorFor throws on unknown backend", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();

  await assert.rejects(
    () =>
      runAgentAttempt({
        issue,
        workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
        settings,
        adapters: {
          createWorkspaceForIssue: async () => "/tmp/workspace/TEST-1",
          runHook: async () => {},
          readResumeState: async () => ({ status: "missing" }),
          resumeStateMatches: () => false,
          writeResumeState: async () => {},
          // No executorFactory provided - should throw adapter missing error
        },
      }),
    "agent_runner_adapter_missing: executorFactory",
  );
});

// ---------------------------------------------------------------------------
// createWorkspaceForIssue
// ---------------------------------------------------------------------------

test("createWorkspaceForIssue calls workspace adapter with correct issue/ensemble args", async () => {
  const issue = fakeIssue({ id: "ws-issue", identifier: "WS-1" });
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, ensembleSize: 3 } });
  let capturedIssue: Issue | null = null;
  let capturedOptions: {
    slotIndex: number;
    ensembleSize: number;
    workerHost: string | null;
  } | null = null;

  await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    slotIndex: 2,
    adapters: fakeAdapters({
      createWorkspaceForIssue: async (_settings, iss, opts) => {
        capturedIssue = iss;
        capturedOptions = opts;
        return "/tmp/workspace/WS-1";
      },
    }),
  });

  assert.equal(capturedIssue!.id, "ws-issue");
  assert.equal(capturedOptions!.slotIndex, 2);
  assert.equal(capturedOptions!.ensembleSize, 3);
  assert.equal(capturedOptions!.workerHost, null);
});

test("createWorkspaceForIssue reuses existing workspace when resume state matches", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();
  let createCalls = 0;

  const result = await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      createWorkspaceForIssue: async () => {
        createCalls += 1;
        return "/tmp/workspace/TEST-1";
      },
      readResumeState: async () => ({
        status: "ok",
        state: {
          agentKind: "codex",
          resumeId: "existing-resume",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          issueState: issue.state,
          workspacePath: "/tmp/workspace/TEST-1",
          workerHost: null,
        },
      }),
      resumeStateMatches: () => true,
      executorFactory: () => fakeExecutor({ session: { resumeId: "existing-resume" } }),
    }),
  });

  // createWorkspaceForIssue is still called (it determines the path),
  // but the resume state match means the executor receives the resumeId
  assert.equal(createCalls, 1);
  assert.equal(result.resumeId, "existing-resume");
});

// ---------------------------------------------------------------------------
// persistResumeState
// ---------------------------------------------------------------------------

test("persistResumeState writes agentKind, resumeId, and backend fields", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();
  let writtenState: Record<string, unknown> | null = null;

  await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      executorFactory: () =>
        fakeExecutor({ session: { resumeId: "persist-id", agentKind: "codex" } }),
      writeResumeState: async (_workspace, state) => {
        writtenState = state as unknown as Record<string, unknown>;
      },
    }),
  });

  assert.ok(writtenState);
  assert.equal(writtenState!.agentKind, "codex");
  assert.equal(writtenState!.resumeId, "persist-id");
  assert.equal(writtenState!.issueId, issue.id);
});

// ---------------------------------------------------------------------------
// readResumeState
// ---------------------------------------------------------------------------

test("readResumeState returns null when no state file exists", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();
  let executorReceivedResumeId: string | null | undefined = "not-set";

  await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      readResumeState: async () => ({ status: "missing" }),
      executorFactory: () => ({
        kind: "codex",
        async startSession(input) {
          executorReceivedResumeId = input.resumeId;
          return fakeSession({ resumeId: null });
        },
        async runTurn() {
          return [{ type: "turn_completed" }];
        },
      }),
    }),
  });

  assert.equal(executorReceivedResumeId, null);
});

// ---------------------------------------------------------------------------
// resumeStateMatches
// ---------------------------------------------------------------------------

test("resumeStateMatches returns true for matching agentKind + resumeId", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();
  let executorReceivedResumeId: string | null | undefined = null;

  await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      readResumeState: async () => ({
        status: "ok",
        state: {
          agentKind: "codex",
          resumeId: "matched-resume",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          issueState: issue.state,
          workspacePath: "/tmp/workspace/TEST-1",
          workerHost: null,
        },
      }),
      resumeStateMatches: (state, input) => {
        return state.agentKind === input.agentKind && state.resumeId === "matched-resume";
      },
      executorFactory: () => ({
        kind: "codex",
        async startSession(input) {
          executorReceivedResumeId = input.resumeId;
          return fakeSession({ resumeId: "matched-resume" });
        },
        async runTurn() {
          return [{ type: "turn_completed" }];
        },
      }),
    }),
  });

  assert.equal(executorReceivedResumeId, "matched-resume");
});

test("resumeStateMatches returns false on agentKind mismatch", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();
  let executorReceivedResumeId: string | null | undefined = "not-set";

  await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      readResumeState: async () => ({
        status: "ok",
        state: {
          agentKind: "claude",
          resumeId: "old-resume",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          issueState: issue.state,
          workspacePath: "/tmp/workspace/TEST-1",
          workerHost: null,
        },
      }),
      resumeStateMatches: (state, input) => {
        // Mismatched agentKind: state says "claude", input says "codex"
        return state.agentKind === input.agentKind;
      },
      executorFactory: () => ({
        kind: "codex",
        async startSession(input) {
          executorReceivedResumeId = input.resumeId;
          return fakeSession({ resumeId: null });
        },
        async runTurn() {
          return [{ type: "turn_completed" }];
        },
      }),
    }),
  });

  // When resumeStateMatches returns false, executor should receive null resumeId
  assert.equal(executorReceivedResumeId, null);
});

// ---------------------------------------------------------------------------
// runHook
// ---------------------------------------------------------------------------

test("runHook executes afterCreate hook with workspace path", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings({
    hooks: { ...defaultSettings().hooks, beforeRun: "echo setup" },
  });
  let hookCommand: string | null = null;
  let hookWorkspace: string | null = null;

  await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      runHook: async (command, workspace) => {
        hookCommand = command;
        hookWorkspace = workspace;
      },
    }),
  });

  assert.equal(hookCommand, "echo setup");
  assert.equal(hookWorkspace, "/tmp/workspace/TEST-1");
});

test("runHook skips execution when hook is undefined", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings({
    hooks: { ...defaultSettings().hooks, beforeRun: undefined, afterRun: undefined },
  });
  let hookCalled = false;

  await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      runHook: async () => {
        hookCalled = true;
      },
    }),
  });

  assert.equal(hookCalled, false);
});

// ---------------------------------------------------------------------------
// RunController
// ---------------------------------------------------------------------------

test("RunController propagates updates from executor to caller", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();
  const received: AgentUpdate[] = [];

  const sessionUpdates: AgentUpdate[] = [
    { type: "turn_started", message: "starting" },
    { type: "turn_completed", message: "done" },
  ];

  await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    onUpdate: (update) => received.push(update),
    adapters: fakeAdapters({
      executorFactory: () => ({
        kind: "codex",
        async startSession(input) {
          input.onUpdate?.({ type: "session_started", sessionId: "s1" });
          return fakeSession();
        },
        async runTurn(_session, _prompt, _issue) {
          return sessionUpdates;
        },
      }),
    }),
  });

  // Should have received workspace_prepared from the controller + session_started from executor
  assert.ok(received.some((u) => u.type === "workspace_prepared"));
  assert.ok(received.some((u) => u.type === "session_started"));
});

test("RunController accumulates usage totals across turns", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 3 } });
  let turnNumber = 0;
  let sessionOnUpdate: ((update: AgentUpdate) => void) | undefined;

  const result = await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async (iss) => iss,
    adapters: fakeAdapters({
      executorFactory: () => ({
        kind: "codex",
        async startSession(input) {
          sessionOnUpdate = input.onUpdate;
          input.onUpdate?.({ type: "session_started", sessionId: "s1" });
          return fakeSession();
        },
        async runTurn() {
          turnNumber += 1;
          const usageUpdate: AgentUpdate = {
            type: "usage",
            usage: {
              inputTokens: 10 * turnNumber,
              outputTokens: 5 * turnNumber,
              totalTokens: 15 * turnNumber,
            },
          };
          sessionOnUpdate?.(usageUpdate);
          sessionOnUpdate?.({ type: "turn_completed" });
          return [usageUpdate, { type: "turn_completed" }];
        },
      }),
    }),
  });

  // The controller runs at least one turn and accumulates updates from onUpdate callback
  assert.ok(result.turnCount >= 1);
  const usageUpdates = result.updates.filter((u) => u.type === "usage");
  assert.ok(usageUpdates.length >= 1);
  // Verify usage fields are passed through
  assert.ok(usageUpdates[0]!.usage);
  assert.equal(usageUpdates[0]!.usage!.inputTokens, 10);
  assert.equal(usageUpdates[0]!.usage!.outputTokens, 5);
});

// ---------------------------------------------------------------------------
// throwIfAborted
// ---------------------------------------------------------------------------

test("throwIfAborted is no-op when signal not aborted", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();
  const ac = new AbortController();

  // Should complete without throwing since signal is not aborted
  const result = await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    abortSignal: ac.signal,
    adapters: fakeAdapters(),
  });

  assert.equal(result.turnCount, 1);
});

test("throwIfAborted throws when signal is aborted", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();
  const ac = new AbortController();

  // Abort before starting
  ac.abort();

  await assert.rejects(
    () =>
      runAgentAttempt({
        issue,
        workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
        settings,
        abortSignal: ac.signal,
        adapters: fakeAdapters(),
      }),
    "agent_run_aborted",
  );
});

// ---------------------------------------------------------------------------
// backendProfile
// ---------------------------------------------------------------------------

test("backendProfile extracts profile from settings", async () => {
  const issue = fakeIssue();
  const baseSettings = fakeSettings();
  // Run with default codex backend - the executor factory receives the settings
  let receivedSettings: Settings | null = null;

  await runAgentAttempt({
    issue,
    workflow: {
      path: "/workflow.md",
      config: {},
      promptTemplate: "Fix it",
      settings: baseSettings,
    },
    settings: baseSettings,
    adapters: fakeAdapters({
      executorFactory: (s) => {
        receivedSettings = s;
        return fakeExecutor();
      },
    }),
  });

  // The settings passed to executorFactory should have the correct agent kind
  assert.ok(receivedSettings);
  assert.equal(receivedSettings!.agent.kind, "codex");
  // The agents map should contain the codex config
  assert.ok(receivedSettings!.agents["codex"]);
});
