import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

// The published `@lorenz/tracker-sdk` (and its siblings) give an out-of-tree author
// the contract TYPES; the runtime contract is structural, so an extension that
// imports only types and stamps a literal `sdkVersion` builds to a plain object with
// no @lorenz import. These two tests pin both halves of that claim against the real
// SDK types: the example is a valid provider, and it compiles to zero @lorenz runtime
// dependencies.
const fixture = fileURLToPath(
  new URL("./fixtures/out-of-tree-extension/example-tracker.ts", import.meta.url),
);

test("an out-of-tree extension type-checks against the real @lorenz/tracker-sdk types", () => {
  const program = ts.createProgram([fixture], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  assert.deepEqual(diagnostics, []);
});

test("the example extension compiles to a zero-runtime-dependency module (no @lorenz import)", () => {
  const { outputText } = ts.transpileModule(readFileSync(fixture, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2023 },
  });
  assert.ok(
    !outputText.includes("@lorenz"),
    `emitted JS unexpectedly references @lorenz:\n${outputText}`,
  );
  // The runtime payload survives type erasure.
  assert.match(outputText, /createClient/);
  assert.match(outputText, /sdkVersion/);
});
