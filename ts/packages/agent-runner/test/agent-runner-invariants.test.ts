import { test, describe } from "vitest";
import fc from "fast-check";
import type { AgentSession, AgentUpdate, Issue, Settings } from "@symphony/domain";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { defaultSettings } from "@symphony/config";
import { assert } from "@symphony/test-utils";

import { runAgentAttempt, type RunAgentAttemptAdapters } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeToolCallNotification(): AgentUpdate {
  return {
    type: "session_notification",
    message: {
      sessionId: "s1",
      update: { sessionUpdate: "tool_call" },
    } as unknown as SessionNotification,
  };
}

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

/** Settings using the default ACP executor (production path). */
function fakeSettings(overrides: Partial<Settings> = {}): Settings {
  const base = defaultSettings();
  return { ...base, ...overrides };
}

function fakeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    agentKind: "codex",
    sessionId: "session-1",
    executorPid: "999",
    stop: async () => {},
    ...overrides,
  };
}

function fakeAdapters(overrides: Partial<RunAgentAttemptAdapters> = {}): RunAgentAttemptAdapters {
  return {
    createWorkspaceForIssue: async () => "/tmp/workspace/TEST-1",
    runHook: async () => {},
    executorFactory: () => ({
      kind: "codex",
      async startSession(input) {
        input.onUpdate?.({
          type: "session_started",
          message: "session started (s1)",
          sessionId: "s1",
        });
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
            input.onUpdate?.({
              type: "session_started",
              message: "session started (s1)",
              sessionId: "s1",
            });
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
            input.onUpdate?.({
              type: "session_started",
              message: "session started (s1)",
              sessionId: "s1",
            });
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
  test("continuation turns receive continuation guidance, not the full prompt (ACP)", async () => {
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
            input.onUpdate?.({
              type: "session_started",
              message: "session started (s1)",
              sessionId: "s1",
            });
            return fakeSession();
          },
          async runTurn(_session, prompt) {
            prompts.push(prompt);
            // Emit tool_use_requested so ACP loop continues
            return [fakeToolCallNotification(), { type: "turn_completed" }];
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
            input.onUpdate?.({
              type: "session_started",
              message: "session started (s1)",
              sessionId: "s1",
            });
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
  test("session ends when backend profile changes between turns via agent kind override (ACP)", async () => {
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
            input.onUpdate?.({
              type: "session_started",
              message: "session started (s1)",
              sessionId: "s1",
            });
            return fakeSession();
          },
          async runTurn() {
            // Emit tool_use_requested so ACP check does not interfere
            return [fakeToolCallNotification(), { type: "turn_completed" }];
          },
        }),
      }),
    });

    // Session ends after 1 turn because agent kind changed from "codex" to "claude"
    assert.equal(result.turnCount, 1);
  });

  test("session continues when profile stays the same across turns (ACP)", async () => {
    // No statusOverrides, issue stays in same state -> profile unchanged -> all turns run
    const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 3 } });

    const result = await runAgentAttempt({
      issue: fakeIssue({ state: "Todo" }),
      workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
      settings,
      fetchIssue: async (iss) => iss,
      adapters: fakeAdapters({
        executorFactory: () => ({
          kind: "codex",
          async startSession(input) {
            input.onUpdate?.({
              type: "session_started",
              message: "session started (s1)",
              sessionId: "s1",
            });
            return fakeSession();
          },
          async runTurn() {
            // Emit tool_use_requested so ACP loop continues
            return [fakeToolCallNotification(), { type: "turn_completed" }];
          },
        }),
      }),
    });

    assert.equal(result.turnCount, 3);
  });
});

describe("INVARIANT: When the turn count reaches the maximum, the system SHALL end the session.", () => {
  test("session ends when turn count reaches maxTurns (ACP)", async () => {
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
            input.onUpdate?.({
              type: "session_started",
              message: "session started (s1)",
              sessionId: "s1",
            });
            return fakeSession();
          },
          async runTurn(_session, prompt) {
            prompts.push(prompt);
            // Emit tool_use_requested so ACP loop continues
            return [fakeToolCallNotification(), { type: "turn_completed" }];
          },
        }),
      }),
    });

    assert.equal(result.turnCount, 2);
    assert.equal(prompts.length, 2);
  });

  test("session terminates at exactly maxTurns for arbitrary positive values (ACP)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 50 }), async (maxTurns) => {
        const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns } });

        const result = await runAgentAttempt({
          issue: fakeIssue(),
          workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
          settings,
          fetchIssue: async (iss) => iss,
          adapters: fakeAdapters({
            executorFactory: () => ({
              kind: "codex",
              async startSession(input) {
                input.onUpdate?.({
                  type: "session_started",
                  message: "session started (s1)",
                  sessionId: "s1",
                });
                return fakeSession();
              },
              async runTurn() {
                // Emit tool_use_requested so ACP loop continues
                return [fakeToolCallNotification(), { type: "turn_completed" }];
              },
            }),
          }),
        });

        assert.equal(result.turnCount, maxTurns);
      }),
      { numRuns: 20 },
    );
  });
});

