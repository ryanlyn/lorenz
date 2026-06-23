import { test } from "vitest";
import { parseConfig } from "@lorenz/config";
import type { WorkerPoolSettings } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";

import { checkSlotsPerMachineGate } from "../src/gate.js";

// `checkSlotsPerMachineGate` is the PURE predicate behind the slots-per-machine
// co-residence safety gate. It returns an operator-facing error message when the
// settings would be unsafe (slotsPerMachine>1 without the per-run-claim-enforcement
// capability OR without the explicit co-residence opt-in) and `null` otherwise.
// The same predicate drives BOTH the daemon startup gate (which throws) and the
// runtime reload guard (which keeps last-good and emits workflow_reload_failed).

const capable = { perRunClaimEnforcement: true } as const;
const incapable = { perRunClaimEnforcement: false } as const;

function workerPoolSettings(
  workerPool: Record<string, unknown> | undefined,
): WorkerPoolSettings | undefined {
  return parseConfig(workerPool ? { worker: { worker_pool: workerPool } } : {}).worker.workerPool;
}

// Config cannot express a disabled pool (there is no `enabled` config key), but the reload-drain
// produces the INTERNAL disabled shape. Build it directly from a parsed enabled pool to cover the
// disabled-pool gate behavior.
function internallyDisabledPoolSettings(
  workerPool: Record<string, unknown>,
): WorkerPoolSettings {
  const parsed = workerPoolSettings(workerPool)!;
  return { ...parsed, enabled: false };
}

test("gate predicate: slotsPerMachine>1 with perRunClaimEnforcement=false returns the claim-enforcement message", () => {
  const settings = workerPoolSettings({
    driver: "fake",
    max_in_flight: 2,
    co_residence: true,
  });
  const message = checkSlotsPerMachineGate(settings, incapable);
  assert.ok(message);
  assert.match(message!, /per-run scoped claims|perRunClaimEnforcement/i);
});

test("gate predicate: slotsPerMachine>1 with perRunClaimEnforcement=true but coResidence absent returns the co-residence message", () => {
  const settings = workerPoolSettings({ driver: "fake", max_in_flight: 2 });
  assert.equal(settings?.coResidence, undefined);
  const message = checkSlotsPerMachineGate(settings, capable);
  assert.ok(message);
  assert.match(message!, /co.?residence/i);
});

test("gate predicate: slotsPerMachine>1 with perRunClaimEnforcement=true but coResidence=false returns the co-residence message", () => {
  const settings = workerPoolSettings({
    driver: "fake",
    max_in_flight: 2,
    co_residence: false,
  });
  const message = checkSlotsPerMachineGate(settings, capable);
  assert.ok(message);
  assert.match(message!, /co.?residence/i);
});

test("gate predicate: slotsPerMachine>1 with perRunClaimEnforcement AND coResidence returns null", () => {
  const settings = workerPoolSettings({
    driver: "fake",
    max_in_flight: 2,
    co_residence: true,
  });
  assert.equal(checkSlotsPerMachineGate(settings, capable), null);
});

test("gate predicate: an internally DISABLED pool with slotsPerMachine>1 returns null (dormant value, gate no-ops like an absent pool)", () => {
  // The reload-drain produces an internally disabled pool. A disabled pool cannot co-reside
  // anything: runs go static/local, so a dormant max_in_flight>1 must be ignored exactly like an
  // absent pool. Otherwise the startup gate hard-aborts the daemon over a value it never uses.
  const settings = internallyDisabledPoolSettings({ driver: "fake", max_in_flight: 2 });
  assert.equal(settings.enabled, false);
  assert.equal(settings.slotsPerMachine, 2);
  // No capability AND no opt-in: still null, because the pool is off entirely.
  assert.equal(checkSlotsPerMachineGate(settings, undefined), null);
  assert.equal(checkSlotsPerMachineGate(settings, incapable), null);
  assert.equal(checkSlotsPerMachineGate(settings, capable), null);
});

test("gate predicate: default slotsPerMachine=1 always returns null regardless of capability/opt-in", () => {
  const enabledDefault = workerPoolSettings({ driver: "fake" });
  assert.equal(enabledDefault?.slotsPerMachine, 1);
  assert.equal(checkSlotsPerMachineGate(enabledDefault, incapable), null);
  assert.equal(checkSlotsPerMachineGate(enabledDefault, capable), null);

  // An absent worker_pool defaults to the enabled `local` pool at slotsPerMachine=1, so the gate
  // predicate returns null (it only fires for slotsPerMachine>1) for any capability.
  const defaultPool = workerPoolSettings(undefined);
  assert.equal(defaultPool?.driver, "local");
  assert.equal(defaultPool?.slotsPerMachine, 1);
  assert.equal(checkSlotsPerMachineGate(defaultPool, undefined), null);
  assert.equal(checkSlotsPerMachineGate(defaultPool, capable), null);
});

test("ssh_hosts fold-in passes the gate: auto co_residence + perRunClaimEnforcement keeps the >1 fleet safe", () => {
  // ssh_hosts folds into a static-ssh pool at slotsPerMachine = the per-host cap (default 10) and
  // auto-enables co_residence. The startup gate therefore PASSES for a claim-enforcing coordinator
  // (the daemon wires the concrete per-run manager) and FAILS loud for an incapable one.
  const folded = parseConfig({
    worker: { ssh_hosts: ["user@a:22", "user@b:22"] },
  }).worker.workerPool;
  assert.equal(folded?.slotsPerMachine, 10);
  assert.equal(folded?.coResidence, true);
  assert.equal(checkSlotsPerMachineGate(folded, capable), null);
  const message = checkSlotsPerMachineGate(folded, incapable);
  assert.ok(message);
  assert.match(message!, /per-run scoped claims|perRunClaimEnforcement/i);
});
