import { Liquid } from "liquidjs";
import { test } from "vitest";
import { buildPrompt, continuationPrompt } from "@symphony/cli";
import type { Issue, ParsedPromptTemplate } from "@symphony/domain";

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

test("buildPrompt frames template parse failures with template context", async () => {
  const template = "{% if issue.identifier %}";
  const issue = makeIssue({ identifier: "ENG-BROKEN" });

  await assert.rejects(
    () => buildPrompt(template, issue),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /template_parse_error:/);
      assert.match(error.message, /template="\{% if issue\.identifier %\}"/);
      return true;
    },
  );
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

test("buildPrompt surfaces invalid template content with prompt context", async () => {
  const template = "{% if issue.identifier %}";
  const issue = makeIssue({
    identifier: "MONO-365",
    title: "Broken prompt",
  });

  await assert.rejects(() => buildPrompt(template, issue), /template_parse_error:.*template="/s);
});

test("buildPrompt caches repeated template string parsing", async () => {
  const template = "Ticket {{ issue.identifier }} cached={{ attempt }}";
  const issue = makeIssue({ identifier: "MONO-365" });
  const originalParse = Liquid.prototype.parse;
  let parseCalls = 0;
  Liquid.prototype.parse = function (...args) {
    parseCalls += 1;
    return originalParse.apply(this, args);
  };

  try {
    assert.equal(await buildPrompt(template, issue, { attempt: 1 }), "Ticket MONO-365 cached=1");
    assert.equal(await buildPrompt(template, issue, { attempt: 2 }), "Ticket MONO-365 cached=2");
  } finally {
    Liquid.prototype.parse = originalParse;
  }

  assert.equal(parseCalls, 1);
});

test("buildPrompt renders parsed templates without reparsing", async () => {
  const template = "Ticket {{ issue.identifier }} attempt={{ attempt }}";
  const parsedTemplate = new Liquid({
    strictVariables: true,
    strictFilters: true,
  }).parse(template);
  const issue = makeIssue({ identifier: "MONO-365" });
  const originalParse = Liquid.prototype.parse;
  let parseCalls = 0;
  Liquid.prototype.parse = function (...args) {
    parseCalls += 1;
    return originalParse.apply(this, args);
  };

  try {
    assert.equal(
      await buildPrompt(parsedTemplate as ParsedPromptTemplate, issue, { attempt: 1 }),
      "Ticket MONO-365 attempt=1",
    );
    assert.equal(
      await buildPrompt(parsedTemplate as ParsedPromptTemplate, issue, { attempt: 2 }),
      "Ticket MONO-365 attempt=2",
    );
  } finally {
    Liquid.prototype.parse = originalParse;
  }

  assert.equal(parseCalls, 0);
});

// --- continuationPrompt ---

test("continuationPrompt includes prior context and continuation reason", () => {
  const result = continuationPrompt(2, 5);

  assert.match(result, /continuation turn #2 of 5/);
  assert.match(result, /previous agent turn completed normally/);
  assert.match(result, /still in an active state/);
});

test("continuationPrompt includes resume-from-workspace guidance in output", () => {
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
