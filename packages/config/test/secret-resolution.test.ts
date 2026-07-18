import fs from "node:fs/promises";
import path from "node:path";

import { test } from "vitest";
import { redactDiagnosticText } from "@lorenz/domain";
import { assert, tempDir, writeExecutable } from "@lorenz/test-utils";

import { resolveConfiguredSecret } from "../src/secret-resolution.js";

test("1Password resolution is bounded, environment-restricted, and registered for redaction", async () => {
  const root = await tempDir("lorenz-secret-resolution");
  const opScript = path.join(root, "op");
  const envCapture = path.join(root, "op.env");
  const resolvedSecret = "module-secret-sentinel-524";
  const oldParentSecret = process.env.LORENZ_PARENT_SECRET_SENTINEL;
  process.env.LORENZ_PARENT_SECRET_SENTINEL = "parent-secret-should-not-reach-op";
  await writeExecutable(
    opScript,
    ["#!/bin/sh", 'env > "$OP_ENV_CAPTURE"', `echo "${resolvedSecret}"`, ""].join("\n"),
  );

  try {
    const result = resolveConfiguredSecret("op://vault/item/field", {
      PATH: `${root}:${process.env.PATH}`,
      OP_ENV_CAPTURE: envCapture,
      LINEAR_API_KEY: "linear-secret-should-not-reach-op",
      LORENZ_SECRET_RESOLUTION_TIMEOUT_MS: "2000",
    });

    assert.equal(result, resolvedSecret);
    const childEnv = await fs.readFile(envCapture, "utf8");
    assert.equal(childEnv.includes("OP_ENV_CAPTURE="), true);
    assert.equal(childEnv.includes("LORENZ_PARENT_SECRET_SENTINEL="), false);
    assert.equal(childEnv.includes("parent-secret-should-not-reach-op"), false);
    assert.equal(childEnv.includes("LINEAR_API_KEY="), false);
    assert.equal(childEnv.includes("linear-secret-should-not-reach-op"), false);
    assert.equal(
      redactDiagnosticText(`resolved value ${resolvedSecret}`),
      "resolved value [REDACTED]",
    );
  } finally {
    if (oldParentSecret === undefined) delete process.env.LORENZ_PARENT_SECRET_SENTINEL;
    else process.env.LORENZ_PARENT_SECRET_SENTINEL = oldParentSecret;
  }
});

test("1Password timeout errors retain the redacted public contract", async () => {
  const root = await tempDir("lorenz-secret-timeout");
  const opScript = path.join(root, "op");
  await writeExecutable(
    opScript,
    ["#!/bin/sh", "sleep 2", 'echo "resolved-secret-sentinel"', ""].join("\n"),
  );

  assert.throws(
    () =>
      resolveConfiguredSecret("op://vault/item/field", {
        PATH: `${root}:${process.env.PATH}`,
        LORENZ_SECRET_RESOLUTION_TIMEOUT_MS: "100",
      }),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const cause = error instanceof Error ? error.cause : undefined;
      assert.match(message, /Timed out resolving 1Password reference after 100ms/);
      assert.notMatch(message, /op:\/\/vault\/item\/field/);
      assert.notMatch(message, /resolved-secret-sentinel/);
      assert.equal(cause, undefined);
      return true;
    },
  );
});

test("1Password provider failures do not retain provider output or the reference", async () => {
  const root = await tempDir("lorenz-secret-failure");
  const opScript = path.join(root, "op");
  await writeExecutable(
    opScript,
    [
      "#!/bin/sh",
      'echo "failed op://vault/item/field with resolved-secret-sentinel" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );

  assert.throws(
    () =>
      resolveConfiguredSecret("op://vault/item/field", {
        PATH: `${root}:${process.env.PATH}`,
      }),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const cause = error instanceof Error ? error.cause : undefined;
      assert.equal(
        message,
        "Failed to resolve 1Password reference; check the redacted op:// reference, vault access, and 1Password sign-in.",
      );
      assert.notMatch(message, /op:\/\/vault\/item\/field/);
      assert.notMatch(message, /resolved-secret-sentinel/);
      assert.equal(cause, undefined);
      return true;
    },
  );
});

test("environment references preserve provider fallback behavior", () => {
  assert.equal(
    resolveConfiguredSecret(
      "$EMPTY_TOKEN",
      { EMPTY_TOKEN: "", PROVIDER_TOKEN: "fallback-token" },
      { fallbackEnvName: "PROVIDER_TOKEN" },
    ),
    "fallback-token",
  );
  assert.equal(
    resolveConfiguredSecret(
      undefined,
      { PROVIDER_TOKEN: "fallback-token" },
      {
        fallbackEnvName: "PROVIDER_TOKEN",
      },
    ),
    "fallback-token",
  );
  assert.equal(resolveConfiguredSecret("literal-token", {}), "literal-token");
});

test("explicit registration covers non-provider secrets", () => {
  const resolvedSecret = "explicit-secret-sentinel-524";
  assert.equal(
    resolveConfiguredSecret("$PACK_TOKEN", { PACK_TOKEN: resolvedSecret }, { register: true }),
    resolvedSecret,
  );
  assert.equal(
    redactDiagnosticText(`resolved value ${resolvedSecret}`),
    "resolved value [REDACTED]",
  );
});
