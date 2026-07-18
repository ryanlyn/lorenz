import { afterEach, vi, test } from "vitest";
import type {
  AgentExecutor,
  AgentSession,
  AgentUpdate,
  Issue,
  SessionNotification,
  Settings,
  TrackerIssueEvent,
} from "@lorenz/domain";
import { defaultSettings } from "@lorenz/config";
import { assert } from "@lorenz/test-utils";

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
      input.onUpdate?.({
        type: "session_started",
        message: `session started (${session.sessionId})`,
        sessionId: session.sessionId,
      });
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
    executorFactory: () => fakeExecutor(),
    ...overrides,
  };
}

test("live issue events are submitted immediately and consumed as the next queued turn", async () => {
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 3 } });
  const normalPrompts: string[] = [];
  const queuedPrompts: string[] = [];
  let issueEventListener: ((events: TrackerIssueEvent[]) => void) | undefined;
  let subscriptionClosed = false;
  let releaseFirstTurn: (() => void) | undefined;
  let markFirstTurnStarted: (() => void) | undefined;
  const firstTurnStarted = new Promise<void>((resolve) => {
    markFirstTurnStarted = resolve;
  });
  const firstTurnRelease = new Promise<void>((resolve) => {
    releaseFirstTurn = resolve;
  });
  const session = fakeSession({
    queueTurn: async (prompt) => {
      queuedPrompts.push(prompt);
      return [{ type: "turn_completed" }];
    },
  });
  const executor: AgentExecutor = {
    kind: "codex",
    async startSession() {
      return session;
    },
    async runTurn(_session, prompt) {
      normalPrompts.push(prompt);
      markFirstTurnStarted?.();
      await firstTurnRelease;
      return [{ type: "turn_completed" }];
    },
  };

  const attempt = runAgentAttempt({
    issue: fakeIssue(),
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async (issue) => issue,
    subscribeIssueEvents: (listener) => {
      issueEventListener = listener;
      return () => {
        subscriptionClosed = true;
      };
    },
    adapters: fakeAdapters({ executorFactory: () => executor }),
  });

  await firstTurnStarted;
  assert.ok(issueEventListener);
  issueEventListener([
    { ts: "9007199254740993", author: "ryan", text: "steer second" },
    { ts: "9007199254740992", author: "ryan", text: "steer first" },
  ]);
  await vi.waitFor(() => assert.equal(queuedPrompts.length, 1));
  assert.equal(releaseFirstTurn === undefined, false);
  assert.equal(normalPrompts.length, 1);
  releaseFirstTurn?.();

  const result = await attempt;
  assert.equal(result.turnCount, 2);
  assert.equal(normalPrompts.length, 1);
  assert.match(queuedPrompts[0]!, /<issue_messages>/);
  assert.ok(queuedPrompts[0]!.indexOf("steer first") < queuedPrompts[0]!.indexOf("steer second"));
  assert.notMatch(queuedPrompts[0]!, /Continuation guidance/);
  assert.equal(subscriptionClosed, true);
});

test("accepted steering runs before a fallible issue refresh", async () => {
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 2 } });
  const queuedPrompts: string[] = [];
  let issueEventListener: ((events: TrackerIssueEvent[]) => void) | undefined;
  let releaseFirstTurn: (() => void) | undefined;
  let markFirstTurnStarted: (() => void) | undefined;
  const firstTurnStarted = new Promise<void>((resolve) => {
    markFirstTurnStarted = resolve;
  });
  const firstTurnRelease = new Promise<void>((resolve) => {
    releaseFirstTurn = resolve;
  });
  let issueRefreshes = 0;
  const session = fakeSession({
    queueTurn: async (prompt) => {
      queuedPrompts.push(prompt);
      return [{ type: "turn_completed" }];
    },
  });
  const executor: AgentExecutor = {
    kind: "codex",
    async startSession() {
      return session;
    },
    async runTurn() {
      markFirstTurnStarted?.();
      await firstTurnRelease;
      return [{ type: "turn_completed" }];
    },
  };

  const attempt = runAgentAttempt({
    issue: fakeIssue(),
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async () => {
      issueRefreshes += 1;
      throw new Error("tracker unavailable");
    },
    subscribeIssueEvents: (listener) => {
      issueEventListener = listener;
      return () => {};
    },
    adapters: fakeAdapters({ executorFactory: () => executor }),
  });

  await firstTurnStarted;
  issueEventListener?.([{ ts: "11.0", author: "ryan", text: "finish this first" }]);
  await vi.waitFor(() => assert.equal(queuedPrompts.length, 1));
  releaseFirstTurn?.();

  const result = await attempt;
  assert.equal(result.turnCount, 2);
  assert.equal(issueRefreshes, 0);
  assert.match(queuedPrompts[0]!, /finish this first/);
});