describe("INVARIANT: When an agent run starts, the working directory SHALL be set to the validated workspace path.", () => {
  test("workspace path is passed to the executor session (ACP)", async () => {
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
            input.onUpdate?.({
              type: "session_started",
              message: "session started (s1)",
              sessionId: "s1",
            });
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

  test("result workspace matches the path from createWorkspaceForIssue (ACP)", async () => {
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

// ---------------------------------------------------------------------------
// ACP Executor: tool_use_requested break logic (production path)
// ---------------------------------------------------------------------------

describe("INVARIANT (ACP): The tool_use_requested check only gates continuation after turn 1 (turnCount > 1).", () => {
  test("ACP executor always completes turn 1 and breaks at turn 2 without tool_use_requested", async () => {
    const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 5 } });
    const prompts: string[] = [];

    const result = await runAgentAttempt({
      issue: fakeIssue(),
      workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
      settings,
      fetchIssue: async (iss) => iss,
      adapters: fakeAdapters({
        executorFactory: () => ({
          kind: "codex",
          async startSession(input) {
            input.onUpdate?.({
              type: "session_started",
              message: "session started (s1)",
              sessionId: "s1",
            });
            return fakeSession();
          },
          async runTurn(_session, prompt) {
            prompts.push(prompt);
            // No tool_use_requested update emitted
            return [{ type: "turn_completed" }];
          },
        }),
      }),
    });

    // Turn 1 proceeds (ACP break only applies after turn >1).
    // Turn 2 has no tool_use_requested -> break.
    assert.equal(result.turnCount, 2);
    assert.equal(prompts.length, 2);
  });

  test("without fetchIssue, ACP loop breaks after turn 1 regardless of tool_use_requested", async () => {
    const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 5 } });

    const result = await runAgentAttempt({
      issue: fakeIssue(),
      workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
      settings,
      // No fetchIssue -> loop breaks after first turn
      adapters: fakeAdapters({
        executorFactory: () => ({
          kind: "codex",
          async startSession(input) {
            input.onUpdate?.({
              type: "session_started",
              message: "session started (s1)",
              sessionId: "s1",
            });
            return fakeSession();
          },
          async runTurn() {
            return [{ type: "turn_completed" }];
          },
        }),
      }),
    });

    // The !fetchIssue break fires before the ACP check can apply on subsequent turns
    assert.equal(result.turnCount, 1);
  });
});

describe("INVARIANT (ACP): After turn 2+, the loop continues when tool_use_requested IS emitted.", () => {
  test("ACP executor continues past turn 2 when tool_use_requested is present", async () => {
    const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 4 } });
    const prompts: string[] = [];

    const result = await runAgentAttempt({
      issue: fakeIssue(),
      workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
      settings,
      fetchIssue: async (iss) => iss,
      adapters: fakeAdapters({
        executorFactory: () => ({
          kind: "codex",
          async startSession(input) {
            input.onUpdate?.({
              type: "session_started",
              message: "session started (s1)",
              sessionId: "s1",
            });
            return fakeSession();
          },
          async runTurn(_session, prompt) {
            prompts.push(prompt);
            // Emit tool_use_requested on every turn -> loop should not break
            return [fakeToolCallNotification(), { type: "turn_completed" }];
          },
        }),
      }),
    });

    // All 4 turns should run because tool_use_requested is always present
    assert.equal(result.turnCount, 4);
    assert.equal(prompts.length, 4);
  });

  test("ACP executor breaks at the turn where tool_use_requested stops appearing", async () => {
    const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 5 } });
    let turnCount = 0;

    const result = await runAgentAttempt({
      issue: fakeIssue(),
      workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
      settings,
      fetchIssue: async (iss) => iss,
      adapters: fakeAdapters({
        executorFactory: () => ({
          kind: "codex",
          async startSession(input) {
            input.onUpdate?.({
              type: "session_started",
              message: "session started (s1)",
              sessionId: "s1",
            });
            return fakeSession();
          },
          async runTurn() {
            turnCount += 1;
            // Emit tool_use_requested on turns 1-2, stop on turn 3
            if (turnCount <= 2) {
              return [fakeToolCallNotification(), { type: "turn_completed" }];
            }
            return [{ type: "turn_completed" }];
          },
        }),
      }),
    });

    // Turn 1: tool_use_requested present, continues (turn >1 check not triggered)
    // Turn 2: tool_use_requested present, continues
    // Turn 3: no tool_use_requested, breaks (turnCount > 1)
    assert.equal(result.turnCount, 3);
  });
});
