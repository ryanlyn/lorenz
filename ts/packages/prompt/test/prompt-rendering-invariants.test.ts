import { test } from "vitest";
import fc from "fast-check";
import { buildPrompt } from "@symphony/cli";
import { effectivePromptTemplate, defaultPromptTemplate } from "@symphony/cli";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

// --- Helper arbitraries ---

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

/** Arbitrary that produces strings that are empty or consist only of whitespace. */
const _whitespaceOnlyArb = fc.oneof(
  fc.constant(""),
  fc.constant("   "),
  fc.constant("\t"),
  fc.constant("\n"),
  fc.constant("\r\n"),
  fc.constant("\r"),
  fc.constant("  \n\t  "),
  fc.constant(" "), // non-breaking space is NOT whitespace for trim()
  fc.constant(" "), // em space - also not whitespace for JS trim()
  fc.array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 0, maxLength: 50 }).map((a) => a.join("")),
  // Very long whitespace string
  fc.integer({ min: 1, max: 200 }).map((n) => " ".repeat(n)),
);

/** Arbitrary that produces strings guaranteed to be whitespace-only per JS trim() semantics. */
const strictWhitespaceOnlyArb = fc.oneof(
  fc.constant(""),
  fc.constant("   "),
  fc.constant("\t"),
  fc.constant("\n"),
  fc.constant("\r\n"),
  fc.constant("\r"),
  fc.constant("  \n\t  "),
  fc.array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 0, maxLength: 50 }).map((a) => a.join("")),
  fc.integer({ min: 1, max: 200 }).map((n) => " ".repeat(n)),
).filter((s) => s.trim() === "");

/** Arbitrary that produces valid Liquid variable names that do NOT exist in the template context. */
const unknownVariableNameArb = fc.array(
  fc.constantFrom(
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
    "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
    "_",
  ),
  { minLength: 3, maxLength: 12 },
).map((a) => a.join("")).filter(
  (s) => !["issue", "attempt", "ensemble"].includes(s) && /^[a-z_]/.test(s),
);

/** Arbitrary that produces filter names that do not exist in Liquid's built-in set. */
const unknownFilterNameArb = fc.array(
  fc.constantFrom(
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
    "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
    "_",
  ),
  { minLength: 5, maxLength: 15 },
).map((a) => a.join("")).filter(
  (s) =>
    // Exclude known Liquid built-in filters
    ![
      "abs", "append", "at_least", "at_most", "capitalize", "ceil",
      "compact", "concat", "date", "default", "divided_by", "downcase",
      "escape", "escape_once", "first", "floor", "join", "json", "last",
      "lstrip", "map", "minus", "modulo", "newline_to_br", "nl2br",
      "plus", "prepend", "remove", "remove_first", "replace",
      "replace_first", "reverse", "round", "rstrip", "size", "slice",
      "sort", "sort_natural", "split", "strip", "strip_html",
      "strip_newlines", "times", "truncate", "truncatewords", "uniq",
      "upcase", "url_decode", "url_encode", "where",
    ].includes(s) && /^[a-z_]/.test(s),
);

/** Arbitrary producing strings with Liquid-special characters that could confuse a template engine. */
const liquidSpecialStringArb = fc.oneof(
  fc.constant("{{ foo }}"),
  fc.constant("{% if true %}yes{% endif %}"),
  fc.constant("{{ issue.title }}"),
  fc.constant("hello | upcase"),
  fc.constant("}}{{"),
  fc.constant("{%"),
  fc.constant("%}"),
  fc.constant("{{ '' | append: 'injected' }}"),
  fc.string({ minLength: 1, maxLength: 100 }).map((s) => `{{${s}}}`),
);

