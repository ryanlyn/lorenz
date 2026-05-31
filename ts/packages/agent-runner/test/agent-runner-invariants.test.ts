import { test, describe } from "vitest";
import fc from "fast-check";
import type { AgentSession, Issue, Settings } from "@symphony/domain";
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
    stateType: "unstarted",
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

function fakeAdapters(overrides: Partial<RunAgentAttemptAdapters> = {}): RunAgentAttemptAdapters {
  return {
    createWorkspaceForIssue: async () => "/tmp/workspace/TEST-1",
    runHook: async () => {},
    readResumeState: async () => ({ status: "missing" }),
    resumeStateMatches: () => false,
    writeResumeState: async () => {},
    executorFactory: () => ({
      kind: "codex",
      async startSession(input) {
        input.onUpdate?.({ type: "session_started", sessionId: "s1" });
        return fakeSession();
      },
      async runTurn() {
        return [{ type: "turn_completed" }];
      },
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Agent Execution Invariants
// ---------------------------------------------------------------------------

describe("INVARIANT: When the first turn begins, the system SHALL send the full rendered prompt.", () => {
  test("first turn receives the full rendered prompt from the template", async () => {
    const issue = fakeIssue({ title: "Fix the widget" });
    const settings = fakeSettings();
    const prompts: string[] = [];

    await runAgentAttempt({
      issue,
      workflow: {
        path: "/workflow.md",
        config: {},
        promptTemplate: "Please fix: {{issue.title}}",
        settings,
      },
      settings,
      adapters: fakeAdapters({
        executorFactory: () => ({
          kind: "codex",
          async startSession(input) {
            input.onUpdate?.({ type: "session_started", sessionId: "s1" });
            return fakeSession();
          },
          async runTurn(_session, prompt) {
            prompts.push(prompt);
            return [{ type: "turn_completed" }];
          },
        }),
      }),
    });

    assert.equal(prompts.length, 1);
    // The rendered template includes the issue title
    assert.match(prompts[0]!, "Fix the widget");
    // First-turn prompt must NOT contain continuation guidance
    assert.notMatch(prompts[0]!, /Continuation guidance/);
    assert.notMatch(prompts[0]!, /continuation turn #/);
  });

  test("first turn prompt renders all issue template variables", async () => {
    const issue = fakeIssue({
      identifier: "BUG-99",
      title: "Broken search",
      state: "Todo",
    });
    const settings = fakeSettings();
    const promptTemplate = "Issue {{issue.identifier}}: {{issue.title}} (state: {{issue.state}})";
    let capturedPrompt: string | null = null;

    await runAgentAttempt({
      issue,
      workflow: { path: "/workflow.md", config: {}, promptTemplate, settings },
      settings,
      adapters: fakeAdapters({
        executorFactory: () => ({
          kind: "codex",
          async startSession(input) {
            input.onUpdate?.({ type: "session_started", sessionId: "s1" });
            return fakeSession();
          },
          async runTurn(_session, prompt) {
            capturedPrompt = prompt;
            return [{ type: "turn_completed" }];
          },
        }),
      }),
    });

    assert.ok(capturedPrompt);
    assert.match(capturedPrompt!, "Issue BUG-99: Broken search (state: Todo)");
  });
});

describe("INVARIANT: When a continuation turn begins, the system SHALL send only the continuation guidance.", () => {
  test("continuation turns receive continuation guidance, not the full prompt", async () => {
    const issue = fakeIssue({ title: "Fix the widget" });
    const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 3 } });
    const prompts: string[] = [];

    await runAgentAttempt({
      issue,
      workflow: {
        path: "/workflow.md",
        config: {},
        promptTemplate: "Please fix: {{issue.title}}",
        settings,
      },
      settings,
      fetchIssue: async (iss) => iss,
      adapters: fakeAdapters({
        executorFactory: () => ({
          kind: "codex",
          async startSession(input) {
            input.onUpdate?.({ type: "session_started", sessionId: "s1" });
            return fakeSession();
          },
          async runTurn(_session, prompt) {
            prompts.push(prompt);
            return [{ type: "turn_completed" }];
          },
        }),
      }),
    });

    // All 3 turns should have run
    assert.equal(prompts.length, 3);

    // First turn: full rendered prompt (contains template content)
    assert.match(prompts[0]!, "Fix the widget");
    assert.notMatch(prompts[0]!, /Continuation guidance/);

    // Second turn: continuation guidance with correct turn numbering
    assert.notMatch(prompts[1]!, "Fix the widget");
    assert.match(prompts[1]!, /Continuation guidance/);
    assert.match(prompts[1]!, /turn #2 of 3/);

    // Third turn: continuation guidance with correct turn numbering
    assert.notMatch(prompts[2]!, "Fix the widget");
    assert.match(prompts[2]!, /Continuation guidance/);
    assert.match(prompts[2]!, /turn #3 of 3/);
  });

  test("single turn run without fetchIssue never sends continuation guidance", async () => {
    const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 5 } });
    const prompts: string[] = [];

    const result = await runAgentAttempt({
      issue: fakeIssue(),
      workflow: { path: "/workflow.md", config: {}, promptTemplate: "Do work", settings },
      settings,
      // No fetchIssue -> loop breaks after first turn
      adapters: fakeAdapters({
        executorFactory: () => ({
          kind: "codex",
          async startSession(input) {
            input.onUpdate?.({ type: "session_started", sessionId: "s1" });
            return fakeSession();
          },
          async runTurn(_session, prompt) {
            prompts.push(prompt);
            return [{ type: "turn_completed" }];
          },
        }),
      }),
    });

    assert.equal(result.turnCount, 1);
    assert.equal(prompts.length, 1);
    assert.notMatch(prompts[0]!, /Continuation guidance/);
  });
});

describe("INVARIANT: When the backend profile changes between turns, the system SHALL end the session and yield to the orchestrator.", () => {
  test("session ends when backend profile changes between turns via agent kind override", async () => {
    const issue = fakeIssue({ state: "Todo" });
    const overrides = new Map<string, { agent?: Partial<Settings["agent"]> }>();
    overrides.set("in progress", {
      agent: { kind: "claude" },
    });
    const settings = fakeSettings({
      agent: { ...defaultSettings().agent, maxTurns: 10, kind: "codex" },
      statusOverrides: overrides as Settings["statusOverrides"],
    });
    const result = await runAgentAttempt({
      issue,
      workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
      settings,
      fetchIssue: async (iss) => ({ ...iss, state: "In Progress" }),
      adapters: fakeAdapters({
        executorFactory: () => ({
          kind: "codex",
          async startSession(input) {
            input.onUpdate?.({ type: "session_started", sessionId: "s1" });
            return fakeSession();
          },
          async runTurn() {
            return [{ type: "turn_completed" }];
          },
        }),
      }),
    });

    // Session ends after 1 turn because agent kind changed from "codex" to "claude"
    assert.equal(result.turnCount, 1);
  });

  test("session continues when profile stays the same across turns", async () => {
    // No statusOverrides, issue stays in same state -> profile unchanged -> all turns run
    const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 3 } });

    const result = await runAgentAttempt({
      issue: fakeIssue({ state: "Todo" }),
      workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
      settings,
      fetchIssue: async (iss) => iss,
      adapters: fakeAdapters(),
    });

    assert.equal(result.turnCount, 3);
  });
});

