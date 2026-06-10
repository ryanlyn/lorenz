import { test, describe } from "vitest";
import fc from "fast-check";
import { ISSUE_STATE_TYPES } from "@symphony/domain";

import { assert } from "../../../test/assert.js";

import { normalizeIssue } from "@symphony/issue";

// --- Helper arbitraries ---

/** Non-empty, non-whitespace-only string suitable for required fields. */
const nonBlankString = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => s.trim().length > 0);

/**
 * Unicode-heavy string including CJK, combining chars, emoji, RTL, and zero-width chars.
 * This exercises normalization paths that simple ASCII doesn't.
 */
const unicodeString = fc.oneof(
  nonBlankString,
  fc.constantFrom(
    "世界", // CJK "world"
    "café", // combining accent (e + combining acute)
    "‮hello", // RTL override
    "​foo​", // zero-width space around "foo"
    "😀test", // emoji prefix
    "äb̧c", // combining diacritics
    "ß", // German sharp-s (uppercases to SS)
    "İ", // Turkish dotted I (uppercase)
    "STRASSEE", // tests locale-independent lowering
  ),
);

/**
 * Strings with leading/trailing whitespace and tabs, useful for testing trimming.
 */
const paddedString = fc
  .tuple(
    fc.constantFrom("", " ", "  ", "\t", "\n", "\r\n", " \t "),
    fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
    fc.constantFrom("", " ", "  ", "\t", "\n", "\r\n", " \t "),
  )
  .map(([pre, core, suf]) => pre + core + suf);

/** Minimal valid issue input for normalizeIssue. */
function validIssueInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "A title",
    state: { name: "Todo", type: "unstarted" },
    ...overrides,
  };
}

