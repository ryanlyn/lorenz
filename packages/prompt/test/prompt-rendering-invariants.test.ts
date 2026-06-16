import { test, describe } from "vitest";
import fc from "fast-check";
import { buildPrompt } from "@lorenz/cli";
import { effectivePromptTemplate, defaultPromptTemplate } from "@lorenz/cli";
import type { Issue } from "@lorenz/domain";
import { assert, issueWith } from "@lorenz/test-utils";

// --- Helper arbitraries ---

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return issueWith({
    identifier: "ENG-42",
    title: "Fix the login bug",
    description: "Users cannot log in when using SSO.",
    state: "In Progress",
    stateType: "started",
    branchName: "fix/login-bug",
    url: "https://linear.app/team/issue/ENG-42",
    ...overrides,
  });
}

/** Arbitrary that produces strings guaranteed to be whitespace-only per JS trim() semantics. */
const strictWhitespaceOnlyArb = fc
  .oneof(
    fc.constant(""),
    fc.constant("   "),
    fc.constant("\t"),
    fc.constant("\n"),
    fc.constant("\r\n"),
    fc.constant("\r"),
    fc.constant("  \n\t  "),
    fc
      .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 0, maxLength: 50 })
      .map((a) => a.join("")),
    fc.integer({ min: 1, max: 200 }).map((n) => " ".repeat(n)),
  )
  .filter((s) => s.trim() === "");

const knownPromptVariableRoots = new Set(["issue", "attempt", "ensemble"]);

const liquidOutputSyntaxWords = new Set([
  "and",
  "blank",
  "contains",
  "empty",
  "false",
  "nil",
  "not",
  "null",
  "or",
  "true",
]);

function isUnknownVariableReferenceName(name: string): boolean {
  return (
    /^[a-z_]+$/.test(name) &&
    !knownPromptVariableRoots.has(name) &&
    !liquidOutputSyntaxWords.has(name)
  );
}

/** Arbitrary that produces valid Liquid variable names that do NOT exist in the template context. */
const unknownVariableNameArb = fc
  .array(
    fc.constantFrom(
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
      "n",
      "o",
      "p",
      "q",
      "r",
      "s",
      "t",
      "u",
      "v",
      "w",
      "x",
      "y",
      "z",
      "_",
    ),
    { minLength: 3, maxLength: 12 },
  )
  .map((a) => a.join(""))
  .filter(isUnknownVariableReferenceName);

/** Arbitrary that produces filter names that do not exist in Liquid's built-in set. */
const unknownFilterNameArb = fc
  .array(
    fc.constantFrom(
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
      "n",
      "o",
      "p",
      "q",
      "r",
      "s",
      "t",
      "u",
      "v",
      "w",
      "x",
      "y",
      "z",
      "_",
    ),
    { minLength: 5, maxLength: 15 },
  )
  .map((a) => a.join(""))
  .filter(
    (s) =>
      // Exclude known Liquid built-in filters
      ![
        "abs",
        "append",
        "at_least",
        "at_most",
        "capitalize",
        "ceil",
        "compact",
        "concat",
        "date",
        "default",
        "divided_by",
        "downcase",
        "escape",
        "escape_once",
        "first",
        "floor",
        "join",
        "json",
        "last",
        "lstrip",
        "map",
        "minus",
        "modulo",
        "newline_to_br",
        "nl2br",
        "plus",
        "prepend",
        "remove",
        "remove_first",
        "replace",
        "replace_first",
        "reverse",
        "round",
        "rstrip",
        "size",
        "slice",
        "sort",
        "sort_natural",
        "split",
        "strip",
        "strip_html",
        "strip_newlines",
        "times",
        "truncate",
        "truncatewords",
        "uniq",
        "upcase",
        "url_decode",
        "url_encode",
        "where",
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

/** Arbitrary producing diverse Issue objects with challenging inputs including Liquid-special characters.
 *  This exercises template injection resistance -- user data containing {{ or {%  must not
 *  affect rendering behavior or cause errors. */
const challengingIssueArb: fc.Arbitrary<Issue> = fc.record({
  id: fc.oneof(fc.string({ minLength: 1, maxLength: 50 }), challengingStringArb),
  identifier: fc.oneof(fc.string({ minLength: 1, maxLength: 20 }), challengingStringArb),
  title: fc.oneof(fc.string({ minLength: 1, maxLength: 200 }), challengingStringArb),
  description: fc.option(fc.oneof(fc.string({ maxLength: 500 }), challengingStringArb), {
    nil: null,
  }),
  state: fc.oneof(fc.string({ minLength: 1, maxLength: 30 }), challengingStringArb),
  stateType: fc.option(
    fc.constantFrom(
      "backlog" as const,
      "unstarted" as const,
      "started" as const,
      "completed" as const,
      "canceled" as const,
      "triage" as const,
    ),
    { nil: null },
  ),
  branchName: fc.option(fc.oneof(fc.string({ maxLength: 60 }), challengingStringArb), {
    nil: null,
  }),
  url: fc.option(fc.oneof(fc.string({ maxLength: 100 }), challengingStringArb), { nil: null }),
  priority: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }),
  labels: fc.array(fc.oneof(fc.string({ minLength: 1, maxLength: 20 }), challengingStringArb), {
    maxLength: 5,
  }),
  blockers: fc.array(
    fc.record({
      id: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
      identifier: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
      state: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
      stateType: fc.option(
        fc.constantFrom(
          "backlog" as const,
          "unstarted" as const,
          "started" as const,
          "completed" as const,
          "canceled" as const,
          "triage" as const,
        ),
        { nil: undefined },
      ),
    }),
    { maxLength: 3 },
  ),
  assignedToWorker: fc.option(fc.boolean(), { nil: null }),
}) as fc.Arbitrary<Issue>;