describe("INVARIANT: When the turn count reaches the maximum, the system SHALL end the session.", () => {
  test("session ends when turn count reaches maxTurns", async () => {
    const issue = fakeIssue();
    const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 2 } });
    const prompts: string[] = [];

    const result = await runAgentAttempt({
      issue,
      workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
      settings,
      fetchIssue: async (iss) => iss,
      adapters: fakeAdapters({
        executorFactory: () => ({
          kind: "codex",
          async startSession(input) {
            input.onUpdate?.({ type: "session_started", sessionId: "s1" });
            return fakeSession();
          },
          async runTurn(_session, prompt) {
            prompts.push(prompt);
            return [{ type: "turn_completed" }];
          },
        }),
      }),
    });

    assert.equal(result.turnCount, 2);
    assert.equal(prompts.length, 2);
  });

  test("session terminates at exactly maxTurns for arbitrary positive values", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 50 }), async (maxTurns) => {
        const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns } });

        const result = await runAgentAttempt({
          issue: fakeIssue(),
          workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
          settings,
          fetchIssue: async (iss) => iss,
          adapters: fakeAdapters(),
        });

        assert.equal(result.turnCount, maxTurns);
      }),
      { numRuns: 20 },
    );
  });
});

describe("INVARIANT: When an agent run starts, the working directory SHALL be set to the validated workspace path.", () => {
  test("workspace path is passed to the executor session", async () => {
    const issue = fakeIssue();
    const settings = fakeSettings();
    let sessionWorkspace: string | null = null;

    await runAgentAttempt({
      issue,
      workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
      settings,
      adapters: fakeAdapters({
        createWorkspaceForIssue: async () => "/tmp/validated/workspace/TEST-1",
        executorFactory: () => ({
          kind: "codex",
          async startSession(input) {
            sessionWorkspace = input.workspace;
            input.onUpdate?.({ type: "session_started", sessionId: "s1" });
            return fakeSession();
          },
          async runTurn() {
            return [{ type: "turn_completed" }];
          },
        }),
      }),
    });

    assert.equal(sessionWorkspace, "/tmp/validated/workspace/TEST-1");
  });

  test("result workspace matches the path from createWorkspaceForIssue", async () => {
    const issue = fakeIssue();
    const settings = fakeSettings();

    const result = await runAgentAttempt({
      issue,
      workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
      settings,
      adapters: fakeAdapters({
        createWorkspaceForIssue: async () => "/srv/workspaces/my-issue",
      }),
    });

    assert.equal(result.workspace, "/srv/workspaces/my-issue");
  });
});
