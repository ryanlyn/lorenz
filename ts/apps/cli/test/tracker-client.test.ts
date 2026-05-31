import { test } from "vitest";

import { assert } from "../../../test/assert.js";

import {
  createTrackerClient,
  memoryIssuesFromEnv,
  MemoryTrackerClient,
  parseConfig,
} from "@symphony/cli";

test("memory tracker adapter returns configured issues and filters by id like Elixir", async () => {
  const client = new MemoryTrackerClient([
    {
      id: "one",
      identifier: "MT-1",
      title: "One",
      state: "Todo",
      stateType: "unstarted",
      labels: ["Symphony:Backend"],
    },
    { id: "two", identifier: "MT-2", title: "Two", state: "Done", stateType: "completed" },
  ]);

  const candidates = await client.fetchCandidateIssues();
  assert.deepEqual(
    candidates.map((issue) => issue.identifier),
    ["MT-1", "MT-2"],
  );
  assert.deepEqual(candidates[0]?.labels, ["symphony:backend"]);

  candidates[0]!.labels.push("mutated");
  const byId = await client.fetchIssuesByIds(["two", "missing", "one"]);
  assert.deepEqual(
    byId.map((issue) => issue.identifier),
    ["MT-1", "MT-2"],
  );
  assert.deepEqual((await client.fetchCandidateIssues())[0]?.labels, ["symphony:backend"]);
});

test("tracker factory selects memory adapter from workflow settings and JSON env", async () => {
  const settings = parseConfig({ tracker: { kind: "memory" } }, {});
  const client = createTrackerClient(settings, {
    SYMPHONY_MEMORY_TRACKER_ISSUES_JSON: JSON.stringify([
      { id: "env", identifier: "MT-ENV", title: "Env", state: "Todo", stateType: "unstarted" },
    ]),
  });

  assert.ok(client instanceof MemoryTrackerClient);
  assert.deepEqual(
    (await client.fetchCandidateIssues()).map((issue) => issue.identifier),
    ["MT-ENV"],
  );
  assert.deepEqual(memoryIssuesFromEnv({ SYMPHONY_MEMORY_TRACKER_ISSUES_JSON: "[]" }), []);
  assert.throws(
    () => memoryIssuesFromEnv({ SYMPHONY_MEMORY_TRACKER_ISSUES_JSON: "{}" }),
    /must be a JSON array/,
  );
});
