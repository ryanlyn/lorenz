import { readFile } from "node:fs/promises";
import path from "node:path";

import { LocalTrackerClient } from "@symphony/local-tracker";
import { test } from "vitest";
import { parse as parseYaml } from "yaml";

import { assert } from "../../../test/assert.js";

import {
  createTrackerClient,
  memoryIssuesFromEnv,
  MemoryTrackerClient,
  parseConfig,
} from "@symphony/cli";

function frontmatter(raw: string): Record<string, unknown> {
  const end = raw.indexOf("\n---", 3);
  return parseYaml(raw.slice(raw.indexOf("\n") + 1, end)) as Record<string, unknown>;
}

function body(raw: string): string {
  const end = raw.indexOf("\n---", 3);
  return raw.slice(raw.indexOf("\n", end + 1) + 1).trim();
}

test("memory tracker adapter returns configured issues and filters by id", async () => {
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

test("tracker factory selects local adapter from the workflow-local fixture", async () => {
  const raw = await readFile(
    path.join(import.meta.dirname, "../../../test/fixtures/workflow-local.md"),
    "utf8",
  );
  const settings = parseConfig(frontmatter(raw), {});
  assert.equal(settings.tracker.kind, "local");
  assert.ok(createTrackerClient(settings) instanceof LocalTrackerClient);
});

test("shipped WORKFLOW.local.md selects a local tracker client with a real playbook body", async () => {
  const raw = await readFile(path.join(import.meta.dirname, "../../../WORKFLOW.local.md"), "utf8");
  const settings = parseConfig(frontmatter(raw), {});
  assert.equal(settings.tracker.kind, "local");
  assert.equal(settings.tracker.path, ".symphony/local/symphony");
  assert.ok(createTrackerClient(settings) instanceof LocalTrackerClient);

  const prose = body(raw);
  assert.ok(prose.split("\n").length > 20, "local playbook body should be a real playbook");
  assert.match(prose, /local_update_status/);
  assert.match(prose, /local_comment/);
  assert.match(prose, /local_create_issue/);
  assert.notMatch(prose, /stop and ask the user to configure Linear/i);

  // A worker only has its cloned repo workspace + the rendered issue context, not the
  // daemon's board directory, so the playbook must NOT instruct reading the board file for
  // state. State comes from the rendered `Current status` line instead. (A passing
  // "BOARD-<n>.md" reference is fine; an instruction to READ it for state is not.)
  assert.notMatch(prose, /read the issue file/i);
  assert.notMatch(prose, /read .*BOARD-<n>\.md/i);
  assert.match(prose, /Current status/);
});
