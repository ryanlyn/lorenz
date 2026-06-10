import fs from "node:fs/promises";
import path from "node:path";

import { test, vi } from "vitest";
import {
  createDispatchCoordinator,
  createWorkspaceForIssue,
  loadWorkflow,
  normalizeIssue,
  Orchestrator,
  parseConfig,
  runtimeAdapters,
  slotKey,
} from "@symphony/cli";
import {
  RUNTIME_EVENT_TYPES as RUNTIME_EVENT_TYPES_FROM_RUNTIME_EVENTS,
  RUNTIME_RUN_OUTCOMES as RUNTIME_RUN_OUTCOMES_FROM_RUNTIME_EVENTS,
} from "@symphony/runtime-events";
import type {
  Issue,
  McpEndpointManager,
  RunResult,
  Settings,
  SymphonyRuntimeOptions,
  WorkflowDefinition,
} from "@symphony/cli";
import type { BoxPoolSettings } from "@symphony/domain";
import type { AgentMcpEndpointLease } from "@symphony/mcp";
import type { AcquireResult, BoxLease, BoxOutcome, BoxPool } from "@symphony/worker-box-pool";

import { assert } from "../../../test/assert.js";
import { tempDir, writeExecutable } from "../../../test/helpers.js";

import {
  RUNTIME_EVENT_TYPES as RUNTIME_EVENT_TYPES_FROM_RUNTIME,
  RUNTIME_RUN_OUTCOMES as RUNTIME_RUN_OUTCOMES_FROM_RUNTIME,
  SymphonyRuntime,
} from "@symphony/runtime";

function runtimeOptions(options: SymphonyRuntimeOptions): SymphonyRuntimeOptions {
  return { ...runtimeAdapters, ...options };
}

test("runtime exports canonical runtime-events vocabulary values", () => {
  assert.equal(RUNTIME_EVENT_TYPES_FROM_RUNTIME, RUNTIME_EVENT_TYPES_FROM_RUNTIME_EVENTS);
  assert.equal(RUNTIME_RUN_OUTCOMES_FROM_RUNTIME, RUNTIME_RUN_OUTCOMES_FROM_RUNTIME_EVENTS);
});

test("runtime dry-run polls, computes eligibility, and does not start agents", async () => {
  const issue = issueFixture("issue-1", "MT-1");
  let runnerCalls = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        throw new Error("dry-run should not call runner");
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true, waitForRuns: true });

  const snapshot = runtime.snapshot();
  assert.equal(runnerCalls, 0);
  assert.equal(snapshot.poll.candidates, 1);
  assert.equal(snapshot.poll.eligible, 1);
  assert.equal(snapshot.recentEvents.at(-1)?.type, "dry_run");
});

test("runtime once claims an eligible issue, applies updates, and records completion", async () => {
  const issue = issueFixture("issue-1", "MT-1");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => {
          fetches += 1;
          return fetches === 1 ? [issue] : [doneIssue];
        },
      },
      runner: async ({ onUpdate }) => {
        onUpdate?.({
          type: "turn_completed",
          sessionId: "session-1",
          resumeId: "resume-1",
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
        });
        return {
          workspace: "/tmp/symphony/MT-1",
          turnCount: 1,
          updates: [],
          resumeId: "resume-1",
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );
  let fetches = 0;

  await runtime.start({ once: true, dryRun: false });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.appStatus, "idle");
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.runHistory[0]?.issueIdentifier, "MT-1");
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(snapshot.usageTotals.totalTokens, 10);
});

test("runtime schedules continuation retry after normal worker exit even when issue is inactive", async () => {
  const issue = issueFixture("issue-inactive-continuation", "MT-INACTIVE-CONTINUATION");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/symphony/MT-INACTIVE-CONTINUATION",
        turnCount: 1,
        updates: [],
        resumeId: "resume-inactive",
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  const beforeRun = Date.now();
  await runtime.pollOnce({ waitForRuns: true });

  const retry = runtime.snapshot().retrying[0];
  assert.ok(retry);
  assert.equal(retry.issueIdentifier, "MT-INACTIVE-CONTINUATION");
  assert.equal(retry.attempt, 1);
  const delayMs = new Date(retry.dueAtIso).getTime() - beforeRun;
  assert.ok(delayMs >= 900 && delayMs <= 1_500);
});

test("runtime refetches before dispatch and skips stale or missing issues", async () => {
  const staleIssue = issueFixture("issue-stale", "MT-STALE");
  const missingIssue = issueFixture("issue-missing", "MT-MISSING");
  const staleDoneIssue: Issue = { ...staleIssue, state: "Done", stateType: "completed" };
  let runnerCalls = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [staleIssue, missingIssue],
        fetchIssuesByIds: async (ids) => {
          if (ids.includes(staleIssue.id)) return [staleDoneIssue];
          return [];
        },
      },
      runner: async () => {
        runnerCalls += 1;
        throw new Error("stale candidates should not dispatch");
      },
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });

  const snapshot = runtime.snapshot();
  assert.equal(runnerCalls, 0);
  assert.equal(snapshot.runHistory.length, 0);
  assert.equal(
    snapshot.recentEvents.some((event) => event.message.includes("MT-STALE stale_before_dispatch")),
    true,
  );
  assert.equal(
    snapshot.recentEvents.some((event) =>
      event.message.includes("MT-MISSING missing_before_dispatch"),
    ),
    true,
  );
});

test("runtime reloads workflow settings on each poll with last-known-good fallback", async () => {
  const issue = issueFixture("issue-reload", "MT-RELOAD");
  const firstWorkflow = workflowFixture();
  const secondWorkflow = {
    ...workflowFixture(),
    settings: parseConfig({
      tracker: {
        kind: "linear",
        api_key: "linear-token",
        project_slug: "mono",
        active_states: ["Todo"],
        terminal_states: ["Done"],
        dispatch: { accept_unrouted: false },
      },
      polling: { interval_ms: 5 },
    }),
  };
  let reloads = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      reloadWorkflow: async () => {
        reloads += 1;
        if (reloads === 1) return secondWorkflow;
        throw new Error("workflow parse failed");
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        throw new Error("reload should make unrouted issue ineligible");
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });
  assert.equal(runtime.snapshot().poll.eligible, 0);
  assert.equal(runtime.workflow.settings.tracker.dispatch.acceptUnrouted, false);

  await runtime.pollOnce({ dryRun: true });
  assert.equal(reloads, 2);
  assert.equal(runtime.workflow.settings.tracker.dispatch.acceptUnrouted, false);
  assert.ok(
    runtime.snapshot().recentEvents.some((event) => event.type === "workflow_reload_failed"),
  );
});

test("runtime skips reload side effects when workflow content is unchanged", async () => {
  const issue = issueFixture("issue-unchanged-reload", "MT-UNCHANGED-RELOAD");
  const dir = await tempDir("symphony-runtime-unchanged-workflow");
  const workflowFile = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowFile, workflowMarkdown({ intervalMs: 5 }));
  const workflow = await loadWorkflow(workflowFile, {}, { cwd: dir });
  let reloads = 0;
  let clientBuilds = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      reloadWorkflow: async () => {
        reloads += 1;
        return loadWorkflow(workflowFile, {}, { cwd: dir });
      },
      clientFactory: () => {
        clientBuilds += 1;
        return {
          fetchCandidateIssues: async () => [issue],
          fetchIssuesByIds: async () => [issue],
        };
      },
      runner: async () => {
        throw new Error("dry-run should not call runner");
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });
  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 0);
  assert.equal(clientBuilds, 1);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "workflow_reloaded"),
    false,
  );
});

test("runtime reloads stamped workflow when file content changes", async () => {
  const issue = issueFixture("issue-changed-reload", "MT-CHANGED-RELOAD");
  const dir = await tempDir("symphony-runtime-changed-workflow");
  const workflowFile = path.join(dir, "WORKFLOW.md");
  await fs.writeFile(workflowFile, workflowMarkdown({ intervalMs: 5 }));
  const workflow = await loadWorkflow(workflowFile, {}, { cwd: dir });
  let reloads = 0;
  let clientBuilds = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      reloadWorkflow: async () => {
        reloads += 1;
        return loadWorkflow(workflowFile, {}, { cwd: dir });
      },
      clientFactory: () => {
        clientBuilds += 1;
        return {
          fetchCandidateIssues: async () => [issue],
          fetchIssuesByIds: async () => [issue],
        };
      },
      runner: async () => {
        throw new Error("dry-run should not call runner");
      },
    }),
  );

  await fs.writeFile(
    workflowFile,
    workflowMarkdown({ acceptUnrouted: false, intervalMs: 9, prompt: "Changed prompt" }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  assert.equal(clientBuilds, 2);
  assert.equal(runtime.workflow.promptTemplate, "Changed prompt");
  assert.equal(runtime.workflow.settings.polling.intervalMs, 9);
  assert.equal(runtime.snapshot().poll.eligible, 0);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "workflow_reloaded"),
    true,
  );
});

test("runtime preflights dispatch config before candidate fetches", async () => {
  const workflow = workflowFixture();
  workflow.settings.tracker.kind = undefined;
  let candidateFetches = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      client: {
        fetchCandidateIssues: async () => {
          candidateFetches += 1;
          return [];
        },
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  await assert.rejects(() => runtime.pollOnce({ dryRun: true }), /tracker.kind is required/);

  assert.equal(candidateFetches, 0);
  assert.equal(runtime.snapshot().poll.status, "error");
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.message.includes("tracker.kind")),
    true,
  );
});

test("runtime aborts in-flight runs when reconciliation sees a terminal issue", async () => {
  const issue = issueFixture("issue-abort", "MT-ABORT");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  let fetches = 0;
  let aborted = false;
  let started = false;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => {
          fetches += 1;
          return fetches === 1 ? [issue] : [doneIssue];
        },
      },
      runner: async ({ abortSignal }) => {
        started = true;
        await new Promise<void>((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    }),
  );

  await runtime.pollOnce();
  assert.equal(started, true);
  // The second pollOnce triggers reconciliation which detects the terminal issue
  // and aborts the in-flight run. The abort is async so we wait for it with a
  // generous timeout to avoid flakiness under CI load.
  await runtime.pollOnce({ dryRun: true });
  await waitFor(() => aborted, 2_000);

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.retrying.length, 0);
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "workspace_cleanup"),
    true,
  );
});

