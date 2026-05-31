import { describe, test } from "vitest";
import { issueHasOpenBlockers, normalizeIssue, parseConfig } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

function makeSettings(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    tracker: { active_states: ["Todo", "In Progress"], terminal_states: ["Done", "Canceled"] },
    ...overrides,
  });
}

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
