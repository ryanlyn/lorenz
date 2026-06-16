import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import {
  applyQuery,
  matchesFilter,
  parseFilter,
  parseQuerySpec,
  pickFields,
} from "@lorenz/tool-sdk";

test("predicates: eq, ne, in, nin, exists, and numeric comparisons", () => {
  const r = { state: "Todo", n: 3, labels: ["backend", "urgent"] };
  assert.equal(matchesFilter(r, parseFilter({ field: "state", op: "eq", value: "Todo" })), true);
  assert.equal(matchesFilter(r, parseFilter({ field: "state", op: "ne", value: "Todo" })), false);
  assert.equal(
    matchesFilter(r, parseFilter({ field: "state", op: "in", value: ["Done", "Todo"] })),
    true,
  );
  assert.equal(matchesFilter(r, parseFilter({ field: "state", op: "nin", value: ["Done"] })), true);
  assert.equal(matchesFilter(r, parseFilter({ field: "n", op: "gte", value: 3 })), true);
  assert.equal(matchesFilter(r, parseFilter({ field: "n", op: "lt", value: 3 })), false);
  assert.equal(matchesFilter(r, parseFilter({ field: "state", op: "exists", value: true })), true);
});

test("contains matches substrings (ci) and array elements", () => {
  const r = { title: "Deploy v2", labels: ["backend"] };
  assert.equal(
    matchesFilter(r, parseFilter({ field: "title", op: "contains", value: "deploy", ci: true })),
    true,
  );
  // Case-sensitive by default, so lower-case "deploy" does not match "Deploy".
  assert.equal(
    matchesFilter(r, parseFilter({ field: "title", op: "contains", value: "deploy" })),
    false,
  );
  // contains over an array tests each element as a substring.
  assert.equal(
    matchesFilter(r, parseFilter({ field: "labels", op: "contains", value: "back" })),
    true,
  );
});

test("an absent field matches nothing except exists:false", () => {
  const r = { a: 1 };
  assert.equal(matchesFilter(r, parseFilter({ field: "z", op: "eq", value: 1 })), false);
  assert.equal(matchesFilter(r, parseFilter({ field: "z", op: "ne", value: 1 })), false);
  assert.equal(matchesFilter(r, parseFilter({ field: "z", op: "exists", value: false })), true);
  assert.equal(matchesFilter(r, parseFilter({ field: "z", op: "exists", value: true })), false);
});

test("and / or / not combine predicates", () => {
  const r = { state: "Todo", labels: ["backend"] };
  const f = parseFilter({
    and: [
      { field: "state", op: "eq", value: "Todo" },
      {
        or: [
          { field: "labels", op: "contains", value: "frontend" },
          { not: { field: "labels", op: "contains", value: "frontend" } },
        ],
      },
    ],
  });
  assert.equal(matchesFilter(r, f), true);
});

test("parseFilter rejects malformed and over-deep filters", () => {
  assert.throws(() => parseFilter({ field: "x", op: "bogus", value: 1 }), /unknown op/);
  assert.throws(() => parseFilter({ field: "x" }), /'op'/);
  assert.throws(() => parseFilter({ and: [] }), /non-empty/);
  assert.throws(() => parseFilter({ field: "x", op: "in", value: "notarray" }), /array of scalars/);
  assert.throws(() => parseFilter({ and: [{}], or: [{}] }), /exactly one/);
  // A filter nested deeper than the depth bound is rejected (defends against a hostile filter).
  let deep: unknown = { field: "x", op: "eq", value: 1 };
  for (let i = 0; i < 20; i++) deep = { not: deep };
  assert.throws(() => parseFilter(deep), /nesting exceeds/);
});

test("parseQuerySpec clamps limit and validates offset and order_by", () => {
  const spec = parseQuerySpec({
    limit: 99999,
    offset: 2,
    order_by: [{ field: "title", dir: "desc" }],
  });
  assert.equal(spec.limit, 1000);
  assert.equal(spec.offset, 2);
  assert.deepEqual(spec.orderBy, [{ field: "title", dir: "desc" }]);
  assert.throws(() => parseQuerySpec({ limit: 0 }), /positive integer/);
  assert.throws(() => parseQuerySpec({ offset: -1 }), /non-negative/);
  assert.throws(() => parseQuerySpec({ order_by: [{ field: "t", dir: "up" }] }), /asc.*desc/);
});

test("applyQuery filters, sorts, pages, and reports the pre-page total", () => {
  const records = [
    { id: "a", n: 3 },
    { id: "b", n: 1 },
    { id: "c", n: 2 },
    { id: "d", n: 5 },
  ];
  const { rows, total } = applyQuery(
    records,
    parseQuerySpec({
      where: { field: "n", op: "gte", value: 2 },
      order_by: [{ field: "n", dir: "asc" }],
      limit: 2,
      offset: 1,
    }),
  );
  // n>=2 keeps a(3), c(2), d(5); total is the pre-page count.
  assert.equal(total, 3);
  // Sorted ascending by n: c(2), a(3), d(5); offset 1 + limit 2 -> a, d.
  assert.deepEqual(
    rows.map((r) => r.id),
    ["a", "d"],
  );
});

test("pickFields keeps only the present requested fields", () => {
  assert.deepEqual(pickFields({ a: 1, b: 2, c: 3 }, ["a", "c", "z"]), { a: 1, c: 3 });
});