test("runtime aborts in-flight runs when reconciliation sees missing or unrouted issues", async () => {
  for (const mode of ["missing", "unrouted"] as const) {
    const root = await tempDir(`symphony-ts-runtime-${mode}-inert`);
    const issue = issueFixture(`issue-${mode}`, `MT-${mode.toUpperCase()}`);
    const settings =
      mode === "unrouted"
        ? parseConfig({
            tracker: {
              kind: "linear",
              api_key: "linear-token",
              project_slug: "mono",
              dispatch: { only_routes: ["backend"] },
              active_states: ["Todo"],
              terminal_states: ["Done"],
            },
            polling: { interval_ms: 5 },
            workspace: { root },
          })
        : workflowFixture(root).settings;
    const routedIssue = mode === "unrouted" ? { ...issue, labels: ["symphony:backend"] } : issue;
    const staleIssue = mode === "unrouted" ? { ...issue, labels: ["symphony:frontend"] } : null;
    const workspace = await createWorkspaceForIssue(settings, routedIssue);
    let fetches = 0;
    let aborted = false;
    const runtime = new SymphonyRuntime(
      runtimeOptions({
        workflow: {
          path: "/tmp/WORKFLOW.md",
          config: {},
          promptTemplate: "Issue {{ issue.identifier }}",
          settings,
        },
        client: {
          fetchCandidateIssues: async () => [routedIssue],
          fetchIssuesByIds: async () => {
            fetches += 1;
            if (fetches === 1) return [routedIssue];
            return staleIssue ? [staleIssue] : [];
          },
        },
        runner: async ({ abortSignal }) => {
          await new Promise<void>((_resolve, reject) => {
            abortSignal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
          throw new Error("unreachable");
        },
      }),
    );

    try {
      await runtime.pollOnce();
      await runtime.pollOnce({ dryRun: true });
      await waitFor(() => aborted, 1_000);
      assert.equal(runtime.snapshot().running.length, 0);
      assert.equal(await fileExists(workspace), true);
      assert.equal(
        runtime.snapshot().recentEvents.some((event) => event.type === "workspace_cleanup"),
        false,
      );
      assert.equal(
        runtime.snapshot().recentEvents.some((event) => event.message.includes(mode)),
        true,
      );
    } finally {
      runtime.stop();
    }
  }
});

test("runtime keeps tracked work running when tracker refresh fails during reconciliation", async () => {
  const issue = issueFixture("issue-refresh-failure", "MT-REFRESH-FAILURE");
  const workflow = workflowFixture();
  const orchestrator = new Orchestrator(workflow.settings);
  assert.ok(orchestrator.claim(issue));
  let candidateFetches = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => {
          candidateFetches += 1;
          return [];
        },
        fetchIssuesByIds: async () => {
          throw new Error("tracker unavailable");
        },
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  const snapshot = runtime.snapshot();
  assert.equal(candidateFetches, 1);
  assert.equal(snapshot.poll.status, "idle");
  assert.equal(snapshot.poll.lastError, null);
  assert.equal(snapshot.running.length, 1);
  assert.equal(snapshot.running[0]?.issueIdentifier, "MT-REFRESH-FAILURE");
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "reconcile_refresh_failed"),
    true,
  );
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "poll_error"),
    false,
  );
});

test("runtime reconciles stalled runs from the orchestrator poll loop", async () => {
  const issue = issueFixture("issue-stalled", "MT-STALLED");
  const root = await tempDir("symphony-ts-runtime-stall-resume");
  const workflow = workflowFixture(root);
  workflow.settings.codex.stallTimeoutMs = 50;
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  const workspace = await createWorkspaceForIssue(workflow.settings, issue);
  const deletedResumeStates: string[] = [];
  const orchestrator = new Orchestrator(workflow.settings);
  let aborted = false;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      deleteResumeState: async (workspacePath) => {
        deletedResumeStates.push(workspacePath);
      },
      runner: async ({ abortSignal, onUpdate }) => {
        onUpdate?.({
          type: "workspace_prepared",
          message: `workspace prepared at ${workspace}`,
          workspacePath: workspace,
        });
        await new Promise<void>((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted by stall reconciliation"));
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    }),
  );

  try {
    await runtime.pollOnce();
    const running = orchestrator.snapshot().running[0];
    assert.ok(running);
    running.lastAgentTimestamp = new Date(Date.now() - 1_000);

    await runtime.pollOnce({ dryRun: true });
    await waitFor(() => aborted, 1_000);

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.running.length, 0);
    assert.equal(snapshot.runHistory[0]?.outcome, "stalled");
    assert.equal(snapshot.retrying[0]?.attempt, 1);
    assert.deepEqual(deletedResumeStates, [workspace]);
    assert.ok(snapshot.recentEvents.some((event) => event.type === "run_stalled"));
    assert.ok(snapshot.recentEvents.some((event) => event.type === "resume_state_invalidated"));
  } finally {
    runtime.stop();
  }
});

test("runtime stall reconciliation uses agents-level stall timeout defaults", async () => {
  const issue = issueFixture("issue-agents-stall", "MT-AGENTS-STALL");
  const root = await tempDir("symphony-ts-runtime-agents-stall");
  const settings = parseConfig({
    tracker: {
      kind: "linear",
      api_key: "linear-token",
      project_slug: "mono",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 5 },
    workspace: { root },
    agents: { stall_timeout_ms: 50 },
  });
  assert.equal(settings.codex.stallTimeoutMs, 50);
  assert.equal(settings.agents.codex.stallTimeoutMs, 50);
  const workflow: WorkflowDefinition = {
    path: "/tmp/WORKFLOW.md",
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };
  const workspace = await createWorkspaceForIssue(workflow.settings, issue);
  const orchestrator = new Orchestrator(workflow.settings);
  let aborted = false;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal, onUpdate }) => {
        onUpdate?.({
          type: "workspace_prepared",
          message: `workspace prepared at ${workspace}`,
          workspacePath: workspace,
        });
        await new Promise<void>((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted by agents-level stall timeout"));
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    }),
  );

  try {
    await runtime.pollOnce();
    const running = orchestrator.snapshot().running[0];
    assert.ok(running);
    running.lastAgentTimestamp = new Date(Date.now() - 1_000);

    await runtime.pollOnce({ dryRun: true });
    await waitFor(() => aborted, 1_000);

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.running.length, 0);
    assert.equal(snapshot.runHistory[0]?.outcome, "stalled");
  } finally {
    runtime.stop();
  }
});

// NOTE: This test modifies process.env.PATH to inject a fake ssh binary.
// It restores PATH in the finally block but is NOT safe for parallel execution
// with other tests that depend on PATH or invoke ssh. The test suite runs
// sequentially so this is acceptable.
test("runtime does not stall a stale ensemble slot snapshot after its runner completes", async () => {
  const issue = issueFixture("issue-ensemble-stall-race", "MT-ENSEMBLE-RACE");
  const root = await tempDir("symphony-ts-runtime-ensemble-stall-race");
  const workflow = workflowFixture(root);
  workflow.settings.agent.ensembleSize = 2;
  workflow.settings.codex.stallTimeoutMs = 50;
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  workflow.settings.worker.sshTimeoutMs = 2_000;
  const orchestrator = new Orchestrator(workflow.settings);
  const controls = new Map<
    number,
    {
      resolve: (value: RunResult) => void;
      reject: (error: Error) => void;
    }
  >();
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal, onUpdate, slotIndex }) => {
        const slot = slotIndex ?? 0;
        const workspace = path.join(root, `workspace-${slot}`);
        onUpdate?.({
          type: "workspace_prepared",
          message: `workspace prepared at ${workspace}`,
          workspacePath: workspace,
        });
        return await new Promise<RunResult>((resolve, reject) => {
          controls.set(slot, { resolve, reject });
          abortSignal?.addEventListener("abort", () => reject(new Error(`aborted slot ${slot}`)), {
            once: true,
          });
        });
      },
    }),
  );
  const fakeBin = path.join(root, "bin");
  const originalPath = process.env.PATH;
  await writeExecutable(
    path.join(fakeBin, "ssh"),
    [
      "#!/bin/sh",
      'args="$*"',
      'case "$args" in',
      "*rev-parse*) sleep 0.15; printf '.git\\n'; exit 0 ;;",
      "*rm\\ -f*) sleep 0.05; exit 0 ;;",
      "*) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
  );

  try {
    await runtime.pollOnce();
    await runtime.pollOnce();
    await waitFor(() => controls.size === 2, 2_000);

    const entries = orchestrator.snapshot().running;
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      entry.lastAgentTimestamp = new Date(Date.now() - 1_000);
    }
    const firstSlot = entries.find((entry) => entry.slotIndex === 0);
    assert.ok(firstSlot);
    firstSlot.workerHost = "worker-01";
    firstSlot.workspacePath = "/remote/workspace-0";

    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    const stallPoll = runtime.pollOnce({ dryRun: true });
    controls.get(1)?.resolve({
      workspace: path.join(root, "workspace-1"),
      turnCount: 1,
      updates: [],
      resumeId: "ensemble-slot-1",
      agentKind: "codex",
      finalIssue: { ...issue, state: { name: "Todo", type: "unstarted" } },
    });
    await stallPoll;
    await waitFor(
      () => runtime.snapshot().runHistory.some((entry) => entry.slotIndex === 1),
      2_000,
    );

    const snapshot = runtime.snapshot();
    assert.deepEqual(
      snapshot.runHistory.filter((entry) => entry.slotIndex === 1).map((entry) => entry.outcome),
      ["success"],
    );
    assert.deepEqual(
      snapshot.runHistory
        .filter((entry) => entry.outcome === "stalled")
        .map((entry) => entry.slotIndex),
      [0],
    );
  } finally {
    process.env.PATH = originalPath;
    runtime.stop();
  }
});

test("runtime does not record late success after stall reconciliation wins", async () => {
  const issue = issueFixture("issue-late-success", "MT-LATE-SUCCESS");
  const workflow = workflowFixture();
  workflow.settings.codex.stallTimeoutMs = 50;
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  const orchestrator = new Orchestrator(workflow.settings);
  let aborted = false;
  const runControl: { resolve?: (value: any) => void } = {};
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal }) => {
        abortSignal?.addEventListener("abort", () => {
          aborted = true;
        });
        return await new Promise((resolve) => {
          runControl.resolve = resolve;
        });
      },
    }),
  );

  try {
    await runtime.pollOnce();
    const running = orchestrator.snapshot().running[0];
    assert.ok(running);
    running.lastAgentTimestamp = new Date(Date.now() - 1_000);

    await runtime.pollOnce({ dryRun: true });
    assert.equal(aborted, true);
    assert.equal(runtime.snapshot().runHistory[0]?.outcome, "stalled");

    const completeRun = runControl.resolve;
    assert.ok(completeRun);
    const completeIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
    completeRun({
      workspace: "/tmp/symphony/MT-LATE-SUCCESS",
      turnCount: 1,
      updates: [],
      resumeId: "late-success",
      agentKind: "codex",
      finalIssue: completeIssue,
    });
    await vi.waitFor(() => {
      const snapshot = runtime.snapshot();
      assert.equal(snapshot.runHistory.length, 1);
      assert.equal(snapshot.runHistory[0]?.outcome, "stalled");
    });
  } finally {
    runtime.stop();
  }
});

test("runtime keeps a retry handle active when a stalled generation finishes late", async () => {
  const issue = issueFixture("issue-stale-finally", "MT-STALE-FINALLY");
  const root = await tempDir("symphony-ts-runtime-stale-finally");
  const workflow = workflowFixture(root);
  workflow.settings.agent.maxRetryBackoffMs = 0;
  workflow.settings.codex.stallTimeoutMs = 50;
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  const orchestrator = new Orchestrator(workflow.settings);
  let attempts = 0;
  const abortedAttempts = new Set<number>();
  const controls = new Map<number, { resolve: (value: RunResult) => void }>();
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal, onUpdate }) => {
        attempts += 1;
        const attempt = attempts;
        onUpdate?.({
          type: "workspace_prepared",
          message: `workspace prepared at ${path.join(root, `workspace-${attempt}`)}`,
          workspacePath: path.join(root, `workspace-${attempt}`),
        });
        abortSignal?.addEventListener("abort", () => {
          abortedAttempts.add(attempt);
        });
        return await new Promise<RunResult>((resolve) => {
          controls.set(attempt, { resolve });
        });
      },
    }),
  );

  try {
    await runtime.pollOnce();
    assert.equal(attempts, 1);
    const firstEntry = orchestrator.snapshot().running[0];
    assert.ok(firstEntry);
    firstEntry.lastAgentTimestamp = new Date(Date.now() - 1_000);

    await runtime.pollOnce({ dryRun: true });
    assert.equal(runtime.snapshot().runHistory[0]?.outcome, "stalled");
    assert.equal(abortedAttempts.has(1), true);

    await runtime.pollOnce();
    await waitFor(() => attempts === 2, 1_000);
    assert.equal(runtime.snapshot().running[0]?.runId, "run-2");

    controls.get(1)?.resolve({
      workspace: path.join(root, "workspace-1"),
      turnCount: 1,
      updates: [],
      resumeId: "stale-finished-late",
      agentKind: "codex",
      finalIssue: issue,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const snapshot = runtime.snapshot();
    assert.equal(snapshot.running[0]?.runId, "run-2");
    assert.deepEqual(
      snapshot.runHistory.map((entry) => entry.outcome),
      ["stalled"],
    );
  } finally {
    runtime.stop();
  }
});