test("steering accepted during a failed issue refresh still completes", async () => {
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 2 } });
  const queuedPrompts: string[] = [];
  const updates: AgentUpdate[] = [];
  let issueEventListener: ((events: TrackerIssueEvent[]) => void) | undefined;
  let markIssueRefreshStarted: (() => void) | undefined;
  let rejectIssueRefresh: ((error: Error) => void) | undefined;
  const issueRefreshStarted = new Promise<void>((resolve) => {
    markIssueRefreshStarted = resolve;
  });
  const issueRefresh = new Promise<Issue>((_resolve, reject) => {
    rejectIssueRefresh = reject;
  });
  const session = fakeSession({
    queueTurn: async (prompt) => {
      queuedPrompts.push(prompt);
      return [{ type: "turn_completed" }];
    },
  });

  const attempt = runAgentAttempt({
    issue: fakeIssue(),
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async () => {
      markIssueRefreshStarted?.();
      return issueRefresh;
    },
    subscribeIssueEvents: (listener) => {
      issueEventListener = listener;
      return () => {};
    },
    onUpdate: (update) => updates.push(update),
    adapters: fakeAdapters({
      executorFactory: () =>
        fakeExecutor({
          session: {
            queueTurn: session.queueTurn,
          },
        }),
    }),
  });

  await issueRefreshStarted;
  issueEventListener?.([{ ts: "11.0", author: "ryan", text: "accepted during refresh" }]);
  await vi.waitFor(() => assert.equal(queuedPrompts.length, 1));
  rejectIssueRefresh?.(new Error("tracker unavailable"));

  const result = await attempt;
  assert.equal(result.turnCount, 2);
  assert.ok(
    updates.some(
      (update) =>
        update.type === "stderr" &&
        update.message.includes("Ignoring steering issue refresh failure: tracker unavailable"),
    ),
  );
  assert.match(queuedPrompts[0]!, /accepted during refresh/);
});

test("a queued turn with streamed tool activity permits a continuation turn", async () => {
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 3 } });
  const normalPrompts: string[] = [];
  let issueEventListener: ((events: TrackerIssueEvent[]) => void) | undefined;
  let sessionOnUpdate: ((update: AgentUpdate) => void) | undefined;
  let releaseFirstTurn: (() => void) | undefined;
  let markFirstTurnStarted: (() => void) | undefined;
  const firstTurnStarted = new Promise<void>((resolve) => {
    markFirstTurnStarted = resolve;
  });
  const firstTurnRelease = new Promise<void>((resolve) => {
    releaseFirstTurn = resolve;
  });
  const toolUpdate: AgentUpdate = {
    type: "session_notification",
    message: { update: { sessionUpdate: "tool_call" } } as SessionNotification,
  };
  const session = fakeSession({
    queueTurn: async () => {
      await firstTurnRelease;
      sessionOnUpdate?.({ type: "turn_started", message: { prompt: [] } });
      sessionOnUpdate?.(toolUpdate);
      return [{ type: "turn_completed" }];
    },
  });
  const executor: AgentExecutor = {
    kind: "codex",
    async startSession(input) {
      sessionOnUpdate = input.onUpdate;
      return session;
    },
    async runTurn(_session, prompt) {
      normalPrompts.push(prompt);
      sessionOnUpdate?.({ type: "turn_started", message: { prompt: [] } });
      if (normalPrompts.length === 1) {
        markFirstTurnStarted?.();
        await firstTurnRelease;
      }
      return [{ type: "turn_completed" }];
    },
  };

  const attempt = runAgentAttempt({
    issue: fakeIssue(),
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async (issue) => issue,
    subscribeIssueEvents: (listener) => {
      issueEventListener = listener;
      return () => {};
    },
    adapters: fakeAdapters({ executorFactory: () => executor }),
  });

  await firstTurnStarted;
  issueEventListener?.([{ ts: "11.0", author: "ryan", text: "make the change" }]);
  releaseFirstTurn?.();

  const result = await attempt;
  assert.equal(result.turnCount, 3);
  assert.equal(normalPrompts.length, 2);
});

test("events observed during setup enter the queue after the initial turn starts", async () => {
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 2 } });
  const queuedPrompts: string[] = [];
  let issueEventListener: ((events: TrackerIssueEvent[]) => void) | undefined;
  let releaseWorkspace: (() => void) | undefined;
  const workspaceGate = new Promise<void>((resolve) => {
    releaseWorkspace = resolve;
  });
  const session = fakeSession({
    queueTurn: async (prompt) => {
      queuedPrompts.push(prompt);
      return [{ type: "turn_completed" }];
    },
  });

  const attempt = runAgentAttempt({
    issue: fakeIssue(),
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    subscribeIssueEvents: (listener) => {
      issueEventListener = listener;
      return () => {};
    },
    adapters: fakeAdapters({
      createWorkspaceForIssue: async () => {
        await workspaceGate;
        return "/tmp/workspace/TEST-1";
      },
      executorFactory: () =>
        fakeExecutor({
          session: {
            queueTurn: session.queueTurn,
          },
        }),
    }),
  });

  await vi.waitFor(() => assert.ok(issueEventListener));
  issueEventListener?.([{ ts: "11.0", author: "ryan", text: "during setup" }]);
  releaseWorkspace?.();

  const result = await attempt;
  assert.equal(result.turnCount, 2);
  assert.equal(queuedPrompts.length, 1);
  assert.match(queuedPrompts[0]!, /during setup/);
});

