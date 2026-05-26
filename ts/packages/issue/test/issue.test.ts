import { test } from "vitest";
import { normalizeIssue, ensembleSize, isTerminalState } from "@symphony/cli";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

// --- normalizeIssue ---

test("normalizeIssue — throws if id is missing", () => {
  assert.throws(
    () => normalizeIssue({ identifier: "X-1", title: "T", state: { name: "Todo" } }),
    /issue\.id is required/,
  );
});

test("normalizeIssue — throws if identifier is missing", () => {
  assert.throws(
    () => normalizeIssue({ id: "1", title: "T", state: { name: "Todo" } }),
    /issue\.identifier is required/,
  );
});

test("normalizeIssue — throws if title is missing", () => {
  assert.throws(
    () => normalizeIssue({ id: "1", identifier: "X-1", state: { name: "Todo" } }),
    /issue\.title is required/,
  );
});

test("normalizeIssue — throws if state is missing", () => {
  assert.throws(
    () => normalizeIssue({ id: "1", identifier: "X-1", title: "T" }),
    /issue\.state is required/,
  );
});

test("normalizeIssue — extracts blocker relations (blocks type mapping)", () => {
  const issue = normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "Title",
    state: { name: "Todo" },
    relations: [
      {
        type: " Blocks ",
        relatedIssue: {
          id: "b1",
          identifier: "MT-0",
          state: { name: "Done", type: "completed" },
        },
      },
      {
        type: "Relates",
        relatedIssue: { id: "r1", identifier: "MT-2", state: { name: "Todo" } },
      },
    ],
  });

  assert.equal(issue.blockers.length, 1);
  assert.equal(issue.blockers[0]!.id, "b1");
  assert.equal(issue.blockers[0]!.identifier, "MT-0");
  assert.equal(issue.blockers[0]!.state, "Done");
  assert.equal(issue.blockers[0]!.stateType, "completed");
});

test("normalizeIssue — assigns assignedToWorker=false if assignee does not match current worker", () => {
  const issue = normalizeIssue(
    {
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "Todo" },
      assignee: { id: "alice@example.com" },
    },
    "bob@example.com",
  );

  assert.equal(issue.assignedToWorker, false);
});

test("normalizeIssue — assigns assignedToWorker=true if assignee matches (case-insensitive)", () => {
  const issue = normalizeIssue(
    {
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "Todo" },
      assignee: { id: "Alice@Example.com" },
    },
    "alice@example.com",
  );

  assert.equal(issue.assignedToWorker, true);
});

// --- ensembleSize ---

test("ensembleSize — parses ensemble:X label to return X", () => {
  const issue: Issue = normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "Title",
    state: { name: "Todo" },
    labels: ["ensemble:3"],
  });

  assert.equal(ensembleSize(issue), 3);
});

test("ensembleSize — returns null if no ensemble label or malformed value", () => {
  const noLabel: Issue = normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "Title",
    state: { name: "Todo" },
    labels: ["priority:high"],
  });
  assert.equal(ensembleSize(noLabel), null);

  const malformed: Issue = normalizeIssue({
    id: "i2",
    identifier: "MT-2",
    title: "Title",
    state: { name: "Todo" },
    labels: ["ensemble:abc", "ensemble:", "ensemble:0"],
  });
  assert.equal(ensembleSize(malformed), null);
});

// --- isTerminalState ---

test("isTerminalState — case-insensitively checks if a state is in terminalStates list", () => {
  const terminalStates = ["Done", "Canceled"];
  assert.equal(isTerminalState("done", terminalStates), true);
  assert.equal(isTerminalState("CANCELED", terminalStates), true);
  assert.equal(isTerminalState(" Done ", terminalStates), true);
  assert.equal(isTerminalState("In Progress", terminalStates), false);
});

test("isTerminalState — returns false for null or undefined state", () => {
  const terminalStates = ["Done"];
  assert.equal(isTerminalState(null, terminalStates), false);
  assert.equal(isTerminalState(undefined, terminalStates), false);
});