test("runtime coalesces overlapping pollOnce calls", async () => {
  const fetchControl: { release?: () => void } = {};
  let fetches = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => {
          fetches += 1;
          await new Promise<void>((resolve) => {
            fetchControl.release = resolve;
          });
          return [];
        },
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  const first = runtime.pollOnce({ dryRun: true });
  await waitFor(() => fetches === 1, 1_000);
  const second = runtime.pollOnce({ dryRun: true });
  await vi.waitFor(() => assert.equal(fetches, 1));

  const unblockFetch = fetchControl.release;
  assert.ok(unblockFetch);
  unblockFetch();
  await Promise.all([first, second]);
});

test("runtime preserves stronger overlapping pollOnce dispatch intent", async () => {
  const issue = issueFixture("issue-overlap-dispatch", "MT-OVERLAP-DISPATCH");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const fetchControl: { release?: () => void } = {};
  let fetches = 0;
  let runnerCalls = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => {
          fetches += 1;
          if (fetches === 1) {
            await new Promise<void>((resolve) => {
              fetchControl.release = resolve;
            });
          }
          return [issue];
        },
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        return {
          workspace: "/tmp/symphony/MT-OVERLAP-DISPATCH",
          turnCount: 1,
          updates: [],
          resumeId: "overlap-dispatch",
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  try {
    const first = runtime.pollOnce({ dryRun: true });
    await waitFor(() => fetches === 1, 1_000);
    const second = runtime.pollOnce({ waitForRuns: true });
    await vi.waitFor(() => assert.equal(fetches, 1));

    const unblockFetch = fetchControl.release;
    assert.ok(unblockFetch);
    unblockFetch();
    await Promise.all([first, second]);

    assert.equal(fetches, 2);
    assert.equal(runnerCalls, 1);
  } finally {
    runtime.stop();
  }
});

test("runtime keeps polling after a candidate fetch throws in the recurring loop", async () => {
  let fetches = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => {
          fetches += 1;
          if (fetches === 1) throw new Error("tracker fetch failed");
          return [];
        },
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  void runtime.start({ once: false });
  try {
    await waitFor(() => fetches >= 2, 1_000);
    const snapshot = runtime.snapshot();
    assert.ok(fetches >= 2);
    assert.ok(
      snapshot.recentEvents.some(
        (event) => event.type === "poll_error" && event.message.includes("tracker fetch failed"),
      ),
    );
  } finally {
    runtime.stop();
  }
});

test("runtime stop does not record an in-flight run as a failure", async () => {
  const issue = issueFixture("issue-stop", "MT-STOP");
  const orchestrator = new Orchestrator(workflowFixture().settings);
  let aborted = false;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      // Mirror the real runner: a stop()-triggered abort rejects the in-flight turn.
      runner: async ({ abortSignal }) =>
        await new Promise<RunResult>((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("agent_run_aborted"));
            },
            { once: true },
          );
        }),
    }),
  );

  await runtime.pollOnce();
  await waitFor(() => orchestrator.snapshot().running.length === 1, 1_000);

  // Ctrl+C path: stop() aborts the in-flight run without releasing its slot.
  runtime.stop();
  await waitFor(() => aborted, 1_000);
  // Let the runner's rejection propagate through runClaim's catch.
  await new Promise<void>((resolve) => setImmediate(resolve));

  const snapshot = runtime.snapshot();
  assert.equal(
    snapshot.runHistory.some((entry) => entry.outcome === "failed"),
    false,
  );
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "run_failed"),
    false,
  );
});

test("runtime appends operational events to the configured log file", async () => {
  const root = await tempDir("symphony-ts-runtime-event-log");
  const workflow = workflowFixture(root);
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });
  await waitFor(
    async () => (await fileText(workflow.settings.logging.logFile)).includes("dry_run"),
    1_000,
  );

  const logText = await fs.readFile(workflow.settings.logging.logFile, "utf8");
  assert.match(logText, /"event":"dry_run"/);
});

test("runtime reconciliation removes terminal retry workspaces before polling", async () => {
  const root = await tempDir("symphony-ts-runtime-cleanup");
  const workflow = workflowFixture(root);
  const activeIssue = issueFixture("issue-cleanup", "MT-CLEANUP");
  const doneIssue: Issue = { ...activeIssue, state: "Done", stateType: "completed" };
  const workspace = await createWorkspaceForIssue(workflow.settings, activeIssue);
  await fs.writeFile(path.join(workspace, "scratch.txt"), "remove me\n");

  const orchestrator = new Orchestrator(workflow.settings);
  assert.ok(orchestrator.claim(activeIssue));
  orchestrator.finish(activeIssue.id, 0, true);

  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async (ids) => (ids.includes(activeIssue.id) ? [doneIssue] : []),
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(orchestrator.snapshot().retrying.length, 0);
  await assert.rejects(() => fs.stat(workspace), /ENOENT/);
  assert.equal(runtime.snapshot().recentEvents[0]?.type, "dry_run");
  assert.ok(runtime.snapshot().recentEvents.some((event) => event.type === "workspace_cleanup"));
});

test("runtime reconcile refreshes the running stage when the tracker state changes", async () => {
  const workflow = workflowFixture();
  const orchestrator = new Orchestrator(workflow.settings);
  assert.ok(orchestrator.claim(issueFixture("issue-1", "MT-1")));

  const moved: Issue = { ...issueFixture("issue-1", "MT-1"), state: "In Progress" };
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [moved],
      },
    }),
  );

  assert.equal(runtime.snapshot().running[0]?.state, "Todo");

  await runtime.pollOnce({ dryRun: true });

  assert.equal(runtime.snapshot().running[0]?.state, "In Progress");
});

test("runtime performs startup terminal workspace cleanup through tracker state queries", async () => {
  const root = await tempDir("symphony-ts-runtime-startup-cleanup");
  const workflow = workflowFixture(root);
  const doneIssue: Issue = {
    ...issueFixture("issue-startup-done", "MT-STARTUP-DONE"),
    state: "Done",
    stateType: "completed",
  };
  const workspace = await createWorkspaceForIssue(workflow.settings, doneIssue);
  await fs.writeFile(path.join(workspace, "scratch.txt"), "remove me\n");
  let stateQueries = 0;

  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [],
        fetchIssuesByStates: async (states) => {
          stateQueries += 1;
          assert.deepEqual(states, workflow.settings.tracker.terminalStates);
          return [doneIssue];
        },
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });
  await assert.rejects(() => fs.stat(workspace), /ENOENT/);
  assert.equal(stateQueries, 1);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "startup_workspace_cleanup"),
    true,
  );

  await runtime.pollOnce({ dryRun: true });
  assert.equal(stateQueries, 1);
});

test("runtime treats startup terminal cleanup fetch failures as non-fatal", async () => {
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [],
        fetchIssuesByStates: async () => {
          throw new Error("tracker unavailable");
        },
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });
  assert.equal(
    runtime
      .snapshot()
      .recentEvents.some((event) => event.type === "startup_workspace_cleanup_failed"),
    true,
  );
});

test("runtime records failed attempts as retryable work and keeps polling", async () => {
  const issue = issueFixture("issue-retryable", "MT-RETRYABLE");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workflowFixture();
  const orchestrator = new Orchestrator(workflow.settings);
  let attempts = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => (attempts >= 2 ? [doneIssue] : [issue]),
      },
      runner: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("agent exited: boom");
        return {
          workspace: "/tmp/symphony/MT-RETRYABLE",
          turnCount: 1,
          updates: [],
          resumeId: "retry-resume",
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });
  let snapshot = runtime.snapshot();
  assert.equal(snapshot.appStatus, "idle");
  assert.equal(snapshot.runHistory[0]?.outcome, "failed");
  assert.equal(snapshot.retrying[0]?.attempt, 1);
  assert.equal(snapshot.retrying[0]?.error, "agent exited: boom");

  const retry = orchestrator.state.retryAttempts.get(slotKey(issue.id, 0));
  assert.ok(retry);
  retry.dueAtIso = new Date(Date.now() - 1).toISOString();
  retry.monotonicDeadlineMs = 0;
  await runtime.pollOnce({ waitForRuns: true });
  snapshot = runtime.snapshot();
  assert.equal(attempts, 2);
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(snapshot.retrying[0]?.attempt, 1);

  await runtime.pollOnce({ waitForRuns: true });
  snapshot = runtime.snapshot();
  assert.equal(snapshot.retrying.length, 0);
});

test("runtime invalidates resume state before scheduling failure retry", async () => {
  const root = await tempDir("symphony-ts-runtime-failure-resume");
  const issue = issueFixture("issue-failure-resume", "MT-FAILURE-RESUME");
  const workflow = workflowFixture(root);
  const workspace = await createWorkspaceForIssue(workflow.settings, issue);
  const deletedResumeStates: string[] = [];
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      deleteResumeState: async (workspacePath) => {
        deletedResumeStates.push(workspacePath);
      },
      runner: async ({ onUpdate }) => {
        onUpdate?.({
          type: "workspace_prepared",
          message: `workspace prepared at ${workspace}`,
          workspacePath: workspace,
        });
        throw new Error("agent exited: retry me");
      },
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });

  const snapshot = runtime.snapshot();
  assert.equal(snapshot.runHistory[0]?.outcome, "failed");
  assert.equal(snapshot.retrying[0]?.attempt, 1);
  assert.deepEqual(deletedResumeStates, [workspace]);
  assert.ok(snapshot.recentEvents.some((event) => event.type === "resume_state_invalidated"));
});

test("runtime schedules retry refresh timers independently of the poll cadence", async () => {
  const issue = issueFixture("issue-timer-retry", "MT-TIMER");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workflowFixture();
  workflow.settings.polling.intervalMs = 60_000;
  workflow.settings.agent.maxRetryBackoffMs = 500;
  let attempts = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => (attempts >= 2 ? [doneIssue] : [issue]),
      },
      runner: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("agent exited: retry me");
        return {
          workspace: "/tmp/symphony/MT-TIMER",
          turnCount: 1,
          updates: [],
          resumeId: "timer-resume",
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });
  assert.equal(attempts, 1);
  assert.equal(runtime.snapshot().retrying[0]?.attempt, 1);

  await waitFor(() => attempts === 2, 3_000);
  let snapshot = runtime.snapshot();
  assert.equal(snapshot.retrying[0]?.attempt, 1);

  await waitFor(() => runtime.snapshot().retrying.length === 0, 3_000);
  snapshot = runtime.snapshot();
  assert.equal(snapshot.retrying.length, 0);
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(
    snapshot.recentEvents.some((event) => event.type === "retry_timer_due"),
    true,
  );
  runtime.stop();
});

// ---------------------------------------------------------------------------
// Box pool integration (T15)
// ---------------------------------------------------------------------------

interface AcquireCall {
  issueId: string;
  slotIndex: number;
  labels: ReadonlyArray<string>;
  affinityKey?: string | null;
  timeoutMs: number;
}

interface FakeLease extends BoxLease {
  readonly settles: Array<{ kind: "release" | "fail"; arg?: string }>;
  readonly heartbeats: { count: number };
}