test("live delivery does not advance the recovery cursor past missed events", async () => {
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 3 } });
  const queuedPrompts: string[] = [];
  const recoveryCursors: string[] = [];
  let issueEventListener: ((events: TrackerIssueEvent[]) => void) | undefined;
  let releaseFirstTurn: (() => void) | undefined;
  let markFirstTurnStarted: (() => void) | undefined;
  const firstTurnStarted = new Promise<void>((resolve) => {
    markFirstTurnStarted = resolve;
  });
  const firstTurnRelease = new Promise<void>((resolve) => {
    releaseFirstTurn = resolve;
  });
  const session = fakeSession({
    queueTurn: async (prompt) => {
      queuedPrompts.push(prompt);
      return [{ type: "turn_completed" }];
    },
  });
  const executor: AgentExecutor = {
    kind: "codex",
    async startSession() {
      return session;
    },
    async runTurn() {
      markFirstTurnStarted?.();
      await firstTurnRelease;
      return [{ type: "turn_completed" }];
    },
  };

  const attempt = runAgentAttempt({
    issue: fakeIssue({ issueEventCursor: "10.0" }),
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async (issue) => issue,
    fetchIssueEvents: async (sinceTs) => {
      recoveryCursors.push(sinceTs);
      if (sinceTs === "10.0") {
        return [
          { ts: "11.0", author: "ryan", text: "missed event" },
          { ts: "12.0", author: "ryan", text: "live event" },
        ];
      }
      return [];
    },
    subscribeIssueEvents: (listener) => {
      issueEventListener = listener;
      return () => {};
    },
    adapters: fakeAdapters({ executorFactory: () => executor }),
  });

  await firstTurnStarted;
  assert.ok(issueEventListener);
  issueEventListener?.([{ ts: "12.0", author: "ryan", text: "live event" }]);
  await vi.waitFor(() => assert.equal(queuedPrompts.length, 1));
  releaseFirstTurn?.();

  const result = await attempt;
  assert.equal(result.turnCount, 3);
  assert.deepEqual(recoveryCursors, ["10.0"]);
  assert.match(queuedPrompts[0]!, /live event/);
  assert.notMatch(queuedPrompts[0]!, /missed event/);
  assert.match(queuedPrompts[1]!, /missed event/);
  assert.notMatch(queuedPrompts[1]!, /live event/);
});

test("recovery can queue a missed event before the no-tool completion exit", async () => {
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 3 } });
  const feedCursors: string[] = [];
  const queuedPrompts: string[] = [];
  const session = fakeSession({
    queueTurn: async (prompt) => {
      queuedPrompts.push(prompt);
      return [{ type: "turn_completed" }];
    },
  });

  const result = await runAgentAttempt({
    issue: fakeIssue({ issueEventCursor: "10.0" }),
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async (issue) => issue,
    fetchIssueEvents: async (sinceTs) => {
      feedCursors.push(sinceTs);
      return feedCursors.length === 2
        ? [{ ts: "11.0", author: "ryan", text: "missed during turn" }]
        : [];
    },
    adapters: fakeAdapters({
      executorFactory: () =>
        fakeExecutor({
          session: {
            queueTurn: session.queueTurn,
          },
        }),
    }),
  });

  assert.equal(result.turnCount, 3);
  assert.deepEqual(feedCursors, ["10.0", "10.0"]);
  assert.equal(queuedPrompts.length, 1);
  assert.match(queuedPrompts[0]!, /missed during turn/);
});

test("no-tool completion does not refresh the issue when recovery is unavailable", async () => {
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 3 } });
  let issueRefreshes = 0;

  const result = await runAgentAttempt({
    issue: fakeIssue(),
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async (issue) => {
      issueRefreshes += 1;
      return issue;
    },
    adapters: fakeAdapters(),
  });

  assert.equal(result.turnCount, 2);
  assert.equal(issueRefreshes, 1);
});

