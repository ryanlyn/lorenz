import { test } from "vitest";
import { buildPrompt, continuationPrompt } from "@symphony/cli";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-42",
    title: "Fix the login bug",
    description: "Users cannot log in when using SSO.",
    state: "In Progress",
    stateType: "started",
    branchName: "fix/login-bug",
    url: "https://linear.app/team/issue/ENG-42",
    priority: 1,
    labels: [],
    blockers: [],
    assignedToWorker: true,
    ...overrides,
  };
}

// --- buildPrompt ---

test("buildPrompt renders issue title and description into template", async () => {
  const template = `Title: {{ issue.title }}\nDescription: {{ issue.description }}`;
  const issue = makeIssue({
    title: "Improve caching",
    description: "Add Redis support for session cache.",
  });

  const result = await buildPrompt(template, issue);

  assert.match(result, /Improve caching/);
  assert.match(result, /Add Redis support for session cache/);
});

test("buildPrompt includes issue URL when present", async () => {
  const template = `URL: {{ issue.url }}`;
  const issue = makeIssue({ url: "https://linear.app/team/issue/ENG-99" });

  const result = await buildPrompt(template, issue);

  assert.match(result, "https://linear.app/team/issue/ENG-99");
});

test("buildPrompt handles missing optional fields (no description, no URL)", async () => {
  const template = `Title: {{ issue.title }}\n{% if issue.description %}Desc: {{ issue.description }}{% endif %}\n{% if issue.url %}URL: {{ issue.url }}{% endif %}`;
  const issue = makeIssue({ description: null, url: null });

  const result = await buildPrompt(template, issue);

  assert.match(result, /Title: Fix the login bug/);
  assert.notMatch(result, /Desc:/);
  assert.notMatch(result, /URL:/);
});

// --- continuationPrompt ---

test("continuationPrompt includes prior context and continuation reason", () => {
  const result = continuationPrompt(2, 5);

  assert.match(result, /continuation turn #2 of 5/);
  assert.match(result, /previous agent turn completed normally/);
  assert.match(result, /still in an active state/);
});

test("continuationPrompt references resume state when available", () => {
  const result = continuationPrompt(1, 3);

  assert.match(result, /Resume from the current workspace and workpad state/);
  assert.match(result, /instead of restarting from scratch/);
});

// --- Template variable substitution ---

test("template variable substitution replaces all placeholders", async () => {
  const template = `ID: {{ issue.id }}\nIdentifier: {{ issue.identifier }}\nTitle: {{ issue.title }}\nState: {{ issue.state }}`;
  const issue = makeIssue({
    id: "abc-123",
    identifier: "PROJ-7",
    title: "Deploy pipeline",
    state: "Todo",
  });

  const result = await buildPrompt(template, issue);

  assert.match(result, /ID: abc-123/);
  assert.match(result, /Identifier: PROJ-7/);
  assert.match(result, /Title: Deploy pipeline/);
  assert.match(result, /State: Todo/);
});