function makeFakeLease(
  options: {
    leaseId?: string;
    boxId?: string;
    workerHost?: string;
    stale?: boolean;
  } = {},
): FakeLease {
  const settles: Array<{ kind: "release" | "fail"; arg?: string }> = [];
  const heartbeats = { count: 0 };
  const stale = options.stale ?? false;
  return {
    leaseId: options.leaseId ?? "lease-1",
    boxId: options.boxId ?? "box-1",
    workerHost: options.workerHost ?? "fake://box-box-1",
    acquiredAtMs: 0,
    expiresAtMs: null,
    settles,
    heartbeats,
    async release(outcome?: BoxOutcome): Promise<void> {
      // A stale-generation lease guards its own settle: the leaseId no longer
      // matches the box record so the op is a no-op that never records.
      if (stale) return;
      settles.push({ kind: "release", arg: outcome });
    },
    async fail(reason: string): Promise<void> {
      if (stale) return;
      settles.push({ kind: "fail", arg: reason });
    },
    heartbeat(): void {
      heartbeats.count += 1;
    },
  };
}

interface FakeBoxPool extends BoxPool {
  readonly acquireCalls: AcquireCall[];
  readonly reconcileCalls: BoxPoolSettings[];
  readonly drainCalls: Array<{ deadlineMs: number }>;
  lastLease: FakeLease | null;
}

function makeFakeBoxPool(
  options: {
    result?: AcquireResult | (() => AcquireResult);
    lease?: FakeLease;
    canAcquire?: boolean | (() => boolean);
    isEnabled?: boolean | (() => boolean);
    reconcileError?: string;
  } = {},
): FakeBoxPool {
  const acquireCalls: AcquireCall[] = [];
  const reconcileCalls: BoxPoolSettings[] = [];
  const drainCalls: Array<{ deadlineMs: number }> = [];
  const pool: FakeBoxPool = {
    acquireCalls,
    reconcileCalls,
    drainCalls,
    lastLease: null,
    async acquire(req): Promise<AcquireResult> {
      acquireCalls.push({
        issueId: req.issueId,
        slotIndex: req.slotIndex,
        labels: req.labels,
        affinityKey: req.affinityKey,
        timeoutMs: req.timeoutMs,
      });
      if (options.result) {
        return typeof options.result === "function" ? options.result() : options.result;
      }
      const lease = options.lease ?? makeFakeLease();
      pool.lastLease = lease;
      return { status: "leased", lease };
    },
    canAcquire(): boolean {
      return typeof options.canAcquire === "function"
        ? options.canAcquire()
        : (options.canAcquire ?? true);
    },
    isEnabled(): boolean {
      return typeof options.isEnabled === "function"
        ? options.isEnabled()
        : (options.isEnabled ?? true);
    },
    reconcile(next): void {
      reconcileCalls.push(next);
      if (options.reconcileError) throw new Error(options.reconcileError);
    },
    async hydrate(): Promise<void> {},
    async drain(opts): Promise<void> {
      drainCalls.push({ deadlineMs: opts.deadlineMs });
    },
    snapshot() {
      return {
        enabled: true,
        provider: "fake",
        total: 0,
        warmIdle: 0,
        leased: 0,
        provisioning: 0,
        degraded: 0,
        inFlight: 0,
        spend: { concurrentBoxes: 0, boxSecondsUsed: 0, dailyBoxSecondsUsed: 0, dayKey: "" },
        boxes: [],
      };
    },
  };
  return pool;
}

function boxPoolWorkflowFixture(
  root = "/tmp/symphony-ts-runtime-boxpool",
  overrides: Record<string, unknown> = {},
): WorkflowDefinition {
  const settings = parseConfig({
    tracker: {
      kind: "linear",
      api_key: "linear-token",
      project_slug: "mono",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 5 },
    workspace: { root },
    worker: {
      box_pool: {
        enabled: true,
        provider: "fake",
        acquire_timeout_ms: 12_345,
        drain_deadline_ms: 9_999,
        ...overrides,
      },
    },
  });
  return {
    path: "/tmp/WORKFLOW.md",
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };
}

test("box pool: leased workerHost is written back and passed to the runner; history matches lease", async () => {
  const issue = issueFixture("issue-bp-lease", "MT-BP-LEASE");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const lease = makeFakeLease({ workerHost: "fake://box-bp-lease" });
  const boxPool = makeFakeBoxPool({ lease });
  let runnerWorkerHost: string | null | undefined = "unset";
  let workerHostDuringRun: string | null | undefined;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: boxPoolWorkflowFixture(),
      boxPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ workerHost, issue: runIssue, slotIndex }) => {
        runnerWorkerHost = workerHost;
        workerHostDuringRun = runtime
          .snapshot()
          .running.find(
            (entry) => entry.issueId === runIssue.id && entry.slotIndex === slotIndex,
          )?.workerHost;
        return {
          workspace: "/tmp/symphony/MT-BP-LEASE",
          turnCount: 1,
          updates: [],
          resumeId: "resume-bp",
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  assert.equal(runnerWorkerHost, "fake://box-bp-lease");
  assert.equal(workerHostDuringRun, "fake://box-bp-lease");
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(snapshot.runHistory[0]?.workerHost, "fake://box-bp-lease");
  assert.deepEqual(
    lease.settles.map((s) => s.kind),
    ["release"],
  );
  assert.equal(lease.settles[0]?.arg, "healthy");
});

test("box pool: the bound slot's mcpEndpoint is threaded into the runner", async () => {
  const issue = issueFixture("issue-bp-endpoint", "MT-BP-ENDPOINT");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const lease = makeFakeLease({ workerHost: "ssh://worker-endpoint" });
  const boxPool = makeFakeBoxPool({ lease });
  // Dispatch to the claude kind; the ACP executor consumes the per-run endpoint
  // over the reverse tunnel. This pins the endpoint-threading mechanism.
  const workflow = boxPoolWorkflowFixture();
  workflow.settings.agent.kind = "claude";

  // A concrete-style manager (perRunEndpoint=true) that opens a recognizable
  // per-run lease and records its open/release calls so we can assert the
  // coordinator owns the endpoint lifecycle and the runner consumes it.
  const endpointLease = makeFakeEndpointLease();
  const opens: Array<{ workerHost: string; runKey: string }> = [];
  let releaseCalls = 0;
  const manager: McpEndpointManager = {
    perRunEndpoint: true,
    async open(req) {
      opens.push({ workerHost: req.workerHost, runKey: req.runKey });
      return endpointLease;
    },
    async release() {
      releaseCalls += 1;
    },
  };
  const coordinator = createDispatchCoordinator({
    pool: boxPool,
    mcpEndpointManager: manager,
    settings: workflow.settings.worker.boxPool!,
  });

  let runnerEndpoint: AgentMcpEndpointLease | null | undefined = undefined;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      coordinator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ mcpEndpoint }) => {
        runnerEndpoint = mcpEndpoint;
        return {
          workspace: "/tmp/symphony/MT-BP-ENDPOINT",
          turnCount: 1,
          updates: [],
          resumeId: "resume-bp-endpoint",
          agentKind: "claude",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  // The endpoint was opened AFTER lease-bind for this run's worker host/slot, the
  // runner received the SAME lease, and the coordinator released it on settle. The
  // runKey is the issue-scoped `${issueId}#${slotIndex}`.
  assert.equal(opens.length, 1);
  assert.equal(opens[0]?.workerHost, "ssh://worker-endpoint");
  assert.equal(opens[0]?.runKey, "issue-bp-endpoint#0");
  assert.equal(runnerEndpoint, endpointLease);
  assert.equal(releaseCalls, 1);
  assert.deepEqual(
    lease.settles.map((s) => s.kind),
    ["release"],
  );
});

test("box pool: the FULL workflow Settings (with server.port) is threaded to the per-run endpoint open, not the BoxPoolSettings", async () => {
  // Codex HIGH #1: the coordinator must thread the FULL workflow Settings to
  // mcpEndpointManager.open so the concrete acquireAgentMcpEndpointForRun can read
  // settings.server.port. Threading the coordinator's BoxPoolSettings instead
  // leaves server.port undefined, so an enabled per-run-endpoint pool fails at
  // acquire and never dispatches. This test pins that open() receives the FULL
  // Settings (server.host/server.port present) the workflow carries.
  const issue = issueFixture("issue-bp-full-settings", "MT-BP-FULL-SETTINGS");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const lease = makeFakeLease({ workerHost: "ssh://worker-full-settings" });
  const boxPool = makeFakeBoxPool({ lease });

  // A full workflow whose Settings carry a concrete server.port (the FULL Settings
  // field the BoxPoolSettings does NOT have). Dispatch to the claude kind; the ACP
  // executor opens a per-run endpoint, so open() is reached.
  const workflow = boxPoolWorkflowFixture();
  workflow.settings.agent.kind = "claude";
  workflow.settings.server.host = "127.0.0.1";
  workflow.settings.server.port = 51_842;

  let openSettings: unknown;
  const endpointLease = makeFakeEndpointLease();
  const manager: McpEndpointManager = {
    perRunEndpoint: true,
    async open(req) {
      openSettings = req.settings;
      return endpointLease;
    },
    async release() {},
  };
  const coordinator = createDispatchCoordinator({
    pool: boxPool,
    mcpEndpointManager: manager,
    settings: workflow.settings.worker.boxPool!,
  });

  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      coordinator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/symphony/MT-BP-FULL-SETTINGS",
        turnCount: 1,
        updates: [],
        resumeId: "resume-bp-full-settings",
        agentKind: "claude",
        finalIssue: doneIssue,
      }),
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  // The open received the FULL workflow Settings: server.port is the configured
  // value (NOT undefined, as it would be if the BoxPoolSettings were passed). This
  // is the field acquireAgentMcpEndpointForRun reads to build the remote endpoint.
  const settings = openSettings as Settings;
  assert.ok(settings.server);
  assert.equal(settings.server.port, 51_842);
  assert.equal(settings.server.host, "127.0.0.1");
});

test("box pool: a null-manager slot threads a null mcpEndpoint into the runner", async () => {
  const issue = issueFixture("issue-bp-null-endpoint", "MT-BP-NULL");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const lease = makeFakeLease({ workerHost: "fake://box-null-endpoint" });
  const boxPool = makeFakeBoxPool({ lease });
  let runnerEndpoint: AgentMcpEndpointLease | null | undefined = "unset" as never;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: boxPoolWorkflowFixture(),
      boxPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ mcpEndpoint }) => {
        runnerEndpoint = mcpEndpoint;
        return {
          workspace: "/tmp/symphony/MT-BP-NULL",
          turnCount: 1,
          updates: [],
          resumeId: "resume-bp-null",
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  // The bare-boxPool path wraps the pool in the null-endpoint passthrough
  // coordinator, so the slot carries mcpEndpoint=null and the runner is threaded
  // null (acp then acquires/releases its own endpoint - byte-identical).
  assert.equal(runnerEndpoint, null);
});

function makeFakeEndpointLease(): AgentMcpEndpointLease {
  return {
    url: "http://127.0.0.1:46999/claude-mcp",
    token: "run-token",
    acpServer: () => ({ type: "http", name: "threaded_endpoint", url: "", headers: [] }),
    async release() {},
  };
}

// ---------------------------------------------------------------------------
// Every box-pool run needs its per-run MCP endpoint (ACP is the only executor)
// ---------------------------------------------------------------------------
//
// The ACP executor - the only executor - consumes the per-run mcpEndpoint over
// the reverse tunnel, so the runtime asks the coordinator for one on EVERY run
// (needsMcpEndpoint=true regardless of agent kind). When the per-run open
// THROWS, the run must NOT dispatch: the coordinator settles the just-bound
// lease HEALTHY (only the endpoint failed, the box is fine), the runtime
// abandons the claim so the slot is re-evaluated next poll, and no history is
// recorded for a run that never started.