test("a state override can add turn capacity for steering recovery", async () => {
  const overrides = new Map<string, { agent?: Partial<Settings["agent"]> }>();
  overrides.set("in progress", { agent: { maxTurns: 3 } });
  const settings = fakeSettings({
    agent: { ...defaultSettings().agent, maxTurns: 1 },
    statusOverrides: overrides as Settings["statusOverrides"],
  });
  const feedCursors: string[] = [];
  const queuedPrompts: string[] = [];
  const session = fakeSession({
    queueTurn: async (prompt) => {
      queuedPrompts.push(prompt);
      return [{ type: "turn_completed" }];
    },
  });

  const result = await runAgentAttempt({
    issue: fakeIssue({ issueEventCursor: "10.0" }),
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async (issue) => ({ ...issue, state: "In Progress" }),
    fetchIssueEvents: async (sinceTs) => {
      feedCursors.push(sinceTs);
      return sinceTs === "10.0"
        ? [{ ts: "11.0", author: "ryan", text: "recovered after transition" }]
        : [];
    },
    adapters: fakeAdapters({
      executorFactory: () =>
        fakeExecutor({
          session: {
            queueTurn: session.queueTurn,
          },
        }),
    }),
  });

  assert.equal(result.turnCount, 2);
  assert.deepEqual(feedCursors, ["10.0", "11.0"]);
  assert.equal(queuedPrompts.length, 1);
  assert.match(queuedPrompts[0]!, /recovered after transition/);
});

test("a state override can add turn capacity for a buffered live event", async () => {
  const overrides = new Map<string, { agent?: Partial<Settings["agent"]> }>();
  overrides.set("in progress", { agent: { maxTurns: 2 } });
  const settings = fakeSettings({
    agent: { ...defaultSettings().agent, maxTurns: 1 },
    statusOverrides: overrides as Settings["statusOverrides"],
  });
  const queuedPrompts: string[] = [];
  let issueEventListener: ((events: TrackerIssueEvent[]) => void) | undefined;
  let releaseFirstTurn: (() => void) | undefined;
  let markFirstTurnStarted: (() => void) | undefined;
  const firstTurnStarted = new Promise<void>((resolve) => {
    markFirstTurnStarted = resolve;
  });
  const firstTurnRelease = new Promise<void>((resolve) => {
    releaseFirstTurn = resolve;
  });
  const session = fakeSession({
    queueTurn: async (prompt) => {
      queuedPrompts.push(prompt);
      return [{ type: "turn_completed" }];
    },
  });
  const executor: AgentExecutor = {
    kind: "codex",
    async startSession() {
      return session;
    },
    async runTurn() {
      markFirstTurnStarted?.();
      await firstTurnRelease;
      return [{ type: "turn_completed" }];
    },
  };

  const attempt = runAgentAttempt({
    issue: fakeIssue(),
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async (issue) => ({ ...issue, state: "In Progress" }),
    subscribeIssueEvents: (listener) => {
      issueEventListener = listener;
      return () => {};
    },
    adapters: fakeAdapters({ executorFactory: () => executor }),
  });

  await firstTurnStarted;
  issueEventListener?.([{ ts: "11.0", author: "ryan", text: "use the new capacity" }]);
  assert.equal(queuedPrompts.length, 0);
  releaseFirstTurn?.();

  const result = await attempt;
  assert.equal(result.turnCount, 2);
  assert.equal(queuedPrompts.length, 1);
  assert.match(queuedPrompts[0]!, /use the new capacity/);
});

test("sessions without queued turns do not start issue event recovery", async () => {
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 1 } });
  let feedCalls = 0;
  let subscriptionClosed = false;

  const result = await runAgentAttempt({
    issue: fakeIssue({ issueEventCursor: "10.0" }),
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async (issue) => issue,
    fetchIssueEvents: async () => {
      feedCalls += 1;
      return never<TrackerIssueEvent[]>();
    },
    subscribeIssueEvents: () => () => {
      subscriptionClosed = true;
    },
    adapters: fakeAdapters(),
  });

  assert.equal(result.turnCount, 1);
  assert.equal(feedCalls, 0);
  assert.equal(subscriptionClosed, true);
});

