import { describe, test } from "vitest";
import { issueHasOpenBlockers, normalizeIssue, parseConfig } from "@lorenz/cli";
import { assert } from "@lorenz/test-utils";

function makeSettings(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    tracker: { active_states: ["Todo", "In Progress"], terminal_states: ["Done", "Canceled"] },
    ...overrides,
  });
}

describe("blockers gate only unstarted issues", () => {
  test("stateType='started' with open blockers is not blocked", () => {
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

  test("stateType='started' with state='todo' and open blockers is not blocked", () => {
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

  test("stateType='started' with state=' Todo ' and open blockers is not blocked", () => {
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

  test("stateType='unstarted' with open blockers is blocked", () => {
    const settings = makeSettings();
    const issue = normalizeIssue({
      id: "i1",
      identifier: "MT-1",
      title: "Title",
      state: { name: "Todo", type: "unstarted" },
      blockers: [{ state: "In Progress" }],
    });
    assert.equal(issueHasOpenBlockers(issue, settings), true);
  });

  test("stateType='started' with all-terminal blockers is not blocked", () => {
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
