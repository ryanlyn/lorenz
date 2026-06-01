import fs from "node:fs/promises";
import path from "node:path";

import { test, vi } from "vitest";
import {
  createWorkspaceForIssue,
  normalizeIssue,
  Orchestrator,
  parseConfig,
  runtimeAdapters,
} from "@symphony/cli";
import type { Issue, RunResult, SymphonyRuntimeOptions, WorkflowDefinition } from "@symphony/cli";

import { assert } from "../../../test/assert.js";
import { tempDir, writeExecutable } from "../../../test/helpers.js";

import { SymphonyRuntime } from "@symphony/runtime";

function runtimeOptions(options: SymphonyRuntimeOptions): SymphonyRuntimeOptions {
  return { ...runtimeAdapters, ...options };
}

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
  assert.equal(retry.identifier, "MT-INACTIVE-CONTINUATION");
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
        onUpdate?.({ type: "workspace_prepared", workspacePath: workspace });
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
        onUpdate?.({ type: "workspace_prepared", workspacePath: workspace });
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

  const retry = orchestrator.snapshot().retrying[0];
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
        onUpdate?.({ type: "workspace_prepared", workspacePath: workspace });
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
