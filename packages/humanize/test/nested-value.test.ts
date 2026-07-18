import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { arrayAt, stringAt } from "@lorenz/humanize";

test("shared nested-value helpers read matching values", () => {
  const value = {
    nested: {
      items: ["first", { second: true }],
      label: "ready",
    },
  };

  assert.deepEqual(arrayAt(value, ["nested", "items"]), ["first", { second: true }]);
  assert.equal(stringAt(value, ["nested", "label"]), "ready");
});

test("shared nested-value helpers reject malformed paths without throwing", () => {
  const malformedValues: unknown[] = [
    null,
    undefined,
    "text",
    42,
    [],
    { nested: null },
    { nested: [] },
    { nested: { label: 42 } },
  ];

  for (const value of malformedValues) {
    assert.equal(arrayAt(value, ["nested", "items"]), null);
    assert.equal(stringAt(value, ["nested", "label"]), null);
  }
});

test("stringAt rejects empty nested strings without changing their value", () => {
  assert.equal(stringAt({ nested: { label: "" } }, ["nested", "label"]), null);
  assert.equal(stringAt({ nested: { label: "   " } }, ["nested", "label"]), null);
  assert.equal(stringAt({ nested: { label: " ready " } }, ["nested", "label"]), " ready ");
});