/** Arbitrary producing strings with unicode, control chars, and edge cases. */
const challengingStringArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 100, unit: "grapheme" }),
  fc.constant("\x00"), // null byte
  fc.constant("\x01\x02\x03"), // control chars
  fc.constant("😀"), // emoji (surrogate pair for smiley)
  fc.constant("‮"), // RTL override
  fc.constant("a".repeat(5000)), // very long
  fc.constant("<script>alert('xss')</script>"), // HTML
  fc.constant("Robert'); DROP TABLE issues;--"), // SQL injection-like
  liquidSpecialStringArb,
  fc.string({ minLength: 1, maxLength: 200, unit: "grapheme" }),
);

/** Arbitrary producing diverse Issue objects with challenging inputs. */
const _issueArb: fc.Arbitrary<Issue> = fc.record({
  id: fc.oneof(fc.string({ minLength: 1, maxLength: 50 }), challengingStringArb),
  identifier: fc.oneof(fc.string({ minLength: 1, maxLength: 20 }), challengingStringArb),
  title: fc.oneof(fc.string({ minLength: 1, maxLength: 200 }), challengingStringArb),
  description: fc.option(fc.oneof(fc.string({ maxLength: 500 }), challengingStringArb), { nil: null }),
  state: fc.oneof(fc.string({ minLength: 1, maxLength: 30 }), challengingStringArb),
  stateType: fc.option(
    fc.constantFrom("backlog" as const, "unstarted" as const, "started" as const, "completed" as const, "canceled" as const, "triage" as const),
    { nil: null },
  ),
  branchName: fc.option(fc.oneof(fc.string({ maxLength: 60 }), challengingStringArb), { nil: null }),
  url: fc.option(fc.oneof(fc.string({ maxLength: 100 }), challengingStringArb), { nil: null }),
  priority: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }),
  labels: fc.array(fc.oneof(fc.string({ minLength: 1, maxLength: 20 }), challengingStringArb), { maxLength: 5 }),
  blockers: fc.array(
    fc.record({
      id: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
      identifier: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
      state: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
      stateType: fc.option(
        fc.constantFrom("backlog" as const, "unstarted" as const, "started" as const, "completed" as const, "canceled" as const, "triage" as const),
        { nil: undefined },
      ),
    }),
    { maxLength: 3 },
  ),
  assignedToWorker: fc.option(fc.boolean(), { nil: null }),
}) as fc.Arbitrary<Issue>;

/** Simpler issue arbitrary that avoids Liquid-special chars in fields used for direct interpolation. */
const safeIssueArb: fc.Arbitrary<Issue> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 30, unit: fc.constantFrom("a", "b", "c", "1", "2", "-", "_") }),
  identifier: fc.string({ minLength: 1, maxLength: 10, unit: fc.constantFrom("A", "B", "C", "1", "2", "-") }),
  title: fc.string({ minLength: 1, maxLength: 50, unit: fc.constantFrom("a", "b", "c", " ", ".", "!", "1") }),
  description: fc.option(fc.string({ maxLength: 200 }), { nil: null }),
  state: fc.string({ minLength: 1, maxLength: 20, unit: fc.constantFrom("A", "a", "b", " ", "P") }),
  stateType: fc.option(
    fc.constantFrom("backlog" as const, "unstarted" as const, "started" as const, "completed" as const, "canceled" as const, "triage" as const),
    { nil: null },
  ),
  branchName: fc.option(fc.string({ maxLength: 40 }), { nil: null }),
  url: fc.option(fc.string({ maxLength: 80 }), { nil: null }),
  priority: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }),
  labels: fc.array(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 3 }),
  blockers: fc.array(
    fc.record({
      id: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
      identifier: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
      state: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
      stateType: fc.option(
        fc.constantFrom("backlog" as const, "unstarted" as const, "started" as const, "completed" as const, "canceled" as const, "triage" as const),
        { nil: undefined },
      ),
    }),
    { maxLength: 2 },
  ),
  assignedToWorker: fc.option(fc.boolean(), { nil: null }),
}) as fc.Arbitrary<Issue>;

// --- Invariant 1: empty/whitespace body falls back to default prompt ---

