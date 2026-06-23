import { test } from "vitest";
import type { Settings } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";

import { createNullEndpointManager, nullEndpointManager } from "../src/nullEndpointManager.js";
import type { McpEndpointManager } from "../src/types.js";

// A minimal `Settings`-typed stub: `open` never reads it (the null manager mints
// nothing), so an empty object cast is enough to exercise the call signature
// without dragging in a full config fixture.
const settingsStub = {} as Settings;

test("null manager advertises perRunClaimEnforcement=false (the passthrough capability)", () => {
  // perRunClaimEnforcement is the capability the startup gate consumes; the null
  // manager reports `false` so acp keeps owning its own endpoint (byte-identical)
  // and slotsPerMachine>1 stays gated off.
  assert.equal(nullEndpointManager.perRunClaimEnforcement, false);
});

test("null manager satisfies the McpEndpointManager port shape", () => {
  // Assigning to the port type proves the structural contract at compile time;
  // the runtime checks back it up so a refactor that drops a method fails here.
  const manager: McpEndpointManager = nullEndpointManager;
  assert.equal(typeof manager.open, "function");
  assert.equal(typeof manager.release, "function");
  assert.equal(typeof manager.perRunClaimEnforcement, "boolean");
});

test("open() resolves to null for any request (no per-run endpoint minted)", async () => {
  const minted = await nullEndpointManager.open({
    settings: settingsStub,
    workerHost: "ssh://worker-1",
    runKey: "0",
  });
  assert.equal(minted, null);
});

test("open() returns null regardless of the request (host/runKey ignored)", async () => {
  const a = await nullEndpointManager.open({
    settings: settingsStub,
    workerHost: "ssh://worker-a",
    runKey: "1",
  });
  const b = await nullEndpointManager.open({
    settings: settingsStub,
    workerHost: "ssh://worker-b",
    runKey: "2",
  });
  assert.equal(a, null);
  assert.equal(b, null);
});

test("release(null) is a no-op that resolves without throwing", async () => {
  // The null manager never holds a lease, so releasing null must be a clean
  // resolve (the RunSlot settle path calls release uniformly, lease or not).
  await nullEndpointManager.release(null);
  // No assertion needed beyond the awaited resolve; reaching here is the pass.
  assert.ok(true);
});

test("release is idempotent: multiple null releases all no-op", async () => {
  await nullEndpointManager.release(null);
  await nullEndpointManager.release(null);
  await nullEndpointManager.release(null);
  assert.ok(true);
});

test("createNullEndpointManager() returns a manager with the same null contract", async () => {
  const manager = createNullEndpointManager();
  assert.equal(manager.perRunClaimEnforcement, false);
  const minted = await manager.open({
    settings: settingsStub,
    workerHost: "ssh://worker-1",
    runKey: "0",
  });
  assert.equal(minted, null);
  await manager.release(null);
  assert.ok(true);
});

test("the shared null manager is frozen (stateless singleton cannot be mutated)", () => {
  // It holds no state, so sharing one frozen instance is safe; freezing makes
  // an accidental `perRunClaimEnforcement = true` flip a loud TypeError, not a silent
  // capability escalation that would unlock the slotsPerMachine>1 gate.
  assert.equal(Object.isFrozen(nullEndpointManager), true);
});