/** Simpler issue arbitrary that avoids Liquid-special chars in fields used for direct interpolation. */
const safeIssueArb: fc.Arbitrary<Issue> = fc.record({
  id: fc.string({
    minLength: 1,
    maxLength: 30,
    unit: fc.constantFrom("a", "b", "c", "1", "2", "-", "_"),
  }),
  identifier: fc.string({
    minLength: 1,
    maxLength: 10,
    unit: fc.constantFrom("A", "B", "C", "1", "2", "-"),
  }),
  title: fc.string({
    minLength: 1,
    maxLength: 50,
    unit: fc.constantFrom("a", "b", "c", " ", ".", "!", "1"),
  }),
  description: fc.option(fc.string({ maxLength: 200 }), { nil: null }),
  state: fc.string({ minLength: 1, maxLength: 20, unit: fc.constantFrom("A", "a", "b", " ", "P") }),
  stateType: fc.option(
    fc.constantFrom(
      "backlog" as const,
      "unstarted" as const,
      "started" as const,
      "completed" as const,
      "canceled" as const,
      "triage" as const,
    ),
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
        fc.constantFrom(
          "backlog" as const,
          "unstarted" as const,
          "started" as const,
          "completed" as const,
          "canceled" as const,
          "triage" as const,
        ),
        { nil: undefined },
      ),
    }),
    { maxLength: 2 },
  ),
  assignedToWorker: fc.option(fc.boolean(), { nil: null }),
}) as fc.Arbitrary<Issue>;

