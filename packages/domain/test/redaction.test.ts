import { assert } from "@lorenz/test-utils";
import { test } from "vitest";

import { redactDiagnosticText, redactDiagnosticValue } from "@lorenz/domain";

test("redactDiagnosticValue redacts repeated references, not just the first occurrence", () => {
  // Mirrors the ACP approval shape: `selected` aliases an element of `request.options`.
  const option = { name: "run", command: "Bearer sk-live-alias-leak" };
  const update = { request: { options: [option] }, selected: option };

  const redacted = redactDiagnosticValue(update);

  assert.notMatch(JSON.stringify(redacted), /sk-live-alias-leak/);
  assert.equal(redacted.selected.command, "Bearer [REDACTED]");
  // Aliasing is preserved in the redacted graph rather than re-cloned per reference.
  assert.equal(redacted.selected, redacted.request.options[0]);
});

test("redactDiagnosticValue keeps cycles inside the redacted clone", () => {
  const node: { auth: string; self?: unknown } = { auth: "Bearer sk-live-cycle-leak" };
  node.self = node;

  const redacted = redactDiagnosticValue(node);

  assert.equal(redacted.auth, "Bearer [REDACTED]");
  // The cycle must point back at the redacted clone, not escape into the original graph.
  assert.equal(redacted.self, redacted);
  assert.notEqual(redacted, node);
});

test("redactDiagnosticText does not duplicate the closing quote of a quoted assignment", () => {
  assert.equal(redactDiagnosticText('{"token": "abc123"}'), '{"token": "[REDACTED]"}');
  assert.equal(redactDiagnosticText("password: 'hunter2'"), "password: '[REDACTED]'");
  assert.equal(redactDiagnosticText("token=abc123"), "token=[REDACTED]");
});

test("redacted quoted JSON assignments still parse as JSON", () => {
  const redacted = redactDiagnosticText('{"api_key": "sk-live-json-roundtrip", "keep": "x"}');
  assert.deepEqual(JSON.parse(redacted), { api_key: "[REDACTED]", keep: "x" });
});

test("redactDiagnosticValue copies an own __proto__ key instead of mutating the clone's prototype", () => {
  // JSON.parse produces "__proto__" as an ordinary own key; the clone must keep
  // it as an own property, not route it through the Object.prototype setter.
  const parsed = JSON.parse('{"__proto__": {"auth": "Bearer sk-live-proto-key"}, "keep": "x"}') as {
    keep: string;
  };

  const redacted = redactDiagnosticValue(parsed);

  assert.equal(Object.getPrototypeOf(redacted), Object.prototype);
  assert.equal(redacted.keep, "x");
  const proto = Object.getOwnPropertyDescriptor(redacted, "__proto__")?.value as
    | { auth: string }
    | undefined;
  assert.equal(proto?.auth, "Bearer [REDACTED]");
  assert.notMatch(JSON.stringify(redacted), /sk-live-proto-key/);
});
