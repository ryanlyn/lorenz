import { test } from "vitest";
import { parseConfig } from "@symphony/config";
import type { WorkerPoolSettings } from "@symphony/domain";
import { assert } from "@symphony/test-utils";

import { checkSlotsPerMachineGate } from "../src/gate.js";

// `checkSlotsPerMachineGate` is the PURE predicate behind the slots-per-machine
// co-residence safety gate. It returns an operator-facing error message when the
// settings would be unsafe (slotsPerMachine>1 without the per-run-endpoint
// capability OR without the explicit co-residence opt-in) and `null` otherwise.
// The same predicate drives BOTH the daemon startup gate (which throws) and the
// runtime reload guard (which keeps last-good and emits workflow_reload_failed).

const capable = { perRunEndpoint: true } as const;
const incapable = { perRunEndpoint: false } as const;

function workerPoolSettings(
  workerPool: Record<string, unknown> | undefined,
): WorkerPoolSettings | undefined {
  return parseConfig(workerPool ? { worker: { worker_pool: workerPool } } : {}).worker.workerPool;
}

test("gate predicate: slotsPerMachine>1 with perRunEndpoint=false returns the endpoint message", () => {
  const settings = workerPoolSettings({
    enabled: true,
    driver: "fake",
    max_in_flight: 2,
    co_residence: true,
  });
  const message = checkSlotsPerMachineGate(settings, incapable);
  assert.ok(message);
  assert.match(message!, /per-run.*endpoint|perRunEndpoint/i);
});

test("gate predicate: slotsPerMachine>1 with perRunEndpoint=true but coResidence absent returns the co-residence message", () => {
  const settings = workerPoolSettings({ enabled: true, driver: "fake", max_in_flight: 2 });
  assert.equal(settings?.coResidence, undefined);
  const message = checkSlotsPerMachineGate(settings, capable);
  assert.ok(message);
  assert.match(message!, /co.?residence/i);
});

test("gate predicate: slotsPerMachine>1 with perRunEndpoint=true but coResidence=false returns the co-residence message", () => {
  const settings = workerPoolSettings({
    enabled: true,
    driver: "fake",
    max_in_flight: 2,
    co_residence: false,
  });
  const message = checkSlotsPerMachineGate(settings, capable);
  assert.ok(message);
  assert.match(message!, /co.?residence/i);
});

test("gate predicate: slotsPerMachine>1 with perRunEndpoint AND coResidence returns null", () => {
  const settings = workerPoolSettings({
    enabled: true,
    driver: "fake",
    max_in_flight: 2,
    co_residence: true,
  });
  assert.equal(checkSlotsPerMachineGate(settings, capable), null);
});

test("gate predicate: DISABLED pool with slotsPerMachine>1 returns null (dormant value, gate no-ops like an absent pool)", () => {
  // A disabled pool cannot co-reside anything: runs go static/local, so a dormant
  // max_in_flight>1 must be ignored exactly like an absent pool. Otherwise the
  // startup gate hard-aborts the daemon over a value the disabled pool never uses.
  const settings = workerPoolSettings({ enabled: false, driver: "fake", max_in_flight: 2 });
  assert.equal(settings?.enabled, false);
  assert.equal(settings?.slotsPerMachine, 2);
  // No capability AND no opt-in: still null, because the pool is off entirely.
  assert.equal(checkSlotsPerMachineGate(settings, undefined), null);
  assert.equal(checkSlotsPerMachineGate(settings, incapable), null);
  assert.equal(checkSlotsPerMachineGate(settings, capable), null);
});

test("gate predicate: default slotsPerMachine=1 always returns null regardless of capability/opt-in", () => {
  const enabledDefault = workerPoolSettings({ enabled: true, driver: "fake" });
  assert.equal(enabledDefault?.slotsPerMachine, 1);
  assert.equal(checkSlotsPerMachineGate(enabledDefault, incapable), null);
  assert.equal(checkSlotsPerMachineGate(enabledDefault, capable), null);

  // Absent worker_pool / absent capabilities: byte-identical no-op (null).
  const noPool = workerPoolSettings(undefined);
  assert.equal(noPool, undefined);
  assert.equal(checkSlotsPerMachineGate(noPool, undefined), null);
  assert.equal(checkSlotsPerMachineGate(noPool, capable), null);
});