test("run cancellation aborts an active steering recovery request", async () => {
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 3 } });
  const controller = new AbortController();
  let markFeedStarted: (() => void) | undefined;
  const feedStarted = new Promise<void>((resolve) => {
    markFeedStarted = resolve;
  });
  let feedSignal: AbortSignal | undefined;
  let feedCalls = 0;
  const session = fakeSession({
    queueTurn: async () => [{ type: "turn_completed" }],
  });

  const attempt = runAgentAttempt({
    issue: fakeIssue({ issueEventCursor: "10.0" }),
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async (issue) => issue,
    fetchIssueEvents: async (_sinceTs, abortSignal) => {
      feedCalls += 1;
      if (feedCalls === 1) return [];
      feedSignal = abortSignal;
      markFeedStarted?.();
      return new Promise<TrackerIssueEvent[]>((_resolve, reject) => {
        abortSignal?.addEventListener(
          "abort",
          () => reject(abortSignal.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    },
    abortSignal: controller.signal,
    adapters: fakeAdapters({
      executorFactory: () =>
        fakeExecutor({
          session: {
            queueTurn: session.queueTurn,
          },
        }),
    }),
  });

  await feedStarted;
  controller.abort();

  await assert.rejects(() => attempt, /agent_run_aborted/);
  assert.equal(feedCalls, 2);
  assert.equal(feedSignal?.aborted, true);
});

test("run cancellation stops queued ACP work during an issue refresh", async () => {
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, maxTurns: 2 } });
  const controller = new AbortController();
  let issueEventListener: ((events: TrackerIssueEvent[]) => void) | undefined;
  let releaseFirstTurn: (() => void) | undefined;
  let markFirstTurnStarted: (() => void) | undefined;
  let releaseIssueRefresh: (() => void) | undefined;
  let markIssueRefreshStarted: (() => void) | undefined;
  let markSessionStopped: (() => void) | undefined;
  let markQueuedTurnSubmitted: (() => void) | undefined;
  const firstTurnStarted = new Promise<void>((resolve) => {
    markFirstTurnStarted = resolve;
  });
  const firstTurnRelease = new Promise<void>((resolve) => {
    releaseFirstTurn = resolve;
  });
  const issueRefreshStarted = new Promise<void>((resolve) => {
    markIssueRefreshStarted = resolve;
  });
  const issueRefreshRelease = new Promise<void>((resolve) => {
    releaseIssueRefresh = resolve;
  });
  const sessionStopped = new Promise<void>((resolve) => {
    markSessionStopped = resolve;
  });
  const queuedTurnSubmitted = new Promise<void>((resolve) => {
    markQueuedTurnSubmitted = resolve;
  });
  let stopCalls = 0;
  const session = fakeSession({
    queueTurn: async () => {
      markQueuedTurnSubmitted?.();
      return never<AgentUpdate[]>();
    },
    stop: async () => {
      stopCalls += 1;
      markSessionStopped?.();
    },
  });
  const executor: AgentExecutor = {
    kind: "codex",
    async startSession() {
      return session;
    },
    async runTurn() {
      markFirstTurnStarted?.();
      await firstTurnRelease;
      return [{ type: "turn_completed" }];
    },
  };

  const attempt = runAgentAttempt({
    issue: fakeIssue(),
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async (issue) => {
      markIssueRefreshStarted?.();
      await issueRefreshRelease;
      return issue;
    },
    subscribeIssueEvents: (listener) => {
      issueEventListener = listener;
      return () => {};
    },
    abortSignal: controller.signal,
    adapters: fakeAdapters({ executorFactory: () => executor }),
  });

  await firstTurnStarted;
  releaseFirstTurn?.();
  await issueRefreshStarted;
  issueEventListener?.([{ ts: "11.0", author: "ryan", text: "queued work" }]);
  await queuedTurnSubmitted;
  controller.abort();
  await sessionStopped;

  assert.equal(stopCalls, 1);
  releaseIssueRefresh?.();
  await assert.rejects(() => attempt, /agent_run_aborted/);
  assert.equal(stopCalls, 1);
});

test("a non-settling steering recovery feed is bounded by the agent timeout", async () => {
  const baseSettings = fakeSettingsWithTimeouts({ setupTimeoutMs: 20 });
  const settings: Settings = {
    ...baseSettings,
    agent: { ...baseSettings.agent, maxTurns: 2 },
  };
  const updates: AgentUpdate[] = [];
  let feedCalls = 0;
  const session = fakeSession({
    queueTurn: async () => [{ type: "turn_completed" }],
  });

  const result = await runAgentAttempt({
    issue: fakeIssue({ issueEventCursor: "10.0" }),
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async (issue) => issue,
    fetchIssueEvents: async () => {
      feedCalls += 1;
      return never<TrackerIssueEvent[]>();
    },
    onUpdate: (update) => updates.push(update),
    adapters: fakeAdapters({
      executorFactory: () =>
        fakeExecutor({
          session: {
            queueTurn: session.queueTurn,
          },
        }),
    }),
  });

  assert.equal(result.turnCount, 2);
  assert.equal(feedCalls, 1);
  assert.ok(
    updates.some(
      (update) =>
        update.type === "stderr" &&
        update.message.includes("tracker.fetch_issue_events timed out after 20ms"),
    ),
  );
});

