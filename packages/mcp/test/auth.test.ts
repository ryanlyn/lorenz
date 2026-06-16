import { test } from "vitest";
import { issueMcpToken, revokeMcpToken, validMcpToken } from "@lorenz/cli";
import { parseConfig } from "@lorenz/config";
import { assert } from "@lorenz/test-utils";

import { mcpAuthScopeForSettings } from "@lorenz/mcp";

test("issueMcpToken — returns a unique, non-empty cryptographically strong string", () => {
  const tokens: string[] = [];
  try {
    const token = issueMcpToken();
    tokens.push(token);
    assert.ok(token.length > 0);
    assert.equal(typeof token, "string");

    const second = issueMcpToken();
    tokens.push(second);
    assert.notEqual(token, second);

    // base64url: no +, /, or = characters
    assert.notMatch(token, /[+/=]/);
  } finally {
    for (const t of tokens) revokeMcpToken(t);
  }
});

test("validMcpToken — returns true for actively issued tokens", () => {
  const token = issueMcpToken();
  try {
    assert.equal(validMcpToken(token), true);
  } finally {
    revokeMcpToken(token);
  }
});

test("validMcpToken — returns false when scope does not match", () => {
  const token = issueMcpToken("scope-a");
  try {
    assert.equal(validMcpToken(token, "scope-a"), true);
    assert.equal(validMcpToken(token, "scope-b"), false);
  } finally {
    revokeMcpToken(token);
  }
});

test("validMcpToken — returns false for random/fake tokens", () => {
  assert.equal(validMcpToken("not-a-real-token"), false);
  assert.equal(validMcpToken(""), false);
  assert.equal(validMcpToken(null), false);
  assert.equal(validMcpToken(undefined), false);
});

test("revokeMcpToken — revoking a token causes validMcpToken to return false", () => {
  const token = issueMcpToken();
  try {
    assert.equal(validMcpToken(token), true);
    revokeMcpToken(token);
    assert.equal(validMcpToken(token), false);
  } finally {
    // Ensure cleanup even if assertion before revoke fails
    revokeMcpToken(token);
  }
});

test("mcpAuthScopeForSettings — tool options change the server identity, key order does not", () => {
  const scope = (raw: Record<string, unknown>): string =>
    mcpAuthScopeForSettings(parseConfig(raw), "127.0.0.1", 4040);

  const base = {
    tracker: { kind: "dispatch" },
    trackers: { dispatch: { provider: "linear", project_slug: "mono" } },
  };
  const withOptions = {
    ...base,
    tools: { linear: { api_key: "linear-token", endpoint: "https://linear.example" } },
  };

  // Mounted pack behavior depends on tool options, so the identity must too.
  assert.notEqual(scope(base), scope(withOptions));
  assert.notEqual(
    scope(withOptions),
    scope({ ...base, tools: { linear: { api_key: "other-token" } } }),
  );

  // Equivalent configs hash identically regardless of key order.
  const reordered = {
    ...base,
    tools: { linear: { endpoint: "https://linear.example", api_key: "linear-token" } },
  };
  assert.equal(scope(withOptions), scope(reordered));
  assert.equal(
    scope({ ...base, tools: { linear: { endpoint: "https://linear.example", api_key: "k" } } }),
    scope({ ...base, tools: { linear: { api_key: "k", endpoint: "https://linear.example" } } }),
  );
});

test("revokeMcpToken — calling revoke twice or with invalid inputs is a safe no-op", () => {
  const token = issueMcpToken();
  try {
    revokeMcpToken(token);
    revokeMcpToken(token);
    revokeMcpToken(null);
    revokeMcpToken(undefined);
    revokeMcpToken("nonexistent-token");
    assert.equal(validMcpToken(token), false);
  } finally {
    revokeMcpToken(token);
  }
});
