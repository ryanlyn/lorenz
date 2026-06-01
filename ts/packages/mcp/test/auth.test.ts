import { test } from "vitest";
import { issueMcpToken, revokeMcpToken, validMcpToken } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

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