function fakeSettingsWithTimeouts(
  opts: {
    setupTimeoutMs?: number | undefined;
    hookTimeoutMs?: number | undefined;
    hooks?: Partial<Settings["hooks"]> | undefined;
  } = {},
): Settings {
  const settings = fakeSettings();
  const agentConfig = settings.agents[settings.agent.kind]!;
  return {
    ...settings,
    agents: {
      ...settings.agents,
      [settings.agent.kind]: {
        ...agentConfig,
        stallTimeoutMs: opts.setupTimeoutMs ?? agentConfig.stallTimeoutMs,
      },
    },
    hooks: {
      ...settings.hooks,
      timeoutMs: opts.hookTimeoutMs ?? settings.hooks.timeoutMs,
      ...opts.hooks,
    },
  };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

type PromiseState<T> =
  | { status: "pending" }
  | { status: "resolved"; value: T }
  | { status: "rejected"; error: unknown };

type SettledPromiseState<T> = Exclude<PromiseState<T>, { status: "pending" }>;

function observePromise<T>(promise: Promise<T>): Promise<SettledPromiseState<T>> {
  return promise.then(
    (value) => ({ status: "resolved", value }) as const,
    (error: unknown) => ({ status: "rejected", error }) as const,
  );
}

async function observedPromiseState<T>(
  observed: Promise<SettledPromiseState<T>>,
): Promise<PromiseState<T>> {
  return Promise.race([observed, Promise.resolve({ status: "pending" } as const)]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertRejected(state: PromiseState<unknown>, expected: string | RegExp): void {
  assert.equal(state.status, "rejected");
  if (state.status === "rejected") assert.match(errorMessage(state.error), expected);
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// runAgentAttempt
// ---------------------------------------------------------------------------

test("runAgentAttempt returns success result on normal completion", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();
  const streamed: AgentUpdate[] = [];
  const result = await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix {{issue.title}}", settings },
    settings,
    onUpdate: (update) => streamed.push(update),
    adapters: fakeAdapters(),
  });

  assert.equal(result.workspace, "/tmp/workspace/TEST-1");
  assert.equal(result.turnCount, 1);
  assert.equal(result.agentKind, "codex");
  assert.ok(streamed.length > 0);
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

  let turnEntered = false;
  let stopped = false;
  const slowExecutor: AgentExecutor = {
    kind: "codex",
    async startSession(input) {
      const session = fakeSession({
        stop: async () => {
          stopped = true;
        },
      });
      input.onUpdate?.({
        type: "session_started",
        message: `session started (${session.sessionId})`,
        sessionId: session.sessionId,
      });
      return session;
    },
    async runTurn() {
      turnEntered = true;
      return new Promise(() => {});
    },
  };

  const promise = runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    abortSignal: ac.signal,
    adapters: fakeAdapters({ executorFactory: () => slowExecutor }),
  });

  await vi.waitFor(() => assert.equal(turnEntered, true));
  ac.abort();

  await assert.rejects(() => promise, "agent_run_aborted");
  assert.equal(stopped, true);
});

test("runAgentAttempt times out a hung workspace creation stage", async () => {
  vi.useFakeTimers();
  const issue = fakeIssue();
  const settings = fakeSettingsWithTimeouts({ setupTimeoutMs: 50 });

  const promise = runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      createWorkspaceForIssue: async () => never(),
    }),
  });
  const observed = observePromise(promise);

  await vi.advanceTimersByTimeAsync(50);

  assertRejected(
    await observedPromiseState(observed),
    /agent_runner_timeout.*workspace\.create_for_issue.*50/,
  );
});

test("runAgentAttempt cancels workspace creation when setup timeout fires", async () => {
  vi.useFakeTimers();
  const issue = fakeIssue();
  const settings = fakeSettingsWithTimeouts({ setupTimeoutMs: 50 });
  let markerWritten = false;
  let signalSeen = false;

  const promise = runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      createWorkspaceForIssue: async (_settings, _issue, options) => {
        const signal = (options as typeof options & { abortSignal?: AbortSignal }).abortSignal;
        signalSeen = signal instanceof AbortSignal;
        return new Promise<string>((resolve, reject) => {
          // eslint-disable-next-line no-restricted-syntax -- cancellable timer under fake-timer control (vi.advanceTimersByTimeAsync below); the test asserts abort clears it, so this is not a wall-clock sleep.
          const markerTimer = setTimeout(() => {
            markerWritten = true;
            resolve("/tmp/workspace/TEST-1");
          }, 100);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(markerTimer);
              reject(new Error("workspace setup canceled"));
            },
            { once: true },
          );
        });
      },
    }),
  });
  const observed = observePromise(promise);

  await vi.advanceTimersByTimeAsync(50);

  assertRejected(
    await observedPromiseState(observed),
    /agent_runner_timeout.*workspace\.create_for_issue.*50/,
  );

  await vi.advanceTimersByTimeAsync(100);

  assert.equal(signalSeen, true);
  assert.equal(markerWritten, false);
});

test("runAgentAttempt reports setup adapter crashes with the setup stage", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();

  await assert.rejects(
    () =>
      runAgentAttempt({
        issue,
        workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
        settings,
        adapters: fakeAdapters({
          createWorkspaceForIssue: async () => {
            throw new Error("adapter exploded");
          },
        }),
      }),
    /agent_runner_setup_crashed.*workspace\.create_for_issue.*adapter exploded/,
  );
});