test("box pool: a codex run is skipped when the per-run endpoint open THROWS (every run needs an endpoint) (HIGH)", async () => {
  const issue = issueFixture("issue-bp-codex-ep-throw", "MT-BP-CODEX-EP-THROW");
  const workflow = boxPoolWorkflowFixture();
  // The default agent kind is `codex` -> agents.codex.executor === 'acp', the
  // only executor; a codex run consumes the per-run endpoint like any other.
  assert.equal(workflow.settings.agents.codex?.executor, "acp");
  const lease = makeFakeLease({ workerHost: "ssh://worker-codex" });
  const boxPool = makeFakeBoxPool({ lease });
  // A per-run manager whose open() ALWAYS throws: the throw surfaces as
  // box_pool_acquire_error and the run never dispatches.
  let openCalls = 0;
  const manager: McpEndpointManager = {
    perRunEndpoint: true,
    async open() {
      openCalls += 1;
      throw new Error("mcp_endpoint_open_failed: remote port-forward restricted");
    },
    async release() {},
  };
  const coordinator = createDispatchCoordinator({
    pool: boxPool,
    mcpEndpointManager: manager,
    settings: workflow.settings.worker.boxPool!,
  });
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  let runnerCalls = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      coordinator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        throw new Error("runner should not run when the endpoint open throws");
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  // The open WAS attempted (the codex run needs its endpoint), the runner never
  // ran, and the dispatch was skipped with a clear acquire error.
  assert.equal(openCalls, 1);
  assert.equal(runnerCalls, 0);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.runHistory.length, 0);
  assert.equal(snapshot.retrying.length, 0);
  assert.equal(snapshot.running.length, 0);
  // The claim was abandoned (re-claimable next poll), not stranded.
  assert.equal(orchestrator.state.claimed.size, 0);
  assert.equal(orchestrator.state.running.size, 0);
  // The box itself is fine - only the endpoint failed - so the just-bound lease
  // settled HEALTHY, never poisoned.
  assert.deepEqual(lease.settles, [{ kind: "release", arg: "healthy" }]);
  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "dispatch_skipped" && event.message.includes("box_pool_acquire_error"),
    ),
  );
});

test("box pool: an ACP/claude run STILL opens its per-run endpoint (the per-run path is unchanged) (HIGH)", async () => {
  const issue = issueFixture("issue-bp-claude-endpoint", "MT-BP-CLAUDE-EP");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = boxPoolWorkflowFixture();
  // Dispatch this issue to the `claude` kind -> agents.claude.executor === 'acp',
  // which DOES consume the per-run endpoint over the reverse tunnel.
  workflow.settings.agent.kind = "claude";
  assert.equal(workflow.settings.agents.claude?.executor, "acp");
  const lease = makeFakeLease({ workerHost: "ssh://worker-claude" });
  const boxPool = makeFakeBoxPool({ lease });
  const endpointLease = makeFakeEndpointLease();
  let openCalls = 0;
  const manager: McpEndpointManager = {
    perRunEndpoint: true,
    async open() {
      openCalls += 1;
      return endpointLease;
    },
    async release() {},
  };
  const coordinator = createDispatchCoordinator({
    pool: boxPool,
    mcpEndpointManager: manager,
    settings: workflow.settings.worker.boxPool!,
  });
  let runnerEndpoint: AgentMcpEndpointLease | null | undefined = "unset" as never;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      coordinator,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ mcpEndpoint }) => {
        runnerEndpoint = mcpEndpoint;
        return {
          workspace: "/tmp/symphony/MT-BP-CLAUDE-EP",
          turnCount: 1,
          updates: [],
          resumeId: "resume-claude-ep",
          agentKind: "claude",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  // The ACP run opened its per-run endpoint exactly once and the runner consumed it.
  assert.equal(openCalls, 1);
  assert.equal(runnerEndpoint, endpointLease);
  assert.equal(runtime.snapshot().runHistory[0]?.outcome, "success");
});

test("box pool: pending:// sentinel is visible between claim and acquire, real host after", async () => {
  const issue = issueFixture("issue-bp-sentinel", "MT-BP-SENTINEL");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const lease = makeFakeLease({ workerHost: "fake://box-sentinel" });
  let sentinelDuringAcquire: string | null | undefined;
  const boxPool = makeFakeBoxPool({
    result: () => {
      sentinelDuringAcquire = runtime
        .snapshot()
        .running.find((entry) => entry.issueId === issue.id)?.workerHost;
      return { status: "leased", lease };
    },
  });
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: boxPoolWorkflowFixture(),
      boxPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/symphony/MT-BP-SENTINEL",
        turnCount: 1,
        updates: [],
        resumeId: "resume",
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  assert.equal(sentinelDuringAcquire, `pending://${issue.id}/0`);
  assert.equal(runtime.snapshot().runHistory[0]?.workerHost, "fake://box-sentinel");
});

test("box pool: acquire uses the prior real workerHost as affinityKey on retry", async () => {
  const issue = issueFixture("issue-bp-affinity", "MT-BP-AFFINITY");
  const workflow = boxPoolWorkflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  // Seed a retry record carrying the prior real worker host (as finish() would).
  orchestrator.state.retryAttempts.set(slotKey(issue.id, 0), {
    issueId: issue.id,
    identifier: issue.identifier,
    attempt: 1,
    monotonicDeadlineMs: 0,
    dueAtIso: new Date(Date.now() - 1).toISOString(),
    slotIndex: 0,
    workerHost: "fake://box-prior",
    workspacePath: null,
  });
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const boxPool = makeFakeBoxPool({ lease: makeFakeLease({ workerHost: "fake://box-prior" }) });
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      boxPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/symphony/MT-BP-AFFINITY",
        turnCount: 1,
        updates: [],
        resumeId: "resume",
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  assert.equal(boxPool.acquireCalls.length, 1);
  assert.equal(boxPool.acquireCalls[0]?.affinityKey, "fake://box-prior");
  assert.equal(boxPool.acquireCalls[0]?.issueId, issue.id);
  assert.equal(boxPool.acquireCalls[0]?.slotIndex, 0);
  assert.equal(boxPool.acquireCalls[0]?.timeoutMs, 12_345);
});

test("box pool: no_capacity abandons the claim, skips the runner, records no history or backoff", async () => {
  const issue = issueFixture("issue-bp-nocap", "MT-BP-NOCAP");
  const workflow = boxPoolWorkflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  let runnerCalls = 0;
  const boxPool = makeFakeBoxPool({
    result: { status: "no_capacity", reason: "acquire_timeout" },
  });
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      boxPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        throw new Error("runner should not run on no_capacity");
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  const snapshot = runtime.snapshot();
  assert.equal(runnerCalls, 0);
  assert.equal(snapshot.runHistory.length, 0);
  assert.equal(snapshot.retrying.length, 0);
  assert.equal(snapshot.running.length, 0);
  assert.equal(orchestrator.state.claimed.size, 0);
  assert.equal(orchestrator.state.running.size, 0);
  assert.ok(snapshot.recentEvents.some((event) => event.message.includes("worker_host_capacity")));
});

test("box pool: a thrown acquire rejection abandons the claim, skips the runner, and re-claims next poll", async () => {
  // acquire() can REJECT (throw) outside the no_capacity result path (ledger /
  // filesystem / provider error). That rejection must be handled like a failed
  // dispatch: release the active handle, abandon the claim (so the slot is
  // re-evaluated next poll), emit a clear error event, and return WITHOUT
  // running and WITHOUT leaving the claim/handle dangling as a stuck 'running'.
  const issue = issueFixture("issue-bp-acq-throw", "MT-BP-ACQ-THROW");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = boxPoolWorkflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  let acquireAttempts = 0;
  let runnerCalls = 0;
  const boxPool = makeFakeBoxPool({
    result: () => {
      acquireAttempts += 1;
      // First acquire throws (provider/ledger fault); the second succeeds so the
      // re-claim on the next poll can actually run, proving the slot recovered.
      if (acquireAttempts === 1) throw new Error("ledger_write_failed: disk full");
      return { status: "leased", lease: makeFakeLease({ workerHost: "fake://box-recovered" }) };
    },
  });
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      boxPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () =>
          acquireAttempts >= 1 && runnerCalls === 0 ? [issue] : [issue],
      },
      runner: async () => {
        runnerCalls += 1;
        return {
          workspace: "/tmp/symphony/MT-BP-ACQ-THROW",
          turnCount: 1,
          updates: [],
          resumeId: "resume-acq",
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.pollOnce({ waitForRuns: true });

  // The throw must NOT run the runner, record history, schedule a retry, or leave
  // the issue stuck 'running' / claimed. The slot must be re-evaluable next poll.
  let snapshot = runtime.snapshot();
  assert.equal(acquireAttempts, 1);
  assert.equal(runnerCalls, 0);
  assert.equal(snapshot.runHistory.length, 0);
  assert.equal(snapshot.retrying.length, 0);
  assert.equal(snapshot.running.length, 0);
  assert.equal(orchestrator.state.claimed.size, 0);
  assert.equal(orchestrator.state.running.size, 0);
  // A clear error event surfaces the failure (not swallowed silently): the
  // message names the acquire error and carries the thrown error text.
  assert.ok(
    snapshot.recentEvents.some(
      (event) =>
        event.type === "dispatch_skipped" &&
        event.message.includes("box_pool_acquire_error") &&
        event.message.includes("ledger_write_failed: disk full"),
    ),
  );

  // A subsequent poll re-claims the slot and runs (no stuck-running): the second
  // acquire succeeds and the run completes against the recovered box.
  await runtime.pollOnce({ waitForRuns: true });
  snapshot = runtime.snapshot();
  assert.equal(acquireAttempts, 2);
  assert.equal(runnerCalls, 1);
  assert.equal(snapshot.runHistory.length, 1);
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(snapshot.runHistory[0]?.workerHost, "fake://box-recovered");
});

test("box pool: success path releases the lease as healthy", async () => {
  const issue = issueFixture("issue-bp-success", "MT-BP-SUCCESS");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const lease = makeFakeLease();
  const boxPool = makeFakeBoxPool({ lease });
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: boxPoolWorkflowFixture(),
      boxPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => ({
        workspace: "/tmp/symphony/MT-BP-SUCCESS",
        turnCount: 1,
        updates: [],
        resumeId: "resume",
        agentKind: "codex",
        finalIssue: doneIssue,
      }),
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  assert.deepEqual(lease.settles, [{ kind: "release", arg: "healthy" }]);
});

async function runBoxPoolClassifierCase(
  errorMessage: string,
  expected: { kind: "release" | "fail"; arg?: string },
): Promise<void> {
  const issue = issueFixture(`issue-bp-cls-${expected.kind}`, "MT-BP-CLS");
  const lease = makeFakeLease();
  const boxPool = makeFakeBoxPool({ lease });
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: boxPoolWorkflowFixture(),
      boxPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async () => {
        throw new Error(errorMessage);
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  assert.equal(lease.settles.length, 1);
  assert.equal(lease.settles[0]?.kind, expected.kind);
  if (expected.kind === "release") assert.equal(lease.settles[0]?.arg, "healthy");
}

test("box pool: ssh_timeout failure poisons the box (lease.fail)", async () => {
  await runBoxPoolClassifierCase("ssh_timeout: host 60000", { kind: "fail" });
});

test("box pool: workspace_prepare_failed poisons the box (lease.fail)", async () => {
  await runBoxPoolClassifierCase("workspace_prepare_failed: host 1 oops", { kind: "fail" });
});

test("box pool: remote_home_lookup_failed poisons the box (lease.fail)", async () => {
  await runBoxPoolClassifierCase("remote_home_lookup_failed: host empty_home", { kind: "fail" });
});

test("box pool: a remote workspace hook failure poisons the box (lease.fail)", async () => {
  // The remote workspace preparation runs a hook over SSH against the box's
  // workerHost; a non-zero hook exit throws `workspace hook failed with status N`.
  // That is a box-side fault (the box's environment is bad), so it must poison the
  // box and recycle it - not be returned to WARM_IDLE for re-lease.
  await runBoxPoolClassifierCase("workspace hook failed with status 2: setup.sh boom", {
    kind: "fail",
  });
});

test("box pool: a LOCAL hook failure keeps the box healthy (not the remote shape)", async () => {
  // The LOCAL hook failure string is `hook failed with status N` (no `workspace`
  // prefix) - a local/config fault that leaves the box reusable. It must stay
  // healthy so the remote-only poison prefix does not over-match.
  await runBoxPoolClassifierCase("hook failed with status 1: local boom", {
    kind: "release",
    arg: "healthy",
  });
});

test("box pool: ssh_not_found (local ENOENT) keeps the box healthy (NOT recycled)", async () => {
  await runBoxPoolClassifierCase("ssh_not_found", { kind: "release", arg: "healthy" });
});

test("box pool: invalid_ssh_timeout keeps the box healthy", async () => {
  await runBoxPoolClassifierCase("invalid_ssh_timeout: 0", { kind: "release", arg: "healthy" });
});

test("box pool: agent_run_aborted keeps the box healthy", async () => {
  await runBoxPoolClassifierCase("agent_run_aborted", { kind: "release", arg: "healthy" });
});

test("box pool: an ordinary agent failure keeps the box healthy", async () => {
  await runBoxPoolClassifierCase("agent exited: boom", { kind: "release", arg: "healthy" });
});

test("box pool: a stall-finished run poisons the box and keeps accounting correct", async () => {
  const issue = issueFixture("issue-bp-stall", "MT-BP-STALL");
  const root = await tempDir("symphony-ts-runtime-boxpool-stall");
  const workflow = boxPoolWorkflowFixture(root);
  workflow.settings.codex.stallTimeoutMs = 50;
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  const lease = makeFakeLease({ workerHost: "fake://box-stall" });
  const boxPool = makeFakeBoxPool({ lease });
  let aborted = false;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      boxPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal, onUpdate }) => {
        onUpdate?.({ type: "workspace_prepared", workspacePath: path.join(root, "workspace") });
        await new Promise<void>((_resolve, reject) => {
          abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("agent_run_aborted"));
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    }),
  );

  try {
    await runtime.pollOnce();
    // The run dispatches asynchronously; wait until its runner has emitted its
    // first update (workspace_prepared) so the stale timestamp we set below sticks
    // rather than being overwritten by a first update that lands on the next poll.
    await waitFor(() => orchestrator.snapshot().running[0]?.lastAgentTimestamp != null, 1_000);
    const running = orchestrator.snapshot().running[0];
    assert.ok(running);
    running.lastAgentTimestamp = new Date(Date.now() - 1_000);

    await runtime.pollOnce({ dryRun: true });
    await waitFor(() => aborted, 1_000);
    await waitFor(() => lease.settles.length === 1, 1_000);

    assert.equal(runtime.snapshot().runHistory[0]?.outcome, "stalled");
    assert.deepEqual(
      lease.settles.map((s) => s.kind),
      ["fail"],
    );
  } finally {
    runtime.stop();
  }
});

