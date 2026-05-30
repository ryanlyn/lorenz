import { describe, test } from "vitest";
import { issueHasOpenBlockers, normalizeIssue, parseConfig, sortForDispatch } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

function makeIssue(overrides: Record<string, unknown> = {}) {
  return normalizeIssue({
    id: "i1",
    identifier: "MT-1",
    title: "Title",
    state: "Todo",
    ...overrides,
  });
}

function makeSettings(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    tracker: { active_states: ["Todo", "In Progress"], terminal_states: ["Done", "Canceled"] },
    ...overrides,
  });
}

describe("Bug 1: Float priority treated as valid (S-022)", () => {
  test("normalizeIssue rejects float priority 2.5 (becomes null)", () => {
    const issue = makeIssue({ identifier: "A", priority: 2.5 });
    assert.equal(issue.priority, null);
  });

  test("float priority 2.5 sorts last (after priority 4)", () => {
    const a = makeIssue({ identifier: "A", priority: 2.5 });
    const b = makeIssue({ identifier: "B", priority: 4 });
    const sorted = sortForDispatch([a, b]);
    assert.equal(sorted[0]!.identifier, "B");
    assert.equal(sorted[1]!.identifier, "A");
  });

  test("float priority 1.5 sorts last (after priority 2)", () => {
    const a = makeIssue({ identifier: "A", priority: 1.5 });
    const b = makeIssue({ identifier: "B", priority: 2 });
    const sorted = sortForDispatch([a, b]);
    assert.equal(sorted[0]!.identifier, "B");
    assert.equal(sorted[1]!.identifier, "A");
  });

  test("float priority 3.5 sorts last (after priority 4)", () => {
    const a = makeIssue({ identifier: "A", priority: 3.5 });
    const b = makeIssue({ identifier: "B", priority: 4 });
    const sorted = sortForDispatch([a, b]);
    assert.equal(sorted[0]!.identifier, "B");
    assert.equal(sorted[1]!.identifier, "A");
  });
});

describe("Bug 7: issueHasOpenBlockers state='Todo' overrides stateType='started' (S-184)", () => {
  test("stateType='started' with state='Todo' should NOT be blocked", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "Todo", type: "started" },
      blockers: [{ state: "In Progress" }],
    });
    assert.equal(issueHasOpenBlockers(issue, settings), false);
  });

  test("stateType='started' with state='todo' (lowercase) should NOT be blocked", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "todo", type: "started" },
      blockers: [{ state: "In Progress" }],
    });
    assert.equal(issueHasOpenBlockers(issue, settings), false);
  });

  test("stateType='started' with state=' Todo ' (whitespace) should NOT be blocked", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: " Todo ", type: "started" },
      blockers: [{ state: "In Progress" }],
    });
    assert.equal(issueHasOpenBlockers(issue, settings), false);
  });
});
