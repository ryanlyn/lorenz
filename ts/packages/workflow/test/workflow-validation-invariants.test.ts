import { test } from "vitest";
import fc from "fast-check";
import { buildPrompt } from "@symphony/prompt";
import type { Issue } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import { parseWorkflowContent } from "@symphony/workflow";

// --- Helpers ---

/**
 * Constructs a minimal valid Issue for use with buildPrompt.
 */
function minimalIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "Test Issue",
    state: "Todo",
    stateType: null,
    description: null,
    branchName: null,
    url: null,
    priority: null,
    createdAt: null,
    updatedAt: null,
    labels: [],
    blockers: [],
    assigneeId: null,
    assignedToWorker: true,
    ...overrides,
  };
}

/**
 * Wraps a YAML scalar/array/value into front matter delimiters so that
 * parseWorkflowContent parses it as YAML.
 */
function wrapFrontMatter(yamlContent: string, body = ""): string {
  return `---\n${yamlContent}\n---\n${body}`;
}

// --- Arbitrary generators ---

/** Generates YAML scalars that are NOT maps: strings, numbers, booleans, arrays. */
const nonMapYamlArb = fc.oneof(
  // Plain strings that YAML will parse as scalars
  fc.constantFrom("hello", "true", "false", "null", "42", "3.14", "~"),
  // Integers as YAML scalars
  fc.integer({ min: -1000, max: 1000 }).map(String),
  // Floats as YAML scalars
  fc.double({ min: -1000, max: 1000, noNaN: true }).map(String),
  // YAML arrays: [a, b, c]
  fc
    .array(fc.constantFrom("a", "1", "true", "null"), { minLength: 1, maxLength: 5 })
    .map((items) => `[${items.join(", ")}]`),
  // YAML flow sequence on its own line
  fc
    .array(fc.constantFrom("x", "y", "z"), { minLength: 1, maxLength: 3 })
    .map((items) => `- ${items.join("\n- ")}`),
);

/**
 * Generates YAML values that are guaranteed to parse as non-map types.
 * These are more targeted than nonMapYamlArb and should always trigger errors.
 */
