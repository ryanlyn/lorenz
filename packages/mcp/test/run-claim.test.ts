import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import {
  checkRunClaim,
  issueRunMcpToken,
  resolveRunClaim,
  revokeRunClaim,
  type RunClaim,
} from "@lorenz/mcp";

const baseClaim = (overrides: Partial<RunClaim> = {}): RunClaim => ({
  runKey: "run-1",
  workerHost: "host-a",
  issueId: "ISSUE-1",
  generation: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
  settingsScope: "mcp:scope-a",
  ...overrides,
});

const live = () => true;

test("issueRunMcpToken - mints a unique opaque base64url token with no scope in the bytes", () => {
  const tokens: string[] = [];
  try {
    const first = issueRunMcpToken(baseClaim());
    tokens.push(first);
    const second = issueRunMcpToken(baseClaim());
    tokens.push(second);

    assert.ok(first.length > 0);
    assert.notEqual(first, second);
    // base64url: no +, /, or = characters - the token carries no claim payload.
    assert.notMatch(first, /[+/=]/);
  } finally {
    for (const t of tokens) revokeRunClaim(t);
  }
});

test("resolveRunClaim - is the only source of runKey; resolves server-side from the opaque token", () => {
  const claim = baseClaim({ runKey: "run-server-side" });
  const token = issueRunMcpToken(claim);
  try {
    const resolved = resolveRunClaim(token);
    assert.ok(resolved);
    assert.equal(resolved?.runKey, "run-server-side");
    assert.equal(resolved?.workerHost, "host-a");
  } finally {
    revokeRunClaim(token);
  }
});

test("resolveRunClaim - returns undefined for unknown, empty, null, and undefined tokens", () => {
  assert.equal(resolveRunClaim("not-a-real-token"), undefined);
  assert.equal(resolveRunClaim(""), undefined);
  assert.equal(resolveRunClaim(null), undefined);
  assert.equal(resolveRunClaim(undefined), undefined);
});

test("revokeRunClaim - drops the claim so resolveRunClaim fails closed; double/invalid revoke is safe", () => {
  const token = issueRunMcpToken(baseClaim());
  try {
    assert.ok(resolveRunClaim(token));
    revokeRunClaim(token);
    assert.equal(resolveRunClaim(token), undefined);
    // Safe no-ops.
    revokeRunClaim(token);
    revokeRunClaim(null);
    revokeRunClaim(undefined);
    revokeRunClaim("nonexistent");
  } finally {
    revokeRunClaim(token);
  }
});

test("checkRunClaim - passes when not expired, tool allowed, and the run is live", () => {
  const claim = baseClaim({ allowedTools: ["search", "comment"] });
  const decision = checkRunClaim(claim, { toolName: "search", isRunLive: live });
  assert.equal(decision.ok, true);
  if (decision.ok) assert.equal(decision.claim.runKey, "run-1");
});

test("checkRunClaim - expiry is checked first and denies even a live, allowed tool", () => {
  const claim = baseClaim({ expiresAt: 1_000, allowedTools: ["search"] });
  const decision = checkRunClaim(claim, {
    toolName: "search",
    isRunLive: live,
    now: () => 2_000,
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.reason, "expired");
});

test("checkRunClaim - allowlist is checked before liveness; a disallowed tool denies", () => {
  const claim = baseClaim({ allowedTools: ["search"] });
  // Liveness would pass, but the tool is not allowed and that is checked first.
  const decision = checkRunClaim(claim, { toolName: "delete", isRunLive: live });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.reason, "tool-not-allowed");
});

test("checkRunClaim - undefined allowedTools permits any tool name", () => {
  const claim = baseClaim({ allowedTools: undefined });
  const decision = checkRunClaim(claim, { toolName: "anything", isRunLive: live });
  assert.equal(decision.ok, true);
});

test("checkRunClaim - a non-tool request (no toolName) skips the allowlist", () => {
  const claim = baseClaim({ allowedTools: ["search"] });
  const decision = checkRunClaim(claim, { isRunLive: live });
  assert.equal(decision.ok, true);
});

test("checkRunClaim - fails closed when the run is not live", () => {
  const claim = baseClaim();
  const decision = checkRunClaim(claim, { isRunLive: () => false });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.reason, "not-live");
});

test("checkRunClaim - liveness oracle receives runKey, workerHost, and generation from the claim", () => {
  const claim = baseClaim({ runKey: "run-9", workerHost: "host-z", generation: 7 });
  let seen: [string, string, number] | null = null;
  checkRunClaim(claim, {
    isRunLive: (runKey, workerHost, generation) => {
      seen = [runKey, workerHost, generation];
      return true;
    },
  });
  assert.deepEqual(seen, ["run-9", "host-z", 7]);
});

test("checkRunClaim - a stale generation denies via the liveness fence", () => {
  const claim = baseClaim({ generation: 1 });
  // Oracle accepts only the current generation (2); the claim's generation is stale.
  const decision = checkRunClaim(claim, {
    isRunLive: (_runKey, _host, generation) => generation === 2,
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.reason, "not-live");
});