test("runAgentAttempt times out a hung beforeRun setup stage", async () => {
  vi.useFakeTimers();
  const issue = fakeIssue();
  const settings = fakeSettingsWithTimeouts({
    hookTimeoutMs: 50,
    hooks: { beforeRun: "setup" },
  });

  const promise = runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      runHook: async () => never(),
    }),
  });
  const observed = observePromise(promise);

  await vi.advanceTimersByTimeAsync(1050);

  assertRejected(
    await observedPromiseState(observed),
    /agent_runner_timeout.*workspace\.run_before_run_hook.*1050/,
  );
});

test("runAgentAttempt cancels beforeRun hook when setup timeout fires", async () => {
  vi.useFakeTimers();
  const issue = fakeIssue();
  const settings = fakeSettingsWithTimeouts({
    hookTimeoutMs: 50,
    hooks: { beforeRun: "setup" },
  });
  let markerWritten = false;
  let signalSeen = false;

  const promise = runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      runHook: async (
        _command,
        _workspace,
        _hooks,
        _workerHost,
        options?: { abortSignal?: AbortSignal },
      ) => {
        const signal = options?.abortSignal;
        signalSeen = signal instanceof AbortSignal;
        return new Promise<void>((resolve, reject) => {
          // eslint-disable-next-line no-restricted-syntax -- cancellable timer under fake-timer control (vi.advanceTimersByTimeAsync below); the test asserts abort clears it, so this is not a wall-clock sleep.
          const markerTimer = setTimeout(() => {
            markerWritten = true;
            resolve();
          }, 1_100);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(markerTimer);
              reject(new Error("hook setup canceled"));
            },
            { once: true },
          );
        });
      },
    }),
  });
  const observed = observePromise(promise);

  await vi.advanceTimersByTimeAsync(1_050);

  assertRejected(
    await observedPromiseState(observed),
    /agent_runner_timeout.*workspace\.run_before_run_hook.*1050/,
  );

  await vi.advanceTimersByTimeAsync(1_100);

  assert.equal(signalSeen, true);
  assert.equal(markerWritten, false);
});

test("runAgentAttempt times out afterRun and emits a cleanup warning", async () => {
  vi.useFakeTimers();
  const issue = fakeIssue();
  const settings = fakeSettingsWithTimeouts({
    hookTimeoutMs: 50,
    hooks: { afterRun: "cleanup" },
  });
  const received: AgentUpdate[] = [];

  const promise = runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    onUpdate: (update) => received.push(update),
    adapters: fakeAdapters({
      runHook: async () => never(),
    }),
  });
  const observed = observePromise(promise);

  await vi.advanceTimersByTimeAsync(1050);

  const state = await observedPromiseState(observed);
  assert.equal(state.status, "resolved");
  assert.ok(
    received.some(
      (update) =>
        update.type === "stderr" &&
        update.message.includes("Ignoring after_run hook failure") &&
        update.message.includes("workspace.run_after_run_hook") &&
        update.message.includes("agent_runner_timeout"),
    ),
  );
});

test("runAgentAttempt emits a cleanup warning when afterRun fails", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings({
    hooks: { ...defaultSettings().hooks, afterRun: "cleanup" },
  });
  const received: AgentUpdate[] = [];

  await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    onUpdate: (update) => received.push(update),
    adapters: fakeAdapters({
      runHook: async () => {
        throw new Error("cleanup exploded");
      },
    }),
  });

  assert.ok(
    received.some(
      (update) =>
        update.type === "stderr" &&
        update.message.includes("Ignoring after_run hook failure") &&
        update.message.includes("workspace.run_after_run_hook") &&
        update.message.includes("cleanup exploded"),
    ),
  );
});

test("runAgentAttempt runs afterRun when beforeRun fails after workspace creation", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings({
    hooks: { ...defaultSettings().hooks, beforeRun: "setup", afterRun: "cleanup" },
  });
  const commands: string[] = [];

  await assert.rejects(
    () =>
      runAgentAttempt({
        issue,
        workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
        settings,
        adapters: fakeAdapters({
          runHook: async (command) => {
            commands.push(command);
            if (command === "setup") throw new Error("setup failed");
          },
        }),
      }),
    "setup failed",
  );

  assert.deepEqual(commands, ["setup", "cleanup"]);
});

test("runAgentAttempt runs afterRun when startSession fails after workspace creation", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings({
    hooks: { ...defaultSettings().hooks, afterRun: "cleanup" },
  });
  const commands: string[] = [];

  await assert.rejects(
    () =>
      runAgentAttempt({
        issue,
        workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
        settings,
        adapters: fakeAdapters({
          runHook: async (command) => {
            commands.push(command);
          },
          executorFactory: () => ({
            kind: "codex",
            async startSession() {
              throw new Error("start failed");
            },
            async runTurn() {
              return [{ type: "turn_completed" }];
            },
          }),
        }),
      }),
    "start failed",
  );

  assert.deepEqual(commands, ["cleanup"]);
});

