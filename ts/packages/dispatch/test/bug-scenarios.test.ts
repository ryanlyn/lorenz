import { describe, test } from "vitest";
import { issueHasOpenBlockers, normalizeIssue, parseConfig } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

function makeSettings(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    tracker: { active_states: ["Todo", "In Progress"], terminal_states: ["Done", "Canceled"] },
    ...overrides,
  });
}

describe("blockers abort running workers regardless of stateType", () => {
  test("stateType='started' with open blockers IS blocked", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "Todo", type: "started" },
      blockers: [{ state: "In Progress" }],
    });
    assert.equal(issueHasOpenBlockers(issue, settings), true);
  });

  test("stateType='started' with state='todo' (lowercase) with open blockers IS blocked", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "todo", type: "started" },
      blockers: [{ state: "In Progress" }],
    });
    assert.equal(issueHasOpenBlockers(issue, settings), true);
  });

  test("stateType='started' with state=' Todo ' (whitespace) with open blockers IS blocked", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: " Todo ", type: "started" },
      blockers: [{ state: "In Progress" }],
    });
    assert.equal(issueHasOpenBlockers(issue, settings), true);
  });

  test("stateType='started' with all-terminal blockers is NOT blocked", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "In Progress", type: "started" },
      blockers: [{ state: "Done" }, { state: "Canceled" }],
    });
    assert.equal(issueHasOpenBlockers(issue, settings), false);
  });
});
