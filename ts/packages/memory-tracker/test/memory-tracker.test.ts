import { test } from "vitest";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import { MemoryTrackerClient, memoryIssuesFromEnv } from "@symphony/memory-tracker";

function makeIssue(overrides: Partial<Issue> & { id: string; identifier: string }): Issue {
  return {
    title: "Default title",
    state: "Todo",
    stateType: "unstarted",
    labels: [],
    blockers: [],
    ...overrides,
  };
}

// --- fetchIssuesByIds ---

test("stores and retrieves issues by ID", async () => {
  const issueA = makeIssue({ id: "a1", identifier: "MT-1", title: "First" });
  const issueB = makeIssue({ id: "b2", identifier: "MT-2", title: "Second" });
  const issueC = makeIssue({ id: "c3", identifier: "MT-3", title: "Third" });

  const client = new MemoryTrackerClient([issueA, issueB, issueC]);

  const result = await client.fetchIssuesByIds(["b2", "c3"]);

  assert.equal(result.length, 2);
  assert.equal(result[0]!.id, "b2");
  assert.equal(result[1]!.id, "c3");
});

// --- fetchIssuesByStates ---

test("filters issues by state", async () => {
  const todo = makeIssue({ id: "1", identifier: "MT-1", state: "Todo" });
  const inProgress = makeIssue({
    id: "2",
    identifier: "MT-2",
    state: "In Progress",
    stateType: "started",
  });
  const done = makeIssue({ id: "3", identifier: "MT-3", state: "Done", stateType: "completed" });

  const client = new MemoryTrackerClient([todo, inProgress, done]);

  const result = await client.fetchIssuesByStates(["In Progress"]);

  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "2");
  assert.equal(result[0]!.state, "In Progress");
});

// --- claimIssue equivalent: state filtering transitions ---

test("fetchIssuesByStates matches case-insensitively (claimed state lookup)", async () => {
  const issue = makeIssue({
    id: "1",
    identifier: "MT-1",
    state: "In Progress",
    stateType: "started",
  });

  const client = new MemoryTrackerClient([issue]);

  const result = await client.fetchIssuesByStates(["in progress"]);

  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "1");
});

// --- releaseIssue equivalent: issue returns to unclaimed pool ---

test("fetchCandidateIssues returns all stored issues", async () => {
  const issueA = makeIssue({ id: "a", identifier: "MT-1", state: "Todo" });
  const issueB = makeIssue({
    id: "b",
    identifier: "MT-2",
    state: "In Progress",
    stateType: "started",
  });

  const client = new MemoryTrackerClient([issueA, issueB]);

  const candidates = await client.fetchCandidateIssues();

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]!.id, "a");
  assert.equal(candidates[1]!.id, "b");
});

// --- updateIssueState equivalent: state persists across queries ---

test("fetchIssuesByStates finds issues whose state matches any of the provided states", async () => {
  const issues = [
    makeIssue({ id: "1", identifier: "MT-1", state: "Todo" }),
    makeIssue({ id: "2", identifier: "MT-2", state: "In Progress", stateType: "started" }),
    makeIssue({ id: "3", identifier: "MT-3", state: "Done", stateType: "completed" }),
    makeIssue({ id: "4", identifier: "MT-4", state: "Todo" }),
  ];

  const client = new MemoryTrackerClient(issues);

  const result = await client.fetchIssuesByStates(["Todo", "Done"]);

  assert.equal(result.length, 3);
  const ids = result.map((i) => i.id).sort();
  assert.deepEqual(ids, ["1", "3", "4"]);
});

// --- mutation safety ---

test("returned issues are copies, not references to internal state", async () => {
  const original = makeIssue({
    id: "1",
    identifier: "MT-1",
    title: "Original",
    labels: ["bug"],
    blockers: [{ id: "b1", state: "Todo" }],
  });

  const client = new MemoryTrackerClient([original]);

  const [fetched] = await client.fetchIssuesByIds(["1"]);
  fetched!.title = "Mutated";
  fetched!.labels.push("hacked");
  fetched!.blockers.push({ id: "b2" });

  const [refetched] = await client.fetchIssuesByIds(["1"]);
  assert.equal(refetched!.title, "Original");
  assert.equal(refetched!.labels.length, 1);
  assert.equal(refetched!.blockers.length, 1);
});

// --- empty results ---

test("returns empty array when no issues match filter", async () => {
  const issue = makeIssue({ id: "1", identifier: "MT-1", state: "Todo" });

  const client = new MemoryTrackerClient([issue]);

  const byId = await client.fetchIssuesByIds(["nonexistent"]);
  assert.equal(byId.length, 0);

  const byState = await client.fetchIssuesByStates(["Canceled"]);
  assert.equal(byState.length, 0);
});

// --- constructor with raw records ---

test("constructor normalizes raw record objects into Issue instances", async () => {
  const raw = {
    id: "raw-1",
    identifier: "MT-99",
    title: "From raw",
    state: { name: "Backlog", type: "backlog" },
    labels: [{ name: "Feature" }],
  };

  const client = new MemoryTrackerClient([raw]);

  const [issue] = await client.fetchCandidateIssues();
  assert.equal(issue!.id, "raw-1");
  assert.equal(issue!.identifier, "MT-99");
  assert.equal(issue!.state, "Backlog");
  assert.deepEqual(issue!.labels, ["feature"]);
});

// --- memoryIssuesFromEnv ---

test("memoryIssuesFromEnv parses JSON from environment variable", () => {
  const env = {
    SYMPHONY_MEMORY_TRACKER_ISSUES_JSON: JSON.stringify([
      { id: "e1", identifier: "MT-1", title: "Env issue", state: { name: "Todo" } },
    ]),
  } as unknown as NodeJS.ProcessEnv;

  const issues = memoryIssuesFromEnv(env);

  assert.equal(issues.length, 1);
  assert.equal((issues[0] as Record<string, unknown>).id, "e1");
});

test("memoryIssuesFromEnv returns empty array when env var is not set", () => {
  const issues = memoryIssuesFromEnv({} as NodeJS.ProcessEnv);
  assert.deepEqual(issues, []);
});

test("memoryIssuesFromEnv throws when JSON is not an array", () => {
  const env = {
    SYMPHONY_MEMORY_TRACKER_ISSUES_JSON: JSON.stringify({ not: "array" }),
  } as unknown as NodeJS.ProcessEnv;

  assert.throws(() => memoryIssuesFromEnv(env), /must be a JSON array/);
});