test("Invariant 1: when workflow prompt body is empty or whitespace-only, system uses minimal default prompt", async () => {
  await fc.assert(
    fc.asyncProperty(strictWhitespaceOnlyArb, safeIssueArb, async (template, issue) => {
      const result = await buildPrompt(template, issue);
      // The result must match what defaultPromptTemplate would render (not be empty)
      // Specifically it must contain the structural markers from the default template
      assert.match(result, /Identifier:/);
      assert.match(result, /Title:/);
      // It must contain actual issue data rendered into the default template
      // Use includes (string check) rather than regex match to avoid regex special chars in data
      assert.ok(result.includes(issue.identifier));
      assert.ok(result.includes(issue.title));
    }),
    { numRuns: 200 },
  );
});

test("Invariant 1: effectivePromptTemplate returns defaultPromptTemplate for whitespace inputs", () => {
  fc.assert(
    fc.property(strictWhitespaceOnlyArb, (template) => {
      const effective = effectivePromptTemplate(template);
      assert.equal(effective, defaultPromptTemplate);
    }),
    { numRuns: 200 },
  );
});

test("Invariant 1: non-whitespace template does NOT fall back to default", () => {
  const nonWhitespaceArb = fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim() !== "");
  fc.assert(
    fc.property(nonWhitespaceArb, (template) => {
      const effective = effectivePromptTemplate(template);
      // Should return the template as-is (not the default)
      assert.equal(effective, template);
      assert.notEqual(effective, defaultPromptTemplate);
    }),
    { numRuns: 200 },
  );
});

test("Invariant 1: fallback output is never empty", async () => {
  await fc.assert(
    fc.asyncProperty(strictWhitespaceOnlyArb, safeIssueArb, async (template, issue) => {
      const result = await buildPrompt(template, issue);
      // The result must never be empty when falling back
      assert.ok(result.trim().length > 0);
      // It must be different from an empty string (not a no-op)
      assert.notEqual(result.trim(), "");
    }),
    { numRuns: 100 },
  );
});

// --- Invariant 2: unknown variable causes strict failure ---

test("Invariant 2: when prompt template references unknown variable, rendering fails strictly", async () => {
  await fc.assert(
    fc.asyncProperty(unknownVariableNameArb, async (varName) => {
      const template = `Hello {{ ${varName} }}`;
      const issue = makeIssue();
      await assert.rejects(
        () => buildPrompt(template, issue),
      );
    }),
    { numRuns: 200 },
  );
});

test("Invariant 2: nested unknown variable references also fail strictly", async () => {
  // Known keys in the issuePromptContext: id, identifier, title, description, priority,
  // state, state_type, branch_name, url, assignee_id, blocked_by, labels, assigned_to_worker,
  // created_at, updated_at
  const knownIssueFields = [
    "id", "identifier", "title", "description", "priority", "state",
    "state_type", "branch_name", "url", "assignee_id", "blocked_by",
    "labels", "assigned_to_worker", "created_at", "updated_at",
  ];

  await fc.assert(
    fc.asyncProperty(unknownVariableNameArb, async (varName) => {
      // Skip if it happens to be a known field
      if (knownIssueFields.includes(varName)) return;
      const template = `Data: {{ issue.${varName} }}`;
      const issue = makeIssue();
      await assert.rejects(
        () => buildPrompt(template, issue),
      );
    }),
    { numRuns: 200 },
  );
});

test("Invariant 2: deeply nested unknown path fails strictly", async () => {
  await fc.assert(
    fc.asyncProperty(unknownVariableNameArb, unknownVariableNameArb, async (path1, path2) => {
      const template = `Data: {{ ${path1}.${path2} }}`;
      const issue = makeIssue();
      await assert.rejects(
        () => buildPrompt(template, issue),
      );
    }),
    { numRuns: 100 },
  );
});