test("box pool: a stall-aborted run that RESOLVES SUCCESSFULLY still poisons the box (MEDIUM)", async () => {
  // Codex iter-6 MEDIUM: stall reconciliation sets handle.reason='stalled' and
  // aborts the run, but the runtime only converted that to a poison outcome in the
  // CATCH path. If the runner ignores the abort and races to a SUCCESSFUL resolve,
  // the success path early-returns with boxOutcome still 'healthy' -> the finally
  // releases the slot HEALTHY -> a stalled box is reused. The finally must override
  // boxOutcome='poison' whenever handle.reason==='stalled', independent of whether
  // the runner resolved or rejected.
  const issue = issueFixture("issue-bp-stall-success", "MT-BP-STALL-SUCCESS");
  const root = await tempDir("symphony-ts-runtime-boxpool-stall-success");
  const workflow = boxPoolWorkflowFixture(root);
  workflow.settings.codex.stallTimeoutMs = 50;
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  const lease = makeFakeLease({ workerHost: "fake://box-stall-success" });
  const boxPool = makeFakeBoxPool({ lease });
  let aborted = false;
  const runControl: { resolve?: (value: RunResult) => void } = {};
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      boxPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal, onUpdate }) => {
        onUpdate?.({ type: "workspace_prepared", workspacePath: path.join(root, "workspace") });
        // The runner RACES to a successful resolve after the abort instead of
        // rejecting: the stall already finished it externally, so this success must
        // NOT downgrade the box to healthy.
        abortSignal?.addEventListener("abort", () => {
          aborted = true;
        });
        return await new Promise<RunResult>((resolve) => {
          runControl.resolve = resolve;
        });
      },
    }),
  );

  try {
    await runtime.pollOnce();
    await waitFor(() => orchestrator.snapshot().running[0]?.lastAgentTimestamp != null, 1_000);
    const running = orchestrator.snapshot().running[0];
    assert.ok(running);
    running.lastAgentTimestamp = new Date(Date.now() - 1_000);

    // The stall reconciliation aborts the run (handle.reason='stalled').
    await runtime.pollOnce({ dryRun: true });
    await waitFor(() => aborted, 1_000);
    assert.equal(runtime.snapshot().runHistory[0]?.outcome, "stalled");

    // The runner now resolves SUCCESSFULLY (it ignored the abort / raced past it).
    runControl.resolve?.({
      workspace: path.join(root, "workspace"),
      turnCount: 1,
      updates: [],
      resumeId: "stall-then-success",
      agentKind: "codex",
      finalIssue: doneIssue,
    });
    await waitFor(() => lease.settles.length === 1, 1_000);

    // The box is POISONED (lease.fail), NOT released healthy: a stalled box must
    // never be reused even when the runner reports success after the abort.
    assert.deepEqual(
      lease.settles.map((s) => s.kind),
      ["fail"],
    );
    // The stall outcome is unchanged - no late success recorded.
    assert.equal(runtime.snapshot().runHistory[0]?.outcome, "stalled");
    assert.equal(runtime.snapshot().runHistory.length, 1);
  } finally {
    runtime.stop();
  }
});

test("box pool: a stale-generation late resolve is a lease no-op (leaseId guard)", async () => {
  const issue = issueFixture("issue-bp-stale-gen", "MT-BP-STALE-GEN");
  const root = await tempDir("symphony-ts-runtime-boxpool-stale-gen");
  const workflow = boxPoolWorkflowFixture(root);
  workflow.settings.agent.maxRetryBackoffMs = 0;
  workflow.settings.codex.stallTimeoutMs = 50;
  workflow.settings.agents.codex.stallTimeoutMs = 50;
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  // The first run's lease is "stale" - its settle is a guarded no-op (the box
  // record's leaseId moved on). The second run's lease settles normally. The retry
  // binds a FRESH box generation: the first (poisoned) box is recycled and a new box
  // is provisioned, so the leases carry distinct boxIds. This mirrors production - at
  // slotsPerMachine=1 the pool never re-leases a box whose prior slot is still live
  // (pool inFlight is freed only when the slot settles, which also deregisters it from
  // the coordinator), so a retry never collides with the still-registered stale slot.
  const staleLease = makeFakeLease({ leaseId: "lease-stale", boxId: "box-stale", stale: true });
  const freshLease = makeFakeLease({ leaseId: "lease-fresh", boxId: "box-fresh" });
  const leases = [staleLease, freshLease];
  let acquireIndex = 0;
  const boxPool = makeFakeBoxPool({
    result: () => {
      const lease = leases[acquireIndex] ?? freshLease;
      acquireIndex += 1;
      return { status: "leased", lease };
    },
  });
  const controls = new Map<number, { resolve: (value: RunResult) => void }>();
  let attempts = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      boxPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ abortSignal, onUpdate }) => {
        attempts += 1;
        const attempt = attempts;
        onUpdate?.({
          type: "workspace_prepared",
          workspacePath: path.join(root, `workspace-${attempt}`),
        });
        abortSignal?.addEventListener("abort", () => {});
        return await new Promise<RunResult>((resolve) => {
          controls.set(attempt, { resolve });
        });
      },
    }),
  );

  try {
    await runtime.pollOnce();
    // Wait until the first run's runner has emitted its first update so the stale
    // timestamp we set below sticks rather than being overwritten by a first update
    // that lands on the next poll.
    await waitFor(() => orchestrator.snapshot().running[0]?.lastAgentTimestamp != null, 1_000);
    const firstEntry = orchestrator.snapshot().running[0];
    assert.ok(firstEntry);
    firstEntry.lastAgentTimestamp = new Date(Date.now() - 1_000);

    await runtime.pollOnce({ dryRun: true });
    assert.equal(runtime.snapshot().runHistory[0]?.outcome, "stalled");

    await runtime.pollOnce();
    await waitFor(() => attempts === 2, 1_000);

    // The first (stale) generation resolves late; its finally calls the stale
    // lease whose settle is a guarded no-op.
    controls.get(1)?.resolve({
      workspace: path.join(root, "workspace-1"),
      turnCount: 1,
      updates: [],
      resumeId: "stale-late",
      agentKind: "codex",
      finalIssue: issue,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(staleLease.settles.length, 0);
  } finally {
    runtime.stop();
  }
});

test("box pool: onUpdate triggers a lease heartbeat", async () => {
  const issue = issueFixture("issue-bp-heartbeat", "MT-BP-HEARTBEAT");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const lease = makeFakeLease();
  const boxPool = makeFakeBoxPool({ lease });
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: boxPoolWorkflowFixture(),
      boxPool,
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ onUpdate }) => {
        onUpdate?.({ type: "turn_completed", sessionId: "s", resumeId: "r" });
        onUpdate?.({ type: "turn_completed", sessionId: "s", resumeId: "r" });
        return {
          workspace: "/tmp/symphony/MT-BP-HEARTBEAT",
          turnCount: 2,
          updates: [],
          resumeId: "r",
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  assert.equal(lease.heartbeats.count, 2);
});

test("box pool: reconcile is called on workflow reload with the next box-pool settings", async () => {
  const issue = issueFixture("issue-bp-reload", "MT-BP-RELOAD");
  const firstWorkflow = boxPoolWorkflowFixture();
  const secondWorkflow = boxPoolWorkflowFixture("/tmp/symphony-ts-runtime-boxpool-2", {
    max: 3,
  });
  const boxPool = makeFakeBoxPool({ canAcquire: false });
  let reloads = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      boxPool,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  assert.equal(boxPool.reconcileCalls.length, 1);
  assert.equal(boxPool.reconcileCalls[0]?.max, 3);
});

test("box pool: a reload that removes the box_pool block drains the live pool (no leak)", async () => {
  const issue = issueFixture("issue-bp-remove", "MT-BP-REMOVE");
  const firstWorkflow = boxPoolWorkflowFixture();
  // The reloaded workflow has NO worker.box_pool block at all.
  const secondWorkflow = workflowFixture("/tmp/symphony-ts-runtime-boxpool-removed");
  assert.equal(secondWorkflow.settings.worker.boxPool, undefined);
  const boxPool = makeFakeBoxPool({ canAcquire: false });
  let reloads = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      boxPool,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  // Removing the block must still reconcile the live pool to a disabled-equivalent
  // so it drains to zero instead of leaking its (paid) boxes.
  assert.equal(boxPool.reconcileCalls.length, 1);
  assert.equal(boxPool.reconcileCalls[0]?.enabled, false);
});