describe("INVARIANT: When a state value is resolved, the system SHALL accept nested object form, snake_case, camelCase, and direct string form (in that priority order).", () => {
  test("state resolution accepts nested object form { state: { name, type } }", () => {
    fc.assert(
      fc.property(nonBlankString, (stateName) => {
        const issue = normalizeIssue(
          validIssueInput({ state: { name: stateName, type: "unstarted" } }),
        );
        assert.equal(issue.state, stateName);
      }),
      { numRuns: 200 },
    );
  });

  test("state resolution accepts snake_case state_name", () => {
    fc.assert(
      fc.property(nonBlankString, (stateName) => {
        const issue = normalizeIssue(
          validIssueInput({ state: undefined, state_name: stateName, state_type: "unstarted" }),
        );
        assert.equal(issue.state, stateName);
      }),
      { numRuns: 200 },
    );
  });

  test("state resolution skips invalid preferred fields before valid fallback forms", () => {
    const issueFromSnakeCase = normalizeIssue(
      validIssueInput({ state: {}, state_name: "Todo", state_type: "unstarted" }),
    );
    assert.equal(issueFromSnakeCase.state, "Todo");

    const issueFromCamelCase = normalizeIssue(
      validIssueInput({
        state: undefined,
        state_name: 123,
        stateName: "In Progress",
        stateType: "started",
      }),
    );
    assert.equal(issueFromCamelCase.state, "In Progress");
  });

  test("state resolution accepts camelCase stateName", () => {
    fc.assert(
      fc.property(nonBlankString, (stateName) => {
        const issue = normalizeIssue(
          validIssueInput({
            state: undefined,
            state_name: undefined,
            stateName,
            stateType: "unstarted",
          }),
        );
        assert.equal(issue.state, stateName);
      }),
      { numRuns: 200 },
    );
  });

  test("state resolution accepts direct string form", () => {
    fc.assert(
      fc.property(nonBlankString, (stateName) => {
        const issue = normalizeIssue(
          validIssueInput({ state: stateName, state_type: "unstarted" }),
        );
        assert.equal(issue.state, stateName);
      }),
      { numRuns: 200 },
    );
  });

  test("nested object form takes priority over snake_case and camelCase", () => {
    fc.assert(
      fc.property(nonBlankString, nonBlankString, nonBlankString, (nested, snake, camel) => {
        fc.pre(nested !== snake && nested !== camel);
        const issue = normalizeIssue(
          validIssueInput({
            state: { name: nested, type: "unstarted" },
            state_name: snake,
            stateName: camel,
          }),
        );
        assert.equal(issue.state, nested);
      }),
      { numRuns: 200 },
    );
  });

  test("snake_case takes priority over camelCase when no nested object", () => {
    fc.assert(
      fc.property(nonBlankString, nonBlankString, (snake, camel) => {
        fc.pre(snake !== camel);
        const issue = normalizeIssue(
          validIssueInput({
            state: undefined,
            state_name: snake,
            stateName: camel,
            state_type: "unstarted",
          }),
        );
        assert.equal(issue.state, snake);
      }),
      { numRuns: 200 },
    );
  });

  test("state is preserved exactly (not trimmed or lowercased)", () => {
    fc.assert(
      fc.property(paddedString, (stateName) => {
        const issue = normalizeIssue(
          validIssueInput({ state: { name: stateName, type: "unstarted" } }),
        );
        assert.equal(issue.state, stateName);
      }),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When labels are normalized, they SHALL be trimmed, lowercased, and empty strings filtered out.", () => {
  test("labels are trimmed and lowercased", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
          { maxLength: 10 },
        ),
        (rawLabels) => {
          const issue = normalizeIssue(validIssueInput({ labels: rawLabels }));
          for (const label of issue.labels) {
            assert.equal(label, label.trim());
            assert.equal(label, label.toLowerCase());
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("label normalization preserves relative order of non-blank inputs", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 30 }), { minLength: 1, maxLength: 10 }),
        (rawLabels) => {
          const issue = normalizeIssue(validIssueInput({ labels: rawLabels }));
          const nonBlankInputs = rawLabels.filter((l) => l.trim() !== "");
          assert.equal(issue.labels.length, nonBlankInputs.length);
          for (let i = 0; i < nonBlankInputs.length; i++) {
            assert.equal(issue.labels[i], nonBlankInputs[i]!.trim().toLowerCase());
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("labels from object form { name } are also normalized", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
          { maxLength: 10 },
        ),
        (names) => {
          const labelObjects = names.map((name) => ({ name }));
          const issue = normalizeIssue(validIssueInput({ labels: labelObjects }));
          for (const label of issue.labels) {
            assert.equal(label, label.trim());
            assert.equal(label, label.toLowerCase());
          }
          assert.equal(issue.labels.length, names.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("labels with unicode are trimmed and lowercased", () => {
    fc.assert(
      fc.property(
        fc.array(
          unicodeString.filter((s) => s.trim().length > 0),
          { minLength: 1, maxLength: 5 },
        ),
        (rawLabels) => {
          const issue = normalizeIssue(validIssueInput({ labels: rawLabels }));
          for (const label of issue.labels) {
            assert.equal(label, label.trim());
            assert.equal(label, label.toLowerCase());
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("non-array labels produce empty array", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.integer(),
          fc.string({ maxLength: 20 }),
          fc.record({ key: fc.string() }),
        ),
        (invalidLabels) => {
          const issue = normalizeIssue(validIssueInput({ labels: invalidLabels }));
          assert.deepEqual(issue.labels, []);
        },
      ),
      { numRuns: 50 },
    );
  });

  test("normalization is idempotent (applying twice yields same result)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
          { minLength: 1, maxLength: 5 },
        ),
        (rawLabels) => {
          const issue1 = normalizeIssue(validIssueInput({ labels: rawLabels }));
          const issue2 = normalizeIssue(validIssueInput({ labels: issue1.labels }));
          assert.deepEqual(issue1.labels, issue2.labels);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('INVARIANT: When blockers are resolved, the system SHALL prefer an explicit blockers array, falling back to filtering relations where type equals "blocks" (case-insensitive).', () => {
  test("explicit blockers array is preferred over relations", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: nonBlankString, identifier: nonBlankString }), {
          minLength: 1,
          maxLength: 5,
        }),
        (blockerList) => {
          const issue = normalizeIssue(
            validIssueInput({
              blockers: blockerList,
              relations: [
                { type: "blocks", relatedIssue: { id: "should-not-appear", identifier: "X-99" } },
              ],
            }),
          );
          assert.equal(issue.blockers.length, blockerList.length);
          for (let i = 0; i < blockerList.length; i++) {
            assert.equal(issue.blockers[i]!.id, blockerList[i]!.id);
          }
          const ids = issue.blockers.map((b) => b.id);
          assert.equal(ids.includes("should-not-appear"), false);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("relations with type 'blocks' (case-insensitive) become blockers when no explicit blockers array", () => {
    fc.assert(
      fc.property(
        fc
          .tuple(
            fc.constantFrom("blocks", "Blocks", "BLOCKS"),
            fc.constantFrom("", " ", "  ", "\t"),
            fc.constantFrom("", " ", "  ", "\t"),
          )
          .map(([base, pre, suf]) => pre + base + suf),
        nonBlankString,
        (typeStr, blockerId) => {
          const issue = normalizeIssue(
            validIssueInput({
              relations: [
                { type: typeStr, relatedIssue: { id: blockerId, identifier: "BLK-1" } },
                { type: "relates", relatedIssue: { id: "other", identifier: "REL-1" } },
              ],
            }),
          );
          assert.equal(issue.blockers.length, 1);
          assert.equal(issue.blockers[0]!.id, blockerId);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("non-blocks relations are not included as blockers", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((s) => s.trim().toLowerCase() !== "blocks"),
        (relationType) => {
          const issue = normalizeIssue(
            validIssueInput({
              relations: [{ type: relationType, relatedIssue: { id: "x", identifier: "X-1" } }],
            }),
          );
          assert.equal(issue.blockers.length, 0);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("relations with 'issue' field (not relatedIssue) are also recognized", () => {
    fc.assert(
      fc.property(nonBlankString, nonBlankString, (blockerId, blockerIdent) => {
        const issue = normalizeIssue(
          validIssueInput({
            relations: [{ type: "blocks", issue: { id: blockerId, identifier: blockerIdent } }],
          }),
        );
        assert.equal(issue.blockers.length, 1);
        assert.equal(issue.blockers[0]!.id, blockerId);
        assert.equal(issue.blockers[0]!.identifier, blockerIdent);
      }),
      { numRuns: 200 },
    );
  });

  test("empty blockers array means zero blockers regardless of block relations", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: nonBlankString, identifier: nonBlankString }), {
          minLength: 1,
          maxLength: 5,
        }),
        (blockerRefs) => {
          const relations = blockerRefs.map((ref) => ({
            type: "blocks",
            relatedIssue: ref,
          }));
          const issue = normalizeIssue(validIssueInput({ blockers: [], relations }));
          assert.equal(issue.blockers.length, 0);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("multiple blocking relations all become blockers", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: nonBlankString, identifier: nonBlankString }), {
          minLength: 2,
          maxLength: 5,
        }),
        (blockerRefs) => {
          const relations = blockerRefs.map((ref) => ({
            type: "blocks",
            relatedIssue: ref,
          }));
          const issue = normalizeIssue(validIssueInput({ relations }));
          assert.equal(issue.blockers.length, blockerRefs.length);
          for (let i = 0; i < blockerRefs.length; i++) {
            assert.equal(issue.blockers[i]!.id, blockerRefs[i]!.id);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When an assignee filter is configured and the issue has no assignee, it SHALL be marked as not assigned to this worker.", () => {
  test("issue with no assignee is marked assignedToWorker=false when filter is configured", () => {
    fc.assert(
      fc.property(nonBlankString, (assigneeFilter) => {
        const issue = normalizeIssue(validIssueInput({}), assigneeFilter);
        assert.equal(issue.assignedToWorker, false);
      }),
      { numRuns: 200 },
    );
  });

  test("issue with null assignee_id is marked assignedToWorker=false when filter is configured", () => {
    fc.assert(
      fc.property(nonBlankString, (assigneeFilter) => {
        const issue = normalizeIssue(validIssueInput({ assignee_id: null }), assigneeFilter);
        assert.equal(issue.assignedToWorker, false);
      }),
      { numRuns: 200 },
    );
  });

  test("no assignee filter (undefined) means assignedToWorker=true regardless", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.constant(null), nonBlankString),
        (assigneeId) => {
          const issue = normalizeIssue(validIssueInput({ assignee_id: assigneeId }), undefined);
          assert.equal(issue.assignedToWorker, true);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("empty string assignee filter means assignedToWorker=true regardless", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), fc.constant(null), nonBlankString),
        (assigneeId) => {
          const issue = normalizeIssue(validIssueInput({ assignee_id: assigneeId }), "");
          assert.equal(issue.assignedToWorker, true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When an assignee filter is configured, comparison SHALL be case-insensitive.", () => {
  test("assignee comparison is case-insensitive", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        (assigneeId) => {
          const issue = normalizeIssue(
            validIssueInput({ assignee: { id: assigneeId.toUpperCase() } }),
            assigneeId.toLowerCase(),
          );
          assert.equal(issue.assignedToWorker, true);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("assignee comparison is case-insensitive with mixed case", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 30 })
          .filter((s) => /[a-zA-Z]/.test(s) && s.trim().length > 0),
        fc.func(fc.boolean()),
        (assigneeId, caseFlip) => {
          const randomCased = assigneeId
            .split("")
            .map((ch, i) => (caseFlip(i) ? ch.toUpperCase() : ch.toLowerCase()))
            .join("");
          const issue = normalizeIssue(
            validIssueInput({ assignee_id: randomCased }),
            assigneeId.toLowerCase(),
          );
          assert.equal(issue.assignedToWorker, true);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("mismatched assignee is marked assignedToWorker=false", () => {
    fc.assert(
      fc.property(nonBlankString, nonBlankString, (issueAssignee, filterAssignee) => {
        fc.pre(issueAssignee.toLowerCase() !== filterAssignee.toLowerCase());
        const issue = normalizeIssue(
          validIssueInput({ assignee: { id: issueAssignee } }),
          filterAssignee,
        );
        assert.equal(issue.assignedToWorker, false);
      }),
      { numRuns: 200 },
    );
  });

  test("assignee nested object id takes priority over assignee_id", () => {
    fc.assert(
      fc.property(nonBlankString, nonBlankString, (nestedId, flatId) => {
        fc.pre(nestedId.toLowerCase() !== flatId.toLowerCase());
        const issue = normalizeIssue(
          validIssueInput({ assignee: { id: nestedId }, assignee_id: flatId }),
          nestedId,
        );
        assert.equal(issue.assignedToWorker, true);
      }),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When an issue is missing any required field, normalization SHALL reject it.", () => {
  test("arbitrary records missing required fields are rejected", () => {
    const requiredKeys = ["id", "identifier", "title", "state"];
    const arbitraryExtraRecord = fc
      .array(
        fc.tuple(
          fc.string({ minLength: 1, maxLength: 15 }).filter((k) => !requiredKeys.includes(k)),
          fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.constant([])),
        ),
        { maxLength: 10 },
      )
      .map((entries) => Object.fromEntries(entries));

    fc.assert(
      fc.property(
        arbitraryExtraRecord,
        fc.constantFrom(...requiredKeys),
        (extraFields, missingKey) => {
          const input: Record<string, unknown> = {
            id: "some-id",
            identifier: "PROJ-1",
            title: "A title",
            state: "Todo",
            state_type: "unstarted",
            ...extraFields,
          };
          delete input[missingKey];
          assert.throws(
            () => normalizeIssue(input),
            new RegExp(`issue\\.${missingKey} is required`),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  test("invalid types for required fields cause rejection regardless of other fields", () => {
    const requiredKeys = ["id", "identifier", "title"];
    const invalidValues = fc.oneof(
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.constant([]),
      fc.constant({}),
    );

    fc.assert(
      fc.property(
        invalidValues,
        fc.constantFrom(...requiredKeys),
        fc.record({
          description: fc.option(fc.string(), { nil: undefined }),
          labels: fc.option(fc.array(fc.string()), { nil: undefined }),
          priority: fc.option(fc.integer(), { nil: undefined }),
        }),
        (badValue, targetKey, extras) => {
          const input: Record<string, unknown> = {
            id: "some-id",
            identifier: "PROJ-1",
            title: "A title",
            state: "Todo",
            state_type: "unstarted",
            ...extras,
          };
          input[targetKey] = badValue;
          assert.throws(
            () => normalizeIssue(input),
            new RegExp(`issue\\.${targetKey} is required`),
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  test("blank/whitespace-only required fields cause rejection", () => {
    const requiredKeys = ["id", "identifier", "title", "state"];
    const whitespaceString = fc
      .array(fc.constantFrom(" ", "\t", "\n", "\r"), { minLength: 0, maxLength: 5 })
      .map((chars) => chars.join(""));

    fc.assert(
      fc.property(whitespaceString, fc.constantFrom(...requiredKeys), (blank, targetKey) => {
        const input: Record<string, unknown> = {
          id: "some-id",
          identifier: "PROJ-1",
          title: "A title",
          state: "Todo",
          state_type: "unstarted",
        };
        input[targetKey] = blank;
        assert.throws(() => normalizeIssue(input), new RegExp(`issue\\.${targetKey} is required`));
      }),
      { numRuns: 200 },
    );
  });
});

describe("INVARIANT: When a state type is normalized, only values in the canonical set SHALL be accepted; others SHALL become null.", () => {
  test("canonical state types with random casing and padding are accepted", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ISSUE_STATE_TYPES),
        fc.func(fc.boolean()),
        fc.constantFrom("", " ", "  ", "\t", " \t "),
        fc.constantFrom("", " ", "  ", "\t", " \t "),
        (stateType, caseFlip, prefix, suffix) => {
          const mixedCase = stateType
            .split("")
            .map((ch, i) => (caseFlip(i) ? ch.toUpperCase() : ch.toLowerCase()))
            .join("");
          const padded = prefix + mixedCase + suffix;
          const issue = normalizeIssue(validIssueInput({ state: { name: "Todo", type: padded } }));
          assert.equal(issue.stateType, stateType);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("non-canonical state types throw", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 30 })
          .filter(
            (s) =>
              !ISSUE_STATE_TYPES.includes(
                s.trim().toLowerCase() as (typeof ISSUE_STATE_TYPES)[number],
              ),
          ),
        (invalidType) => {
          assert.throws(
            () => normalizeIssue(validIssueInput({ state: { name: "Todo", type: invalidType } })),
            /stateType is required/,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  test("near-miss state types (mutations of valid types) throw", () => {
    const mutatedStateType = fc
      .constantFrom(...ISSUE_STATE_TYPES)
      .chain((base) =>
        fc.oneof(
          // Truncate: remove 1-2 trailing characters
          fc.constantFrom(1, 2).map((n) => base.slice(0, -n)),
          // Append: add a suffix
          fc.constantFrom("s", "d", "ed", "ing", "x", "ss", "er").map((suffix) => base + suffix),
          // Prepend: add a prefix
          fc.constantFrom("un", "re", "pre", "non-", "un-").map((prefix) => prefix + base),
          // Character swap: swap adjacent characters
          fc.nat({ max: 5 }).map((i) => {
            const idx = i % Math.max(1, base.length - 1);
            return base.slice(0, idx) + base[idx + 1] + base[idx] + base.slice(idx + 2);
          }),
          // Character deletion: remove a character from the middle
          fc.nat({ max: 5 }).map((i) => {
            const idx = 1 + (i % Math.max(1, base.length - 2));
            return base.slice(0, idx) + base.slice(idx + 1);
          }),
        ),
      )
      .filter(
        (s) =>
          !ISSUE_STATE_TYPES.includes(s.trim().toLowerCase() as (typeof ISSUE_STATE_TYPES)[number]),
      );

    fc.assert(
      fc.property(mutatedStateType, (invalidType) => {
        assert.throws(
          () => normalizeIssue(validIssueInput({ state: { name: "Todo", type: invalidType } })),
          /stateType is required/,
        );
      }),
      { numRuns: 200 },
    );
  });

  test("null or missing state type throws", () => {
    fc.assert(
      fc.property(nonBlankString, (stateName) => {
        assert.throws(
          () => normalizeIssue(validIssueInput({ state: { name: stateName } })),
          /stateType is required/,
        );
      }),
      { numRuns: 200 },
    );
  });

  test("state_type field works as fallback when no nested state.type", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ISSUE_STATE_TYPES),
        fc.func(fc.boolean()),
        (stateType, caseFlip) => {
          const mixedCase = stateType
            .split("")
            .map((ch, i) => (caseFlip(i) ? ch.toUpperCase() : ch.toLowerCase()))
            .join("");
          const issue = normalizeIssue(validIssueInput({ state: "Todo", state_type: mixedCase }));
          assert.equal(issue.stateType, stateType);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("stateType camelCase field works as fallback", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ISSUE_STATE_TYPES),
        fc.func(fc.boolean()),
        (stateType, caseFlip) => {
          const mixedCase = stateType
            .split("")
            .map((ch, i) => (caseFlip(i) ? ch.toUpperCase() : ch.toLowerCase()))
            .join("");
          const issue = normalizeIssue(validIssueInput({ state: "Todo", stateType: mixedCase }));
          assert.equal(issue.stateType, stateType);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("state type resolution skips invalid snake_case before valid camelCase fallback", () => {
    const issue = normalizeIssue(
      validIssueInput({
        state: "Todo",
        state_type: 123,
        stateType: "started",
      }),
    );

    assert.equal(issue.stateType, "started");
  });
});

describe("INVARIANT: When an issue is normalized, it SHALL have all required fields populated.", () => {
  test("normalized issue always has id, identifier, title, state, stateType, labels, blockers", () => {
    fc.assert(
      fc.property(
        nonBlankString,
        nonBlankString,
        nonBlankString,
        nonBlankString,
        fc.constantFrom(...ISSUE_STATE_TYPES),
        (id, identifier, title, stateName, stateType) => {
          const issue = normalizeIssue({
            id,
            identifier,
            title,
            state: stateName,
            state_type: stateType,
          });
          assert.ok(typeof issue.id === "string" && issue.id.length > 0);
          assert.ok(typeof issue.identifier === "string" && issue.identifier.length > 0);
          assert.ok(typeof issue.title === "string" && issue.title.length > 0);
          assert.ok(typeof issue.state === "string" && issue.state.length > 0);
          assert.ok(typeof issue.stateType === "string");
          assert.ok(Array.isArray(issue.labels));
          assert.ok(Array.isArray(issue.blockers));
        },
      ),
      { numRuns: 200 },
    );
  });

  test("raw field preserves the original input object", () => {
    fc.assert(
      fc.property(
        nonBlankString,
        nonBlankString,
        nonBlankString,
        nonBlankString,
        (id, identifier, title, state) => {
          const input = { id, identifier, title, state, state_type: "unstarted" };
          const issue = normalizeIssue(input);
          assert.equal(issue.raw, input);
        },
      ),
      { numRuns: 200 },
    );
  });
});