describe("INVARIANT: When the workflow prompt body is empty or whitespace-only, the system SHALL use a minimal default prompt.", () => {
  test("when workflow prompt body is empty or whitespace-only, system uses minimal default prompt", async () => {
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

  test("effectivePromptTemplate returns defaultPromptTemplate for whitespace inputs", () => {
    fc.assert(
      fc.property(strictWhitespaceOnlyArb, (template) => {
        const effective = effectivePromptTemplate(template);
        assert.equal(effective, defaultPromptTemplate);
      }),
      { numRuns: 200 },
    );
  });

  test("non-whitespace template does NOT fall back to default", () => {
    const nonWhitespaceArb = fc
      .string({ minLength: 1, maxLength: 100 })
      .filter((s) => s.trim() !== "");
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
});

describe("INVARIANT: When a prompt template references an unknown variable, rendering SHALL fail strictly.", () => {
  test("unknown variable arbitrary excludes Liquid output syntax words", () => {
    for (const varName of liquidOutputSyntaxWords) {
      assert.equal(isUnknownVariableReferenceName(varName), false);
    }
  });

  test("representative unknown variable references still fail strictly", async () => {
    assert.equal(isUnknownVariableReferenceName("zz_unknown_variable"), true);

    const template = "Hello {{ zz_unknown_variable }}";
    const issue = makeIssue();

    await assert.rejects(() => buildPrompt(template, issue));
  });

  test("when prompt template references unknown variable, rendering fails strictly", async () => {
    await fc.assert(
      fc.asyncProperty(unknownVariableNameArb, async (varName) => {
        const template = `Hello {{ ${varName} }}`;
        const issue = makeIssue();
        await assert.rejects(() => buildPrompt(template, issue));
      }),
      { numRuns: 200 },
    );
  });

  test("nested unknown variable references also fail strictly", async () => {
    // Known keys in the issuePromptContext: id, identifier, title, description, priority,
    // state, state_type, branch_name, url, assignee_id, blocked_by, labels, assigned_to_worker,
    // created_at, updated_at
    const knownIssueFields = [
      "id",
      "identifier",
      "title",
      "description",
      "priority",
      "state",
      "state_type",
      "branch_name",
      "url",
      "assignee_id",
      "blocked_by",
      "labels",
      "assigned_to_worker",
      "created_at",
      "updated_at",
    ];

    await fc.assert(
      fc.asyncProperty(unknownVariableNameArb, async (varName) => {
        // Skip if it happens to be a known field
        if (knownIssueFields.includes(varName)) return;
        const template = `Data: {{ issue.${varName} }}`;
        const issue = makeIssue();
        await assert.rejects(() => buildPrompt(template, issue));
      }),
      { numRuns: 200 },
    );
  });

  test("deeply nested unknown path fails strictly", async () => {
    await fc.assert(
      fc.asyncProperty(unknownVariableNameArb, unknownVariableNameArb, async (path1, path2) => {
        const template = `Data: {{ ${path1}.${path2} }}`;
        const issue = makeIssue();
        await assert.rejects(() => buildPrompt(template, issue));
      }),
      { numRuns: 100 },
    );
  });
});

describe("INVARIANT: When a prompt template references an unknown filter, rendering SHALL fail strictly.", () => {
  test("when prompt template references unknown filter, rendering fails strictly", async () => {
    await fc.assert(
      fc.asyncProperty(unknownFilterNameArb, async (filterName) => {
        const template = `Hello {{ issue.title | ${filterName} }}`;
        const issue = makeIssue();
        await assert.rejects(() => buildPrompt(template, issue));
      }),
      { numRuns: 200 },
    );
  });

  test("unknown filter on various value types fails", async () => {
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
        await assert.rejects(() => buildPrompt(template, issue));
      }),
      { numRuns: 100 },
    );
  });

  test("chained unknown filter after known filter still fails", async () => {
    await fc.assert(
      fc.asyncProperty(unknownFilterNameArb, async (filterName) => {
        // A known filter (upcase) followed by an unknown one should still fail
        const template = `Hello {{ issue.title | upcase | ${filterName} }}`;
        const issue = makeIssue();
        await assert.rejects(() => buildPrompt(template, issue));
      }),
      { numRuns: 100 },
    );
  });
});

describe("INVARIANT: When a prompt is rendered, the issue, attempt, and ensemble objects SHALL be available as template inputs.", () => {
  test("issue object is available as template input with expected fields", async () => {
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

  test("snake_case template fields map correctly from camelCase source for any issue", async () => {
    // Verify that for any issue with non-null optional fields, the snake_case
    // template variables produce the corresponding camelCase source values.
    const issueWithFieldsArb = fc.record({
      stateType: fc.constantFrom(
        "backlog" as const,
        "unstarted" as const,
        "started" as const,
        "completed" as const,
        "canceled" as const,
        "triage" as const,
      ),
      branchName: fc.string({
        minLength: 1,
        maxLength: 30,
        unit: fc.constantFrom("a", "b", "/", "-", "_", "1"),
      }),
      url: fc.string({
        minLength: 1,
        maxLength: 50,
        unit: fc.constantFrom("h", "t", "p", "s", ":", "/", ".", "a", "1"),
      }),
      assignedToWorker: fc.boolean(),
    });

    await fc.assert(
      fc.asyncProperty(issueWithFieldsArb, async (fields) => {
        const issue = makeIssue(fields);
        const template = [
          "state_type:{{ issue.state_type }}",
          "branch_name:{{ issue.branch_name }}",
          "url:{{ issue.url }}",
          "assigned_to_worker:{{ issue.assigned_to_worker }}",
        ].join(" ");
        const result = await buildPrompt(template, issue);
        assert.ok(result.includes(`state_type:${fields.stateType}`));
        assert.ok(result.includes(`branch_name:${fields.branchName}`));
        assert.ok(result.includes(`url:${fields.url}`));
        assert.ok(result.includes(`assigned_to_worker:${fields.assignedToWorker}`));
      }),
      { numRuns: 100 },
    );
  });

  test("attempt is available as template input", async () => {
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

  test("ensemble object is available as template input with slot_index, size, and enabled", async () => {
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

  test("ensemble.enabled is true only when rendered size in output is > 1", async () => {
    // Verify the invariant from the output side: parse the rendered output to confirm
    // that enabled:true always correlates with size > 1 in the rendered result.
    const sizeArb = fc.integer({ min: 1, max: 50 });

    await fc.assert(
      fc.asyncProperty(sizeArb, async (ensembleSize) => {
        const template = `enabled:{{ ensemble.enabled }} size:{{ ensemble.size }}`;
        const issue = makeIssue();
        const result = await buildPrompt(template, issue, { slotIndex: 0, ensembleSize });
        // Parse the rendered output independently
        const enabledMatch = result.match(/enabled:(true|false)/);
        const sizeMatch = result.match(/size:(\d+)/);
        assert.ok(enabledMatch !== null);
        assert.ok(sizeMatch !== null);
        const renderedEnabled = enabledMatch![1] === "true";
        const renderedSize = parseInt(sizeMatch![1]!, 10);
        // The invariant: enabled is true if and only if size > 1
        assert.equal(renderedEnabled, renderedSize > 1);
      }),
      { numRuns: 100 },
    );
  });
});

describe("INVARIANT: When a template is rendered, interpolation SHALL faithfully reproduce source values.", () => {
  test("static text in template passes through unchanged", async () => {
    // Any template with only static text (no Liquid tags) should render verbatim
    const staticTextArb = fc
      .string({
        minLength: 1,
        maxLength: 100,
        unit: fc.constantFrom("a", "b", "c", "1", " ", ".", ",", "!", "\n"),
      })
      .filter((s) => !s.includes("{{") && !s.includes("{%") && s.trim() !== "");

    await fc.assert(
      fc.asyncProperty(staticTextArb, async (text) => {
        const issue = makeIssue();
        const result = await buildPrompt(text, issue);
        assert.equal(result, text);
      }),
      { numRuns: 200 },
    );
  });

  test("template containing Liquid expression produces output different from raw template", async () => {
    // For any template referencing issue fields with Liquid expressions,
    // the output must differ from the raw template string (proving interpolation occurred).
    await fc.assert(
      fc.asyncProperty(safeIssueArb, async (issue) => {
        const template = `Issue: {{ issue.identifier }} - {{ issue.title }}`;
        const result = await buildPrompt(template, issue);
        // The output must not be the raw template -- interpolation must have occurred
        assert.notEqual(result, template);
        // And the interpolated values must be present
        assert.ok(result.includes(issue.identifier));
        assert.ok(result.includes(issue.title));
      }),
      { numRuns: 100 },
    );
  });
});

describe("INVARIANT: When user-controlled data contains template syntax, it SHALL be rendered literally, not interpreted.", () => {
  test("user-controlled data containing Liquid syntax does not cause template injection", async () => {
    // Issue fields may contain {{ }}, {% %}, or other Liquid syntax.
    // These must be rendered as literal text (pass-through), not interpreted as template directives.
    await fc.assert(
      fc.asyncProperty(challengingIssueArb, async (issue) => {
        // Use the default template which references issue.identifier and issue.title
        const result = await buildPrompt("", issue);
        // The rendering must succeed (no error thrown) and produce non-empty output
        assert.ok(result.trim().length > 0);
        // The result must contain the structural markers from the default template
        assert.match(result, /Identifier:/);
        assert.match(result, /Title:/);
      }),
      { numRuns: 200 },
    );
  });

  test("Liquid-special characters in issue title are rendered literally, not interpreted", async () => {
    const liquidInjectionArb = fc.oneof(
      fc.constant("{{ 'injected' }}"),
      fc.constant("{% if true %}injected{% endif %}"),
      fc.constant("{{ issue.id }}"),
      fc.constant("{{ '' | append: 'evil' }}"),
      fc.constant("{% assign x = 1 %}{{ x }}"),
      fc.constant("}}{{}}"),
    );

    await fc.assert(
      fc.asyncProperty(liquidInjectionArb, async (maliciousTitle) => {
        const issue = makeIssue({ title: maliciousTitle });
        const template = `Title: {{ issue.title }}`;
        const result = await buildPrompt(template, issue);
        // The malicious title must appear literally in the output, not be interpreted
        assert.ok(result.includes(`Title: ${maliciousTitle}`));
        // Specifically verify it was NOT interpreted
        if (!maliciousTitle.includes("injected")) {
          assert.ok(!result.includes("injected"));
        }
        if (!maliciousTitle.includes("evil")) {
          assert.ok(!result.includes("evil"));
        }
      }),
      { numRuns: 50 },
    );
  });
});

describe("INVARIANT: When a prompt is rendered, issue.labels and issue.blocked_by SHALL be accessible as arrays.", () => {
  test("issue.labels is rendered as an array accessible via Liquid for-loop", async () => {
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
});