test("runAgentAttempt forwards a threaded mcpEndpoint into executor.startSession", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();
  const lease = {
    url: "http://127.0.0.1:46999/claude-mcp",
    token: "threaded",
    generation: 1,
    acpServer: () => ({ type: "http" as const, name: "threaded_endpoint", url: "", headers: [] }),
    release: async () => {},
  };
  let received: unknown = "unset";

  await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    mcpEndpoint: lease,
    adapters: fakeAdapters({
      executorFactory: () => ({
        kind: "codex",
        async startSession(input) {
          received = (input as { mcpEndpoint?: unknown }).mcpEndpoint;
          return fakeSession();
        },
        async runTurn() {
          return [{ type: "turn_completed" }];
        },
      }),
    }),
  });

  assert.equal(received, lease);
});

test("runAgentAttempt threads null mcpEndpoint when none is supplied (local path)", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings();
  let received: unknown = "unset";

  await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      executorFactory: () => ({
        kind: "codex",
        async startSession(input) {
          received = (input as { mcpEndpoint?: unknown }).mcpEndpoint;
          return fakeSession();
        },
        async runTurn() {
          return [{ type: "turn_completed" }];
        },
      }),
    }),
  });

  assert.equal(received, null);
});

// ---------------------------------------------------------------------------
// executorFor
// ---------------------------------------------------------------------------

test("runAgentAttempt invokes executorFactory with resolved settings and reports agentKind from settings", async () => {
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

  // Verify executorFactory received the correct settings including agent kind
  assert.ok(factoryCalledWith);
  assert.equal(factoryCalledWith!.agent.kind, "codex");
  // Result agentKind comes from settings.agent.kind, not from executor session
  assert.equal(result.agentKind, "codex");
});

test("runAgentAttempt passes claude agent kind settings to executorFactory and returns it in result", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings({ agent: { ...defaultSettings().agent, kind: "claude" } });
  let factoryCalledWith: Settings | null = null;

  const result = await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    adapters: fakeAdapters({
      executorFactory: (s) => {
        factoryCalledWith = s;
        return fakeExecutor({ session: { agentKind: "claude" } });
      },
    }),
  });

  // Verify executorFactory received settings with claude agent kind
  assert.ok(factoryCalledWith);
  assert.equal(factoryCalledWith!.agent.kind, "claude");
  // Result agentKind reflects the settings.agent.kind value
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

test("runAgentAttempt emits hook execution updates from beforeRun hooks", async () => {
  const issue = fakeIssue();
  const settings = fakeSettings({
    hooks: { ...defaultSettings().hooks, beforeRun: "echo setup" },
  });
  const received: AgentUpdate[] = [];

  await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    onUpdate: (update) => received.push(update),
    adapters: fakeAdapters({
      runHook: async (command, workspace, _hooks, _workerHost, options) => {
        options?.onHookEvent?.({
          status: "started",
          command,
          cwd: workspace,
          hookName: options.hookName,
        });
        options?.onHookEvent?.({
          status: "completed",
          command,
          cwd: workspace,
          hookName: options.hookName,
          exitCode: 0,
          output: "setup ok",
          outputTruncated: false,
        });
      },
    }),
  });

  const hookUpdates = received.filter(
    (update): update is Extract<AgentUpdate, { type: "hook_execution" }> =>
      update.type === "hook_execution",
  );
  assert.deepEqual(
    hookUpdates.map((update) => update.message.status),
    ["started", "completed"],
  );
  assert.equal(hookUpdates[0]!.message.hookName, "before_run");
  assert.equal(hookUpdates[0]!.workspacePath, "/tmp/workspace/TEST-1");
  assert.equal(hookUpdates[1]!.message.exitCode, 0);
  assert.equal(hookUpdates[1]!.message.output, "setup ok");
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
          input.onUpdate?.({
            type: "session_started",
            message: "session started (s1)",
            sessionId: "s1",
          });
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
  const streamed: AgentUpdate[] = [];

  const result = await runAgentAttempt({
    issue,
    workflow: { path: "/workflow.md", config: {}, promptTemplate: "Fix it", settings },
    settings,
    fetchIssue: async (iss) => iss,
    onUpdate: (update) => streamed.push(update),
    adapters: fakeAdapters({
      executorFactory: () => ({
        kind: "codex",
        async startSession(input) {
          sessionOnUpdate = input.onUpdate;
          input.onUpdate?.({
            type: "session_started",
            message: "session started (s1)",
            sessionId: "s1",
          });
          return fakeSession();
        },
        async runTurn() {
          turnNumber += 1;
          const usageUpdate: AgentUpdate = {
            type: "session_notification",
            message: {} as SessionNotification,
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

  // The controller runs at least one turn and streams updates through onUpdate
  assert.ok(result.turnCount >= 1);
  const usageUpdates = streamed.filter((u) => u.type === "session_notification" && u.usage);
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