test("box pool: a reload that disables the box_pool block drains the live pool (no leak)", async () => {
  const issue = issueFixture("issue-bp-disable", "MT-BP-DISABLE");
  const firstWorkflow = boxPoolWorkflowFixture();
  const secondWorkflow = boxPoolWorkflowFixture("/tmp/symphony-ts-runtime-boxpool-disabled", {
    enabled: false,
  });
  assert.equal(secondWorkflow.settings.worker.boxPool?.enabled, false);
  const boxPool = makeFakeBoxPool({ canAcquire: false });
  let reloads = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      boxPool,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  // Disabling the block must reconcile so the pool drains to zero.
  assert.equal(boxPool.reconcileCalls.length, 1);
  assert.equal(boxPool.reconcileCalls[0]?.enabled, false);
});

test("box pool: a reload that disables the pool resumes dispatch via the local path (no lease, not blocked)", async () => {
  // Reload enabled -> disabled: the pool drains to zero and its canAcquire() now
  // returns false, but the orchestrator's lifetime probe stays installed. Dispatch
  // must RESUME via the local path (workerHost null), eligible work must NOT be
  // blocked as worker_host_capacity, and NO lease must be acquired against the
  // disabled pool.
  const issue = issueFixture("issue-bp-disabled-resume", "MT-BP-DISABLED-RESUME");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const firstWorkflow = boxPoolWorkflowFixture();
  const secondWorkflow = boxPoolWorkflowFixture(
    "/tmp/symphony-ts-runtime-boxpool-disabled-resume",
    { enabled: false },
  );
  let poolEnabled = true;
  // Once disabled the pool drains to zero: canAcquire() is false and the pool no
  // longer governs (isEnabled() false).
  const boxPool = makeFakeBoxPool({
    isEnabled: () => poolEnabled,
    canAcquire: () => poolEnabled,
  });
  let runnerWorkerHost: string | null | undefined = "unset";
  let reloads = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      boxPool,
      reloadWorkflow: async () => {
        reloads += 1;
        // The reconcile (driven below) flips the live pool to disabled.
        poolEnabled = false;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ workerHost }) => {
        runnerWorkerHost = workerHost;
        return {
          workspace: "/tmp/symphony/MT-BP-DISABLED-RESUME",
          turnCount: 1,
          updates: [],
          resumeId: "resume",
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  const snapshot = runtime.snapshot();
  assert.equal(reloads, 1);
  // The reload reconciled the pool to disabled.
  assert.equal(boxPool.reconcileCalls.length, 1);
  assert.equal(boxPool.reconcileCalls[0]?.enabled, false);
  // Dispatch resumed via the local path: no lease was acquired against the disabled
  // pool, and the runner ran with the local workerHost (null), not the sentinel.
  assert.equal(boxPool.acquireCalls.length, 0);
  assert.equal(runnerWorkerHost, null);
  // The run completed (not blocked as worker_host_capacity).
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(
    snapshot.recentEvents.some((event) => event.message.includes("worker_host_capacity")),
    false,
  );
});

test("box pool: a reload that re-enables the pool governs again and acquires a lease", async () => {
  // Reload disabled -> re-enabled: the pool governs once more, so a lease is
  // acquired and the leased workerHost (not the local null) drives the run.
  const issue = issueFixture("issue-bp-reenable", "MT-BP-REENABLE");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const firstWorkflow = boxPoolWorkflowFixture("/tmp/symphony-ts-runtime-boxpool-reenable-1", {
    enabled: false,
  });
  const secondWorkflow = boxPoolWorkflowFixture("/tmp/symphony-ts-runtime-boxpool-reenable-2", {
    enabled: true,
  });
  let poolEnabled = false;
  const lease = makeFakeLease({ workerHost: "fake://box-reenabled" });
  const boxPool = makeFakeBoxPool({
    isEnabled: () => poolEnabled,
    canAcquire: () => poolEnabled,
    lease,
  });
  let runnerWorkerHost: string | null | undefined = "unset";
  let reloads = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      boxPool,
      reloadWorkflow: async () => {
        reloads += 1;
        poolEnabled = true;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ workerHost }) => {
        runnerWorkerHost = workerHost;
        return {
          workspace: "/tmp/symphony/MT-BP-REENABLE",
          turnCount: 1,
          updates: [],
          resumeId: "resume",
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  const snapshot = runtime.snapshot();
  assert.equal(reloads, 1);
  assert.equal(boxPool.reconcileCalls.length, 1);
  assert.equal(boxPool.reconcileCalls[0]?.enabled, true);
  // The re-enabled pool governs again: a lease was acquired and drives the run.
  assert.equal(boxPool.acquireCalls.length, 1);
  assert.equal(runnerWorkerHost, "fake://box-reenabled");
  assert.equal(snapshot.runHistory[0]?.workerHost, "fake://box-reenabled");
  assert.deepEqual(
    lease.settles.map((s) => s.kind),
    ["release"],
  );
});

test("box pool: a reload that throws the anti-double-capacity guard keeps last-good and surfaces the message", async () => {
  const issue = issueFixture("issue-bp-guard", "MT-BP-GUARD");
  const firstWorkflow = boxPoolWorkflowFixture();
  const boxPool = makeFakeBoxPool({ canAcquire: false });
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      boxPool,
      reloadWorkflow: async () => {
        throw new Error("worker.box_pool.enabled cannot be combined with worker.ssh_hosts");
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  // Last-good settings retained: the box pool is still enabled.
  assert.equal(runtime.workflow.settings.worker.boxPool?.enabled, true);
  assert.equal(boxPool.reconcileCalls.length, 0);
  const reloadFailed = runtime
    .snapshot()
    .recentEvents.find((event) => event.type === "workflow_reload_failed");
  assert.ok(reloadFailed);
  assert.ok(reloadFailed.message.includes("cannot be combined with worker.ssh_hosts"));
});

function perRunEndpointManager(): McpEndpointManager {
  // A concrete-style manager (perRunEndpoint=true) so the coordinator advertises
  // the per-run-endpoint capability; open() returns null (no real endpoint needed
  // for the reload-gate tests, which never run an agent).
  return {
    perRunEndpoint: true,
    async open() {
      return null;
    },
    async release() {},
  };
}

test("box pool: a reload to max_in_flight>1 without co_residence is rejected (gate), keeps last-good, NOT reconciled", async () => {
  // Codex iter-3 HIGH #3: the slots-per-machine co-residence gate ran ONLY at
  // startup. A live daemon could reload max_in_flight 1 -> >1 WITHOUT co_residence
  // and silently widen the shared-machine blast radius the startup gate rejects.
  // The reload path must enforce the SAME gate: keep last-good settings, do NOT
  // reconcile the live pool onto the unsafe settings, and emit
  // workflow_reload_failed with the gate's message.
  const issue = issueFixture("issue-bp-reload-gate", "MT-BP-RELOAD-GATE");
  const firstWorkflow = boxPoolWorkflowFixture();
  // The reloaded workflow raises max_in_flight to 2 but supplies NO co_residence
  // opt-in: the gate must reject it even though the coordinator IS capable.
  const secondWorkflow = boxPoolWorkflowFixture("/tmp/symphony-ts-runtime-boxpool-reload-gate", {
    max_in_flight: 2,
  });
  assert.equal(secondWorkflow.settings.worker.boxPool?.slotsPerMachine, 2);
  assert.equal(secondWorkflow.settings.worker.boxPool?.coResidence, undefined);
  const boxPool = makeFakeBoxPool({ canAcquire: false });
  const coordinator = createDispatchCoordinator({
    pool: boxPool,
    mcpEndpointManager: perRunEndpointManager(),
    settings: firstWorkflow.settings.worker.boxPool!,
  });
  let reloads = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      coordinator,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  // Last-good settings retained: still the original single-slot box pool.
  assert.equal(runtime.workflow.settings.worker.boxPool?.slotsPerMachine, 1);
  // The coordinator must NOT have reconciled onto the unsafe slotsPerMachine>1.
  assert.equal(boxPool.reconcileCalls.length, 0);
  const reloadFailed = runtime
    .snapshot()
    .recentEvents.find((event) => event.type === "workflow_reload_failed");
  assert.ok(reloadFailed);
  assert.match(reloadFailed!.message, /co.?residence/i);
  // No workflow_reloaded event was emitted for the rejected reload.
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "workflow_reloaded"),
    false,
  );
});

test("box pool: a reload to max_in_flight>1 without the per-run-endpoint capability is rejected (gate)", async () => {
  // A bare boxPool wraps in a null-endpoint coordinator (perRunEndpoint=false), so
  // even WITH the co_residence opt-in the gate must reject slotsPerMachine>1 for
  // lack of the per-run-endpoint capability - mirroring the startup gate.
  const issue = issueFixture("issue-bp-reload-endpoint", "MT-BP-RELOAD-ENDPOINT");
  const firstWorkflow = boxPoolWorkflowFixture();
  const secondWorkflow = boxPoolWorkflowFixture(
    "/tmp/symphony-ts-runtime-boxpool-reload-endpoint",
    { max_in_flight: 2, co_residence: true },
  );
  const boxPool = makeFakeBoxPool({ canAcquire: false });
  let reloads = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      // Bare boxPool -> null-endpoint passthrough coordinator (perRunEndpoint=false).
      boxPool,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  assert.equal(runtime.workflow.settings.worker.boxPool?.slotsPerMachine, 1);
  assert.equal(boxPool.reconcileCalls.length, 0);
  const reloadFailed = runtime
    .snapshot()
    .recentEvents.find((event) => event.type === "workflow_reload_failed");
  assert.ok(reloadFailed);
  assert.match(reloadFailed!.message, /per-run.*endpoint|perRunEndpoint/i);
});

test("box pool: a reload to max_in_flight>1 WITH co_residence + per-run-endpoint applies and reconciles", async () => {
  // The safe widening: a capable coordinator + the explicit co_residence opt-in.
  // The gate passes, so the reload applies and the live pool is reconciled onto the
  // new slotsPerMachine>1 settings.
  const issue = issueFixture("issue-bp-reload-ok", "MT-BP-RELOAD-OK");
  const firstWorkflow = boxPoolWorkflowFixture();
  const secondWorkflow = boxPoolWorkflowFixture("/tmp/symphony-ts-runtime-boxpool-reload-ok", {
    max_in_flight: 2,
    co_residence: true,
  });
  const boxPool = makeFakeBoxPool({ canAcquire: false });
  const coordinator = createDispatchCoordinator({
    pool: boxPool,
    mcpEndpointManager: perRunEndpointManager(),
    settings: firstWorkflow.settings.worker.boxPool!,
  });
  let reloads = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      coordinator,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  // The reload applied: settings now carry slotsPerMachine=2.
  assert.equal(runtime.workflow.settings.worker.boxPool?.slotsPerMachine, 2);
  // The live pool was reconciled onto the new settings.
  assert.equal(boxPool.reconcileCalls.length, 1);
  assert.equal(boxPool.reconcileCalls[0]?.slotsPerMachine, 2);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "workflow_reloaded"),
    true,
  );
});

