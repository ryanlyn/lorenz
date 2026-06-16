import { test, describe } from "vitest";
import fc from "fast-check";
import { assert } from "@lorenz/test-utils";

import { parseWorkflowContent } from "@lorenz/workflow";

// --- Helpers ---

/**
 * Wraps a YAML scalar/array/value into front matter delimiters so that
 * parseWorkflowContent parses it as YAML.
 */
function wrapFrontMatter(yamlContent: string, body = ""): string {
  return `---\n${yamlContent}\n---\n${body}`;
}

// --- Arbitrary generators ---

/**
 * Generates YAML values that are guaranteed to parse as non-map types.
 * Covers: null, booleans, integers, floats, arrays (flow and block),
 * quoted strings, and YAML-tagged scalars.
 */
const guaranteedNonMapYamlArb = fc.oneof(
  // null literals
  fc.constantFrom("null", "~"),
  // boolean literals (YAML 1.1 and 1.2 forms)
  fc.constantFrom("true", "false", "yes", "no", "on", "off", "True", "False", "TRUE", "FALSE"),
  // integer scalars
  fc.integer({ min: -100000, max: 100000 }).map(String),
  // float scalars
  fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }).map((f) => f.toFixed(3)),
  // flow arrays
  fc
    .array(fc.constantFrom("a", "1", "true", "null"), { minLength: 1, maxLength: 5 })
    .map((items) => `[${items.join(", ")}]`),
  // block arrays with quoted strings (cannot be misinterpreted as key:value)
  fc
    .array(
      fc.string({ minLength: 1, maxLength: 10, unit: "grapheme" }).map((s) => JSON.stringify(s)),
      { minLength: 1, maxLength: 5 },
    )
    .map((items) => items.map((i) => `- ${i}`).join("\n")),
  // nested flow arrays
  fc
    .array(fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 3 }), {
      minLength: 1,
      maxLength: 3,
    })
    .map((nested) => `[${nested.map((inner) => `[${inner.join(", ")}]`).join(", ")}]`),
  // Explicit YAML tags for non-map types
  fc.constantFrom("!!int 42", "!!float 3.14", "!!bool true", "!!null null"),
  // Quoted strings (always scalars, never maps)
  fc
    .string({ minLength: 1, maxLength: 30, unit: "grapheme" })
    .map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`),
  // Literal block scalar
  fc
    .array(fc.string({ minLength: 1, maxLength: 20, unit: "grapheme" }), {
      minLength: 1,
      maxLength: 3,
    })
    .map((lines) => "|\n" + lines.map((l) => `  ${l.replace(/\n/g, " ")}`).join("\n")),
);

/**
 * Generates valid YAML map key names (identifier-like strings).
 */
const yamlKeyArb = fc
  .tuple(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
    fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_".split("")), {
      minLength: 0,
      maxLength: 9,
    }),
  )
  .map(([first, rest]) => first + rest.join(""));

describe("INVARIANT: When YAML front matter is not a map, the system SHALL produce a typed error.", () => {
  test("parseWorkflowContent SHALL produce a typed error when YAML front matter is not a map", () => {
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
        assert.ok(threw, `Expected parseWorkflowContent to throw for input: ${yamlValue}`);
        // Error must be a typed workflow error
        const isTypedError =
          errorMessage.includes("workflow_front_matter_not_a_map") ||
          errorMessage.includes("workflow_parse_error");
        assert.ok(isTypedError, `Expected typed error but got: ${errorMessage}`);
      }),
      { numRuns: 1000 },
    );
  });
});

test("INVARIANT: valid map front matter SHALL parse successfully and return config as a plain object", () => {
  fc.assert(
    fc.property(
      fc.dictionary(yamlKeyArb, fc.constantFrom("value1", "42", "true", "null"), {
        minKeys: 1,
        maxKeys: 5,
      }),
      (dict) => {
        const yamlLines = Object.entries(dict).map(([k, v]) => `${k}: ${v}`);
        const content = wrapFrontMatter(yamlLines.join("\n"), "body");
        // Should NOT throw - valid maps are accepted
        const result = parseWorkflowContent(content);
        assert.ok(typeof result.config === "object" && result.config !== null);
        assert.ok(!Array.isArray(result.config));
      },
    ),
    { numRuns: 500 },
  );
});

test("INVARIANT: content without front matter delimiters SHALL return full content as body with empty config", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 100 }).filter((s) => !s.startsWith("---")),
      (content) => {
        const result = parseWorkflowContent(content);
        assert.deepEqual(result.config, {});
        assert.equal(result.body, content.trim());
      },
    ),
    { numRuns: 1000 },
  );
});