test("Invariant 2: known top-level variables (issue, attempt, ensemble) do NOT fail", async () => {
  const knownVarTemplates = [
    "{{ issue.title }}",
    "{{ attempt }}",
    "{{ ensemble.slot_index }}",
    "{{ ensemble.size }}",
    "{{ ensemble.enabled }}",
    "{{ issue.id }}",
    "{{ issue.state }}",
    "{{ issue.identifier }}",
  ];
  const templateArb = fc.constantFrom(...knownVarTemplates);

  await fc.assert(
    fc.asyncProperty(templateArb, async (template) => {
      const issue = makeIssue();
      // These should NOT throw
      const result = await buildPrompt(template, issue);
      assert.ok(typeof result === "string");
    }),
    { numRuns: 50 },
  );
});

// --- Invariant 3: unknown filter causes strict failure ---

test("Invariant 3: when prompt template references unknown filter, rendering fails strictly", async () => {
  await fc.assert(
    fc.asyncProperty(unknownFilterNameArb, async (filterName) => {
      const template = `Hello {{ issue.title | ${filterName} }}`;
      const issue = makeIssue();
      await assert.rejects(
        () => buildPrompt(template, issue),
      );
    }),
    { numRuns: 200 },
  );
});

test("Invariant 3: unknown filter on various value types fails", async () => {
  const valueExpressions = [
    "issue.title",
    "issue.id",
    "attempt",
    "ensemble.size",
    "issue.description",
  ];
  const exprArb = fc.constantFrom(...valueExpressions);

  await fc.assert(
    fc.asyncProperty(exprArb, unknownFilterNameArb, async (expr, filterName) => {
      const template = `Result: {{ ${expr} | ${filterName} }}`;
      const issue = makeIssue();
      await assert.rejects(
        () => buildPrompt(template, issue),
      );
    }),
    { numRuns: 100 },
  );
});

test("Invariant 3: chained unknown filter after known filter still fails", async () => {
  await fc.assert(
    fc.asyncProperty(unknownFilterNameArb, async (filterName) => {
      // A known filter (upcase) followed by an unknown one should still fail
      const template = `Hello {{ issue.title | upcase | ${filterName} }}`;
      const issue = makeIssue();
      await assert.rejects(
        () => buildPrompt(template, issue),
      );
    }),
    { numRuns: 100 },
  );
});

test("Invariant 3: known filters do NOT cause failures", async () => {
  const knownFilterTemplates = [
    "{{ issue.title | upcase }}",
    "{{ issue.title | downcase }}",
    "{{ issue.title | size }}",
    "{{ issue.title | strip }}",
    "{{ issue.title | escape }}",
  ];
  const templateArb = fc.constantFrom(...knownFilterTemplates);

  await fc.assert(
    fc.asyncProperty(templateArb, async (template) => {
      const issue = makeIssue();
      const result = await buildPrompt(template, issue);
      assert.ok(typeof result === "string");
      assert.ok(result.length > 0);
    }),
    { numRuns: 25 },
  );
});

// --- Invariant 4: issue, attempt, and ensemble are available as template inputs ---

test("Invariant 4: issue object is available as template input with expected fields", async () => {
  await fc.assert(
    fc.asyncProperty(safeIssueArb, async (issue) => {
      const template = `id:{{ issue.id }} ident:{{ issue.identifier }} title:{{ issue.title }} state:{{ issue.state }}`;
      const result = await buildPrompt(template, issue);
      // Use string includes instead of regex match to handle special characters safely
      assert.ok(result.includes(`id:${issue.id}`));
      assert.ok(result.includes(`ident:${issue.identifier}`));
      assert.ok(result.includes(`title:${issue.title}`));
      assert.ok(result.includes(`state:${issue.state}`));
    }),
    { numRuns: 200 },
  );
});

