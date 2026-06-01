import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BoardStore } from "@symphony/local-tracker";
import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import {
  createTrackerClient,
  parseConfig,
  runtimeAdapters,
  SymphonyRuntime,
  type SymphonyRuntimeOptions,
  type WorkflowDefinition,
} from "@symphony/cli";

function runtimeOptions(options: SymphonyRuntimeOptions): SymphonyRuntimeOptions {
  return { ...runtimeAdapters, ...options };
}

function workflow(settings: WorkflowDefinition["settings"]): WorkflowDefinition {
  return {
    path: "/tmp/WORKFLOW.md",
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };
}

test("runtime discovers a Todo issue from a real local board via createTrackerClient", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "runtime-local-e2e-"));
  await mkdir(dir, { recursive: true });
  const store = new BoardStore(dir);
  await store.create({ title: "Fix the thing", status: "Todo" });
  await store.create({ title: "Already shipped", status: "Done" });

  const settings = parseConfig(
    {
      tracker: { kind: "local", path: dir, active_states: ["Todo"], terminal_states: ["Done"] },
      polling: { interval_ms: 5 },
      workspace: { root: dir },
    },
    {},
  );

  // The production factory must hand back a client whose fetchCandidateIssues yields the
  // real board's Todo issue (and only it), proving the local tracker is wired end-to-end.
  const client = createTrackerClient(settings);
  assert.deepEqual(
    (await client.fetchCandidateIssues()).map((issue) => issue.identifier),
    ["BOARD-1"],
  );

  let runnerCalls = 0;
  const runtime = new SymphonyRuntime(
    runtimeOptions({
      workflow: workflow(settings),
      client,
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
  assert.ok(snapshot.recentEvents.some((event) => event.type === "dry_run"));
});