const guaranteedNonMapYamlArb = fc.oneof(
  // null literal - always parses to null
  fc.constant("null"),
  fc.constant("~"),
  // boolean literals
  fc.constant("true"),
  fc.constant("false"),
  // numeric scalars
  fc.integer({ min: -100000, max: 100000 }).map(String),
  // flow arrays
  fc
    .array(fc.constantFrom("a", "1", "true"), { minLength: 1, maxLength: 5 })
    .map((items) => `[${items.join(", ")}]`),
  // block arrays with quoted strings to avoid key:value interpretation
  fc
    .array(
      fc.string({ minLength: 1, maxLength: 10, unit: "grapheme" }).map((s) => JSON.stringify(s)),
      { minLength: 1, maxLength: 5 },
    )
    .map((items) => items.map((i) => `- ${i}`).join("\n")),
  // Explicit YAML tags for non-map types
  fc.constant("!!int 42"),
  fc.constant("!!float 3.14"),
  fc.constant("!!bool true"),
  fc.constant("!!null null"),
  // Quoted strings (definitely scalars, not maps)
  fc.string({ minLength: 1, maxLength: 30, unit: "grapheme" }).map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`),
);

/**
 * Liquid reserved words and built-in values that the template engine handles
 * specially (not treated as variable lookups).
 */
const liquidReservedWords = [
  "issue", "attempt", "ensemble",
  // Liquid keywords / operators
  "and", "or", "not", "in", "contains",
  "true", "false", "nil", "null", "blank", "empty",
  // Liquid tag names that could conflict
  "if", "else", "elsif", "endif", "unless", "endunless",
  "for", "endfor", "break", "continue",
  "case", "when", "endcase",
  "assign", "capture", "endcapture",
  "comment", "endcomment",
  "raw", "endraw",
  "increment", "decrement",
  "include", "render",
  "tablerow", "endtablerow",
  "cycle", "forloop",
  // Common Liquid objects
  "now", "today",
];

/**
 * Generates variable names that are NOT part of the standard Liquid context
 * provided by buildPrompt (which only exposes: issue, attempt, ensemble).
 */
const alphaChars = "abcdefghijklmnopqrstuvwxyz".split("");
const unknownVariableNameArb = fc
  .array(fc.constantFrom(...alphaChars), { minLength: 1, maxLength: 15 })
  .map((chars) => chars.join(""))
  .filter((name) => !liquidReservedWords.includes(name));

/**
 * Generates variable names with mixed alphanumeric and underscore characters
 * that are still NOT part of the known context or Liquid reserved words.
 */
const alphaNumUnderscoreChars = "abcdefghijklmnopqrstuvwxyz0123456789_".split("");
const unknownVariableNameExtendedArb = fc
  .tuple(
    fc.constantFrom(...alphaChars), // must start with letter
    fc.array(fc.constantFrom(...alphaNumUnderscoreChars), { minLength: 0, maxLength: 14 }),
  )
  .map(([first, rest]) => first + rest.join(""))
  .filter((name) => !liquidReservedWords.includes(name));

// --- Invariant 1: YAML front matter not a map produces a typed error ---

test("invariant 1: parseWorkflowContent SHALL produce a typed error when YAML front matter is not a map", () => {
  fc.assert(
    fc.property(nonMapYamlArb, fc.string({ maxLength: 50 }), (yamlValue, body) => {
      const content = wrapFrontMatter(yamlValue, body);
      let threw = false;
      let errorMessage = "";
      try {
        parseWorkflowContent(content);
      } catch (err: unknown) {
        threw = true;
        errorMessage = err instanceof Error ? err.message : String(err);
      }
      // The system SHALL produce a typed error (either parse error or not-a-map error)
      // when the YAML front matter resolves to a non-map value.
      // Some scalar strings may parse as valid YAML maps (unlikely with our generators),
      // but any non-map parse result must throw.
      if (threw) {
        // The error must be one of the two workflow-specific errors
        const isTypedError =
          errorMessage.includes("workflow_front_matter_not_a_map") ||
          errorMessage.includes("workflow_parse_error");
        assert.ok(isTypedError);
      }
      // If it did not throw, it means YAML parsed the content as a valid map
      // (e.g. "hello" can become {hello: null} in YAML block context) - that's acceptable.
      // The invariant is: when it IS not a map, it SHALL error. So we verify the result
      // if it didn't throw.
      if (!threw) {
        const result = parseWorkflowContent(content);
        // If no error, the config must be a plain object (map) - never an array or scalar
        assert.ok(typeof result.config === "object" && result.config !== null);
        assert.ok(!Array.isArray(result.config));
      }
    }),
    { numRuns: 200 },
  );
});

test("invariant 1: explicit non-map YAML types (null literal) SHALL produce workflow_front_matter_not_a_map error", () => {
  // "null" as the only YAML content parses to JavaScript null
  const content = wrapFrontMatter("null", "body text");
  assert.throws(() => parseWorkflowContent(content), /workflow_front_matter_not_a_map/);
});

test("invariant 1: tilde (YAML null alias) SHALL produce workflow_front_matter_not_a_map error", () => {
  const content = wrapFrontMatter("~", "body text");
  assert.throws(() => parseWorkflowContent(content), /workflow_front_matter_not_a_map/);
});

test("invariant 1: YAML array front matter SHALL produce workflow_front_matter_not_a_map error", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 10, unit: "grapheme" }), {
        minLength: 1,
        maxLength: 5,
      }),
      (items) => {
        // Generate a YAML array using flow syntax
        const yamlArray = `[${items.map((i) => JSON.stringify(i)).join(", ")}]`;
        const content = wrapFrontMatter(yamlArray, "body");
        assert.throws(() => parseWorkflowContent(content), /workflow_front_matter_not_a_map/);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 1: YAML numeric scalar front matter SHALL produce workflow_front_matter_not_a_map error", () => {
  fc.assert(
    fc.property(fc.integer({ min: -10000, max: 10000 }), (n) => {
      const content = wrapFrontMatter(String(n), "body");
      assert.throws(() => parseWorkflowContent(content), /workflow_front_matter_not_a_map/);
    }),
    { numRuns: 200 },
  );
});

test("invariant 1: YAML boolean scalars SHALL produce workflow_front_matter_not_a_map error", () => {
  fc.assert(
    fc.property(fc.constantFrom("true", "false", "yes", "no", "on", "off", "True", "False", "TRUE", "FALSE"), (boolStr) => {
      const content = wrapFrontMatter(boolStr, "body");
      assert.throws(() => parseWorkflowContent(content), /workflow_front_matter_not_a_map/);
    }),
    { numRuns: 200 },
  );
});

test("invariant 1: YAML float scalars SHALL produce workflow_front_matter_not_a_map error", () => {
  fc.assert(
    fc.property(
      fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
      (f) => {
        // Use a float representation that YAML will parse as a number
        const content = wrapFrontMatter(f.toFixed(3), "body");
        assert.throws(() => parseWorkflowContent(content), /workflow_front_matter_not_a_map/);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 1: guaranteed non-map YAML SHALL always produce a typed error", () => {
  fc.assert(
    fc.property(guaranteedNonMapYamlArb, (yamlValue) => {
      const content = wrapFrontMatter(yamlValue, "body");
      let threw = false;
      let errorMessage = "";
      try {
        parseWorkflowContent(content);
      } catch (err: unknown) {
        threw = true;
        errorMessage = err instanceof Error ? err.message : String(err);
      }
      // Must throw for guaranteed non-map values
      assert.ok(threw);
      // Error must be typed
      const isTypedError =
        errorMessage.includes("workflow_front_matter_not_a_map") ||
        errorMessage.includes("workflow_parse_error");
      assert.ok(isTypedError);
    }),
    { numRuns: 200 },
  );
});

test("invariant 1: valid map front matter SHALL NOT throw", () => {
  fc.assert(
    fc.property(
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 10, unit: "grapheme" }).filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
        fc.constantFrom("value1", "42", "true", "null"),
        { minKeys: 1, maxKeys: 5 },
      ),
      (dict) => {
        const yamlLines = Object.entries(dict).map(([k, v]) => `${k}: ${v}`);
        const content = wrapFrontMatter(yamlLines.join("\n"), "body");
        // Should NOT throw - valid maps are fine
        const result = parseWorkflowContent(content);
        assert.ok(typeof result.config === "object" && result.config !== null);
        assert.ok(!Array.isArray(result.config));
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 1: empty front matter SHALL produce empty config object", () => {
  const content = wrapFrontMatter("", "body text");
  const result = parseWorkflowContent(content);
  assert.deepEqual(result.config, {});
  assert.equal(result.body, "body text");
});

test("invariant 1: whitespace-only front matter SHALL produce empty config object", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(" ", "\t"), { minLength: 1, maxLength: 10 }).map((a) => a.join("")),
      (ws) => {
        const content = wrapFrontMatter(ws, "body");
        const result = parseWorkflowContent(content);
        assert.deepEqual(result.config, {});
      },
    ),
    { numRuns: 50 },
  );
});

test("invariant 1: content without front matter delimiters SHALL return full content as body", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 100 }).filter((s) => !s.startsWith("---")),
      (content) => {
        const result = parseWorkflowContent(content);
        assert.deepEqual(result.config, {});
        assert.equal(result.body, content.trim());
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 1: nested arrays in flow syntax SHALL produce workflow_front_matter_not_a_map error", () => {
  fc.assert(
    fc.property(
      fc.array(fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 3 }), {
        minLength: 1,
        maxLength: 3,
      }),
      (nested) => {
        const yamlArray = `[${nested.map((inner) => `[${inner.join(", ")}]`).join(", ")}]`;
        const content = wrapFrontMatter(yamlArray, "body");
        assert.throws(() => parseWorkflowContent(content), /workflow_front_matter_not_a_map/);
      },
    ),
    { numRuns: 100 },
  );
});

test("invariant 1: YAML multiline string (literal block) SHALL produce workflow_front_matter_not_a_map error", () => {
  // A literal block scalar (|) parses to a string, not a map
  const content = wrapFrontMatter("|\n  line one\n  line two", "body");
  assert.throws(() => parseWorkflowContent(content), /workflow_front_matter_not_a_map/);
});

test("invariant 1: YAML quoted string SHALL produce workflow_front_matter_not_a_map error", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 0, maxLength: 30, unit: "grapheme" }),
      (s) => {
        // Double-quoted string is always a scalar
        const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
        const content = wrapFrontMatter(`"${escaped}"`, "body");
        assert.throws(() => parseWorkflowContent(content), /workflow_front_matter_not_a_map/);
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 2: Unknown variable in prompt template SHALL fail strictly ---

test("invariant 2: rendering a prompt template referencing an unknown variable SHALL fail strictly", () => {
  fc.assert(
    fc.asyncProperty(unknownVariableNameArb, async (varName) => {
      const template = `Hello {{ ${varName} }}`;
      const issue = minimalIssue();
      await assert.rejects(() => buildPrompt(template, issue));
    }),
    { numRuns: 200 },
  );
});

test("invariant 2: extended variable names (with digits and underscores) SHALL fail strictly", () => {
  fc.assert(
    fc.asyncProperty(unknownVariableNameExtendedArb, async (varName) => {
      const template = `Value: {{ ${varName} }}`;
      const issue = minimalIssue();
      await assert.rejects(() => buildPrompt(template, issue));
    }),
    { numRuns: 200 },
  );
});

test("invariant 2: nested unknown variable paths SHALL fail strictly", () => {
  fc.assert(
    fc.asyncProperty(
      unknownVariableNameArb,
      unknownVariableNameArb,
      async (obj, prop) => {
        const template = `Value: {{ ${obj}.${prop} }}`;
        const issue = minimalIssue();
        await assert.rejects(() => buildPrompt(template, issue));
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 2: unknown property on known object SHALL fail strictly", () => {
  const knownIssueProps = [
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
  const unknownIssuePropArb = fc
    .array(fc.constantFrom(...alphaChars), { minLength: 1, maxLength: 15 })
    .map((chars) => chars.join(""))
    .filter((name) => !knownIssueProps.includes(name));

  fc.assert(
    fc.asyncProperty(unknownIssuePropArb, async (propName) => {
      const template = `Issue prop: {{ issue.${propName} }}`;
      const issue = minimalIssue();
      await assert.rejects(() => buildPrompt(template, issue));
    }),
    { numRuns: 200 },
  );
});

test("invariant 2: unknown nested property on ensemble SHALL fail strictly", () => {
  const knownEnsembleProps = ["enabled", "slot_index", "size"];
  const unknownEnsemblePropArb = fc
    .array(fc.constantFrom(...alphaChars), { minLength: 1, maxLength: 12 })
    .map((chars) => chars.join(""))
    .filter((name) => !knownEnsembleProps.includes(name));

  fc.assert(
    fc.asyncProperty(unknownEnsemblePropArb, async (propName) => {
      const template = `Ensemble: {{ ensemble.${propName} }}`;
      const issue = minimalIssue();
      await assert.rejects(() => buildPrompt(template, issue));
    }),
    { numRuns: 200 },
  );
});

test("invariant 2: multiple unknown variables in one template SHALL fail strictly", () => {
  fc.assert(
    fc.asyncProperty(
      unknownVariableNameArb,
      unknownVariableNameArb,
      async (var1, var2) => {
        const template = `First: {{ ${var1} }} Second: {{ ${var2} }}`;
        const issue = minimalIssue();
        await assert.rejects(() => buildPrompt(template, issue));
      },
    ),
    { numRuns: 100 },
  );
});

test("invariant 2: known variables SHALL render successfully (positive control)", () => {
  fc.assert(
    fc.asyncProperty(
      fc.constantFrom("issue.title", "issue.identifier", "issue.state", "attempt", "ensemble.size"),
      async (varExpr) => {
        const template = `Value: {{ ${varExpr} }}`;
        const issue = minimalIssue();
        const result = await buildPrompt(template, issue);
        // Must produce a non-empty string (not throw)
        assert.ok(typeof result === "string");
        assert.ok(result.length > 0);
      },
    ),
    { numRuns: 50 },
  );
});

test("invariant 2: unknown filter SHALL fail strictly", () => {
  fc.assert(
    fc.asyncProperty(unknownVariableNameArb, async (filterName) => {
      // Liquid strictFilters means unknown filters should also fail
      const template = `Value: {{ issue.title | ${filterName} }}`;
      const issue = minimalIssue();
      await assert.rejects(() => buildPrompt(template, issue));
    }),
    { numRuns: 100 },
  );
});

test("invariant 2: deeply nested unknown paths SHALL fail strictly", () => {
  fc.assert(
    fc.asyncProperty(
      fc.array(unknownVariableNameArb, { minLength: 2, maxLength: 4 }),
      async (parts) => {
        const template = `Deep: {{ ${parts.join(".")} }}`;
        const issue = minimalIssue();
        await assert.rejects(() => buildPrompt(template, issue));
      },
    ),
    { numRuns: 100 },
  );
});

test("invariant 2: unknown variable in conditional block SHALL fail strictly", () => {
  fc.assert(
    fc.asyncProperty(unknownVariableNameArb, async (varName) => {
      const template = `{% if ${varName} %}yes{% endif %}`;
      const issue = minimalIssue();
      await assert.rejects(() => buildPrompt(template, issue));
    }),
    { numRuns: 100 },
  );
});

test("invariant 2: unknown variable in for loop SHALL fail strictly", () => {
  fc.assert(
    fc.asyncProperty(unknownVariableNameArb, async (varName) => {
      const template = `{% for item in ${varName} %}{{ item }}{% endfor %}`;
      const issue = minimalIssue();
      await assert.rejects(() => buildPrompt(template, issue));
    }),
    { numRuns: 100 },
  );
});

test("invariant 2: empty template SHALL use default and render without error", async () => {
  const issue = minimalIssue({ title: "My Title", identifier: "X-1" });
  // Empty template triggers the default prompt template which references issue.*
  const result = await buildPrompt("", issue);
  assert.ok(typeof result === "string");
  assert.ok(result.includes("X-1"));
  assert.ok(result.includes("My Title"));
});

test("invariant 2: whitespace-only template SHALL use default and render without error", async () => {
  fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom(" ", "\t", "\n"), { minLength: 1, maxLength: 20 }).map((a) => a.join("")),
      async (ws) => {
        const issue = minimalIssue({ identifier: "WS-1" });
        const result = await buildPrompt(ws, issue);
        assert.ok(typeof result === "string");
        // default template includes identifier
        assert.ok(result.includes("WS-1"));
      },
    ),
    { numRuns: 50 },
  );
});