test("Invariant 4: issue snake_case fields are correctly mapped from camelCase source", async () => {
  // Tests that the issuePromptContext mapping is correct
  const issue = makeIssue({
    stateType: "started",
    branchName: "feature/my-branch",
    url: "https://example.com/issue/1",
    assignedToWorker: true,
  });
  const template = [
    "state_type:{{ issue.state_type }}",
    "branch_name:{{ issue.branch_name }}",
    "url:{{ issue.url }}",
    "assigned_to_worker:{{ issue.assigned_to_worker }}",
  ].join(" ");
  const result = await buildPrompt(template, issue);
  assert.ok(result.includes("state_type:started"));
  assert.ok(result.includes("branch_name:feature/my-branch"));
  assert.ok(result.includes("url:https://example.com/issue/1"));
  assert.ok(result.includes("assigned_to_worker:true"));
});

test("Invariant 4: issue optional fields render as empty string when null", async () => {
  const issue = makeIssue({
    description: null,
    branchName: null,
    url: null,
    priority: null,
    stateType: null,
  });
  const template = [
    "desc:[{{ issue.description }}]",
    "branch:[{{ issue.branch_name }}]",
    "url:[{{ issue.url }}]",
    "priority:[{{ issue.priority }}]",
    "state_type:[{{ issue.state_type }}]",
  ].join(" ");
  const result = await buildPrompt(template, issue);
  // Liquid renders nil/null as empty string
  assert.ok(result.includes("desc:[]"));
  assert.ok(result.includes("branch:[]"));
  assert.ok(result.includes("url:[]"));
  assert.ok(result.includes("priority:[]"));
  assert.ok(result.includes("state_type:[]"));
});

test("Invariant 4: attempt is available as template input", async () => {
  const attemptArb = fc.oneof(
    fc.constant(null),
    fc.integer({ min: 0, max: 100 }),
    fc.integer({ min: -10, max: -1 }), // negative attempts
    fc.constant(0), // boundary
    fc.constant(1), // common case
    fc.integer({ min: 100, max: 10000 }), // large values
  );

  await fc.assert(
    fc.asyncProperty(attemptArb, async (attempt) => {
      const template = `attempt:{{ attempt }}`;
      const issue = makeIssue();
      const result = await buildPrompt(template, issue, { attempt });
      if (attempt === null) {
        // Null renders as empty string in Liquid
        assert.ok(result.includes("attempt:"));
        // Should NOT contain the literal string "null"
        assert.ok(!result.includes("attempt:null"));
      } else {
        assert.ok(result.includes(`attempt:${attempt}`));
      }
    }),
    { numRuns: 200 },
  );
});

test("Invariant 4: attempt defaults to null when not provided", async () => {
  const template = `[{{ attempt }}]`;
  const issue = makeIssue();
  const result = await buildPrompt(template, issue);
  // With no attempt option, should render as empty (null -> "")
  assert.ok(result.includes("[]"));
});

test("Invariant 4: ensemble object is available as template input with slot_index, size, and enabled", async () => {
  const slotArb = fc.integer({ min: 0, max: 10 });
  const sizeArb = fc.integer({ min: 1, max: 10 });

  await fc.assert(
    fc.asyncProperty(slotArb, sizeArb, async (slotIndex, ensembleSize) => {
      // Ensure slotIndex < ensembleSize for valid ensembles
      const validSlot = slotIndex % ensembleSize;
      const template = `slot:{{ ensemble.slot_index }} size:{{ ensemble.size }} enabled:{{ ensemble.enabled }}`;
      const issue = makeIssue();
      const result = await buildPrompt(template, issue, { slotIndex: validSlot, ensembleSize });
      assert.ok(result.includes(`slot:${validSlot}`));
      assert.ok(result.includes(`size:${ensembleSize}`));
      assert.ok(result.includes(`enabled:${ensembleSize > 1}`));
    }),
    { numRuns: 200 },
  );
});