test("box pool: a default (slotsPerMachine=1) reload applies unchanged through the gate", async () => {
  // The byte-identical default path: slotsPerMachine stays 1, the gate never
  // triggers, the reload applies and reconciles exactly as before.
  const issue = issueFixture("issue-bp-reload-default", "MT-BP-RELOAD-DEFAULT");
  const firstWorkflow = boxPoolWorkflowFixture();
  const secondWorkflow = boxPoolWorkflowFixture("/tmp/symphony-ts-runtime-boxpool-reload-default", {
    max: 3,
  });
  assert.equal(secondWorkflow.settings.worker.boxPool?.slotsPerMachine, 1);
  const boxPool = makeFakeBoxPool({ canAcquire: false });
  let reloads = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      boxPool,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  assert.equal(boxPool.reconcileCalls.length, 1);
  assert.equal(boxPool.reconcileCalls[0]?.max, 3);
  assert.equal(boxPool.reconcileCalls[0]?.slotsPerMachine, 1);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "workflow_reload_failed"),
    false,
  );
});

test("box pool: a reload whose reconcile throws keeps last-good settings AND the live pool unchanged (transactional)", async () => {
  // Codex iter-5 HIGH (non-transactional reload): the reload assigned
  // this.input.workflow + this.orchestrator.settings BEFORE coordinator.reconcile.
  // If reconcile throws (e.g. provider unavailable / invalid providerOptions), the
  // catch emits workflow_reload_failed but the runtime has ALREADY switched to the
  // failed settings - 'last-good' is violated and dispatch uses settings that do not
  // match the live pool/coordinator. The reload must be transactional: run the
  // throwing reconcile side effect FIRST and only swap runtime settings AFTER it
  // succeeds. On failure, BOTH the runtime settings AND the pool state stay on the
  // PREVIOUS config.
  const issue = issueFixture("issue-bp-reload-reconcile-throws", "MT-BP-RELOAD-RECONCILE");
  const firstWorkflow = boxPoolWorkflowFixture();
  assert.equal(firstWorkflow.settings.worker.boxPool?.max, 1);
  const secondWorkflow = boxPoolWorkflowFixture(
    "/tmp/symphony-ts-runtime-boxpool-reload-reconcile",
    { max: 3 },
  );
  assert.equal(secondWorkflow.settings.worker.boxPool?.max, 3);
  // The pool rejects the reconcile (e.g. provider unavailable on the new settings).
  const boxPool = makeFakeBoxPool({
    canAcquire: false,
    reconcileError: "provider unavailable",
  });
  let reloads = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: firstWorkflow,
      boxPool,
      reloadWorkflow: async () => {
        reloads += 1;
        return secondWorkflow;
      },
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(reloads, 1);
  // Last-good is preserved: the runtime still carries the FIRST workflow's settings
  // (boxPool.max unchanged at 1, NOT the failed reload's 3) and the FIRST workflow.
  assert.equal(runtime.workflow.settings.worker.boxPool?.max, 1);
  assert.equal(runtime.workflow.path, firstWorkflow.path);
  assert.equal(runtime.workflow, firstWorkflow);
  // The failure surfaced as workflow_reload_failed carrying the reconcile message...
  const reloadFailed = runtime
    .snapshot()
    .recentEvents.find((event) => event.type === "workflow_reload_failed");
  assert.ok(reloadFailed);
  assert.ok(reloadFailed.message.includes("provider unavailable"));
  // ...and NO workflow_reloaded event was emitted for the rejected reload.
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "workflow_reloaded"),
    false,
  );
});

test("box pool: drainBoxPool awaits the pool drain with the configured deadline", async () => {
  const boxPool = makeFakeBoxPool();
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: boxPoolWorkflowFixture(),
      boxPool,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  await runtime.drainBoxPool();
  // Idempotent: a second call does not drain again.
  await runtime.drainBoxPool();

  assert.equal(boxPool.drainCalls.length, 1);
  assert.equal(boxPool.drainCalls[0]?.deadlineMs, 9_999);
});

test("box pool: drainBoxPool resolves as a no-op when no pool is configured", async () => {
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [],
      },
    }),
  );

  await runtime.drainBoxPool();
});

test("box pool undefined: byte-identical regression (acquire and classifier never invoked)", async () => {
  const issue = issueFixture("issue-no-bp", "MT-NO-BP");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  let runnerWorkerHost: string | null | undefined = "unset";
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: workflowFixture(),
      client: {
        fetchCandidateIssues: async () => [issue],
        fetchIssuesByIds: async () => [issue],
      },
      runner: async ({ workerHost }) => {
        runnerWorkerHost = workerHost;
        return {
          workspace: "/tmp/symphony/MT-NO-BP",
          turnCount: 1,
          updates: [],
          resumeId: "resume",
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  await runtime.start({ once: true, dryRun: false });

  // No box pool means the static local path is taken: workerHost is null, no
  // pending sentinel, no lease, success recorded exactly as before.
  assert.equal(runnerWorkerHost, null);
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.runHistory[0]?.outcome, "success");
  assert.equal(snapshot.runHistory[0]?.workerHost ?? null, null);
});

test("runtime reconcile skips remote workspace cleanup for a pending:// sentinel workerHost", async () => {
  const workflow = workflowFixture();
  // A capacity probe makes claim() assign the `pending://<id>/<slot>` sentinel as
  // workerHost, reproducing the claim->acquire window where no real box is leased yet.
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  const issue = issueFixture("issue-sentinel-terminal", "MT-SENTINEL-TERMINAL");
  const claimed = orchestrator.claim(issue);
  assert.ok(claimed);
  assert.equal(claimed?.workerHost, "pending://issue-sentinel-terminal/0");

  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  let removeCalls = 0;
  let observedWorkerHost: string | null | undefined = "unset";
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [doneIssue],
      },
      removeIssueWorkspaces: async (_settings, _identifier, workerHost) => {
        removeCalls += 1;
        observedWorkerHost = workerHost;
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  // The terminal branch must still clean up the (local) workspace, but it must NOT
  // hand the `pending://` sentinel to the cleanup sink as if it were a real remote
  // host (which would trigger a doomed SSH to `pending://...`).
  assert.equal(removeCalls, 1);
  assert.equal(observedWorkerHost ?? null, null);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "workspace_cleanup"),
    true,
  );
});

test("runtime reconcile still passes a real workerHost to remote workspace cleanup", async () => {
  const workflow = workflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  const issue = issueFixture("issue-real-terminal", "MT-REAL-TERMINAL");
  assert.ok(orchestrator.claim(issue));
  // A real lease has resolved: the sentinel was overwritten with the box address.
  orchestrator.setWorkerHost(issue.id, 0, "ssh://box-real");

  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  let observedWorkerHost: string | null | undefined = "unset";
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [doneIssue],
      },
      removeIssueWorkspaces: async (_settings, _identifier, workerHost) => {
        observedWorkerHost = workerHost;
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(observedWorkerHost, "ssh://box-real");
});

test("runtime reconcile skips remote resume-state delete for a pending:// sentinel workerHost", async () => {
  const workflow = workflowFixture();
  const orchestrator = new Orchestrator(workflow.settings, undefined, undefined, {
    governs: () => true,
    canAcquire: () => true,
  });
  const issue = issueFixture("issue-sentinel-resume", "MT-SENTINEL-RESUME");
  const claimed = orchestrator.claim(issue);
  assert.ok(claimed);
  assert.equal(claimed?.workerHost, "pending://issue-sentinel-resume/0");
  // A workspace exists so the non-terminal reconcile branch invalidates resume state.
  // The snapshot exposes the live running-entry reference.
  claimed.workspacePath = "/tmp/symphony/MT-SENTINEL-RESUME";

  // Non-terminal but inactive (state not in active_states, not terminal) -> reconciled,
  // resume-state invalidated rather than workspace removed.
  const canceledIssue: Issue = { ...issue, state: "Canceled", stateType: "canceled" };
  let deleteCalls = 0;
  let observedWorkerHost: string | null | undefined = "unset";
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      orchestrator,
      client: {
        fetchCandidateIssues: async () => [],
        fetchIssuesByIds: async () => [canceledIssue],
      },
      deleteResumeState: async (_workspace, workerHost) => {
        deleteCalls += 1;
        observedWorkerHost = workerHost;
      },
    }),
  );

  await runtime.pollOnce({ dryRun: true });

  assert.equal(deleteCalls, 1);
  assert.equal(observedWorkerHost ?? null, null);
  assert.equal(
    runtime.snapshot().recentEvents.some((event) => event.type === "resume_state_invalidated"),
    true,
  );
});

test("runtime replays retry timer due while a poll is active", async () => {
  const issue = issueFixture("issue-timer-overlap", "MT-TIMER-OVERLAP");
  const doneIssue: Issue = { ...issue, state: "Done", stateType: "completed" };
  const workflow = workflowFixture();
  workflow.settings.polling.intervalMs = 60_000;
  workflow.settings.agent.maxRetryBackoffMs = 1;
  const fetchControl: { release?: () => void } = {};
  let attempts = 0;
  let blockCandidateFetch = false;
  let candidateFetches = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow,
      client: {
        fetchCandidateIssues: async () => {
          candidateFetches += 1;
          if (blockCandidateFetch) {
            blockCandidateFetch = false;
            await new Promise<void>((resolve) => {
              fetchControl.release = resolve;
            });
          }
          return [issue];
        },
        fetchIssuesByIds: async () => (attempts >= 2 ? [doneIssue] : [issue]),
      },
      runner: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("agent exited: retry me");
        return {
          workspace: "/tmp/symphony/MT-TIMER-OVERLAP",
          turnCount: 1,
          updates: [],
          resumeId: "timer-overlap",
          agentKind: "codex",
          finalIssue: doneIssue,
        };
      },
    }),
  );

  try {
    await runtime.pollOnce({ waitForRuns: true });
    assert.equal(attempts, 1);
    blockCandidateFetch = true;

    const dryPoll = runtime.pollOnce({ dryRun: true });
    await waitFor(() => candidateFetches === 2, 1_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const unblockFetch = fetchControl.release;
    assert.ok(unblockFetch);
    unblockFetch();
    await dryPoll;

    await waitFor(() => attempts === 2, 1_000);
    assert.equal(
      runtime.snapshot().recentEvents.some((event) => event.type === "retry_timer_due"),
      true,
    );
  } finally {
    runtime.stop();
  }
});

function workflowFixture(root = "/tmp/symphony-ts-runtime-test"): WorkflowDefinition {
  const settings = parseConfig({
    tracker: {
      kind: "linear",
      api_key: "linear-token",
      project_slug: "mono",
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Done"],
    },
    polling: { interval_ms: 5 },
    workspace: { root },
  });
  return {
    path: "/tmp/WORKFLOW.md",
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };
}

function workflowMarkdown({
  acceptUnrouted = true,
  intervalMs = 5,
  prompt = "Issue {{ issue.identifier }}",
}: {
  acceptUnrouted?: boolean;
  intervalMs?: number;
  prompt?: string;
} = {}): string {
  return [
    "---",
    "tracker:",
    "  kind: linear",
    "  api_key: linear-token",
    "  project_slug: mono",
    "  active_states:",
    "    - Todo",
    "    - In Progress",
    "  terminal_states:",
    "    - Done",
    "  dispatch:",
    `    accept_unrouted: ${acceptUnrouted}`,
    "polling:",
    `  interval_ms: ${intervalMs}`,
    "---",
    prompt,
  ].join("\n");
}

function issueFixture(id: string, identifier: string): Issue {
  return normalizeIssue({
    id,
    identifier,
    title: "Runtime fixture",
    state: { name: "Todo", type: "unstarted" },
    labels: [],
    blockers: [],
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  await vi.waitFor(
    async () => {
      if (!(await predicate())) throw new Error("condition not met");
    },
    { timeout: timeoutMs, interval: 10 },
  );
}

async function fileText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