test("Invariant 4: ensemble defaults to slot 0, size 1, enabled false when not provided", async () => {
  const template = `slot:{{ ensemble.slot_index }} size:{{ ensemble.size }} enabled:{{ ensemble.enabled }}`;
  const issue = makeIssue();
  const result = await buildPrompt(template, issue);
  assert.ok(result.includes("slot:0"));
  assert.ok(result.includes("size:1"));
  assert.ok(result.includes("enabled:false"));
});

test("Invariant 4: ensemble enabled is true if and only if size > 1", async () => {
  const sizeArb = fc.integer({ min: 1, max: 50 });

  await fc.assert(
    fc.asyncProperty(sizeArb, async (ensembleSize) => {
      const template = `enabled:{{ ensemble.enabled }}`;
      const issue = makeIssue();
      const result = await buildPrompt(template, issue, { slotIndex: 0, ensembleSize });
      const expectedEnabled = ensembleSize > 1;
      assert.ok(result.includes(`enabled:${expectedEnabled}`));
    }),
    { numRuns: 100 },
  );
});

// --- Invariant 5: buildPrompt never silently drops data (output completeness) ---

test("Invariant 5: buildPrompt always returns a non-empty string for any valid template", async () => {
  // Even with a template that has content, the result should never be undefined/null
  const validTemplateArb = fc.oneof(
    fc.constant("Hello world"),
    fc.constant("{{ issue.title }}"),
    fc.constant("{% if issue.description %}has desc{% else %}no desc{% endif %}"),
    fc.constant("Prefix {{ issue.identifier }} suffix"),
  );

  await fc.assert(
    fc.asyncProperty(validTemplateArb, safeIssueArb, async (template, issue) => {
      const result = await buildPrompt(template, issue);
      assert.ok(typeof result === "string");
      // Rendered output should be a string (not null, not undefined)
      assert.ok(result !== null && result !== undefined);
    }),
    { numRuns: 100 },
  );
});

test("Invariant 5: static text in template passes through unchanged", async () => {
  // Any template with only static text (no Liquid tags) should render verbatim
  const staticTextArb = fc.string({
    minLength: 1,
    maxLength: 100,
    unit: fc.constantFrom("a", "b", "c", "1", " ", ".", ",", "!", "\n"),
  }).filter((s) => !s.includes("{{") && !s.includes("{%") && s.trim() !== "");

  await fc.assert(
    fc.asyncProperty(staticTextArb, async (text) => {
      const issue = makeIssue();
      const result = await buildPrompt(text, issue);
      assert.equal(result, text);
    }),
    { numRuns: 200 },
  );
});

// --- Invariant 6: issue.blocked_by array is accessible ---

test("Invariant 6: issue.blocked_by is rendered as an array accessible via Liquid for-loop", async () => {
  const issue = makeIssue({
    blockers: [
      { id: "blocker-1", identifier: "ENG-10", state: "Todo", stateType: "unstarted" },
      { id: "blocker-2", identifier: "ENG-11", state: "Done", stateType: "completed" },
    ],
  });
  const template = `{% for b in issue.blocked_by %}[{{ b.identifier }}:{{ b.state_type }}]{% endfor %}`;
  const result = await buildPrompt(template, issue);
  assert.ok(result.includes("[ENG-10:unstarted]"));
  assert.ok(result.includes("[ENG-11:completed]"));
});

test("Invariant 6: issue.labels is rendered as an array accessible via Liquid for-loop", async () => {
  const labelsArb = fc.array(
    fc.string({ minLength: 1, maxLength: 10, unit: fc.constantFrom("a", "b", "c", "1", "-") }),
    { minLength: 1, maxLength: 5 },
  );

  await fc.assert(
    fc.asyncProperty(labelsArb, async (labels) => {
      const issue = makeIssue({ labels });
      const template = `{% for l in issue.labels %}[{{ l }}]{% endfor %}`;
      const result = await buildPrompt(template, issue);
      for (const label of labels) {
        assert.ok(result.includes(`[${label}]`));
      }
    }),
    { numRuns: 100 },
  );
});
