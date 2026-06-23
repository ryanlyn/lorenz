import { describe, expect, test } from "vitest";

import { WorkerDriverRegistry } from "../src/registry.js";
import { runDriverConformanceSuite } from "../src/conformance.js";
import {
  LocalWorkerDriver,
  localWorkerDriverFactory,
  registerLocalWorkerDriver,
} from "../src/local.js";
import type { DriverDeps, ProvisionRequest } from "../src/types.js";

// A deterministic clock so `createdAtMs` is reproducible. The local driver owns
// no timers (it never reaches out over the network), so set/clear are inert.
function fixedClock(initial: Date): DriverDeps["clock"] {
  return {
    now: () => initial,
    setTimeout: () => ({ unref: undefined }),
    clearTimeout: () => undefined,
  };
}

// A runSsh that FAILS the test if it is ever called. The local driver must
// never touch SSH (there is no remote machine), so any invocation is a bug.
function forbiddenSsh(): DriverDeps["runSsh"] {
  return () => {
    throw new Error("local driver must never call runSsh");
  };
}

function makeDeps(): DriverDeps {
  return {
    clock: fixedClock(new Date("2026-06-20T10:00:00.000Z")),
    logEvent: () => undefined,
    runSsh: forbiddenSsh(),
  };
}

function provisionRequest(workerId: string): ProvisionRequest {
  return { workerId, labels: ["lorenz.worker-pool"], timeoutMs: 30_000 };
}

// ---------------------------------------------------------------------------
// Conformance suite: the local driver satisfies the shared WorkerDriver
// contract (idempotent provision/destroy, list reflects provisioned-minus-
// destroyed). `makeUnreachable` is omitted because the local driver cannot
// represent a created-but-unreachable worker (there is no remote machine to be
// unreachable); the suite skips the probe-gating case for such drivers.
// ---------------------------------------------------------------------------
runDriverConformanceSuite(() => new LocalWorkerDriver(makeDeps()), {
  suiteName: "LocalWorkerDriver",
  workerIds: ["worker-a", "worker-b"],
  makeProvisionRequest: provisionRequest,
});

describe("LocalWorkerDriver local-execution semantics", () => {
  test("every provisioned worker has an EMPTY workerHost (local execution, no tunnel)", async () => {
    const driver = new LocalWorkerDriver(makeDeps());

    const a = await driver.provision(provisionRequest("worker-a"));
    const b = await driver.provision(provisionRequest("worker-b"));

    // The empty host is the load-bearing contract: downstream wiring mints no
    // tunnel / MCP lease and acp keeps its own in-process endpoint.
    expect(a.workerHost).toBe("");
    expect(b.workerHost).toBe("");
    for (const worker of await driver.list()) {
      expect(worker.workerHost).toBe("");
    }
  });

  test("driverRef is distinct per workerId even though every host is empty", async () => {
    const driver = new LocalWorkerDriver(makeDeps());

    const a = await driver.provision(provisionRequest("worker-a"));
    const b = await driver.provision(provisionRequest("worker-b"));

    // Hosts collapse (both empty) but the per-worker ref stays distinct so
    // destroy/list/reconcile key per-worker.
    expect(a.driverRef).toBe("local://worker-a");
    expect(b.driverRef).toBe("local://worker-b");
    expect(a.driverRef).not.toBe(b.driverRef);
  });

  test("probe reports ok WITHOUT ever calling runSsh", async () => {
    // makeDeps injects a runSsh that throws if called. A healthy probe here
    // proves the local driver decides health purely in-memory.
    const driver = new LocalWorkerDriver(makeDeps());
    const worker = await driver.provision(provisionRequest("worker-a"));

    const health = await driver.probe(worker, { timeoutMs: 5_000 });
    expect(health.ok).toBe(true);
  });

  test("probe of an unknown/destroyed worker reports ok:false (still no SSH)", async () => {
    const driver = new LocalWorkerDriver(makeDeps());
    const worker = await driver.provision(provisionRequest("worker-a"));
    await driver.destroy(worker, { timeoutMs: 5_000, reason: "idle" });

    const health = await driver.probe(worker, { timeoutMs: 5_000 });
    expect(health.ok).toBe(false);
    if (!health.ok) {
      expect(health.reason).toBe("local_worker_not_found");
    }
  });

  test("createdAtMs is stamped deterministically from the injected clock", async () => {
    const driver = new LocalWorkerDriver(makeDeps());
    const worker = await driver.provision(provisionRequest("worker-a"));
    expect(worker.createdAtMs).toBe(new Date("2026-06-20T10:00:00.000Z").getTime());
  });

  test("capabilities mark a non-ssh, non-ephemeral, ledger-free backend", () => {
    const driver = new LocalWorkerDriver(makeDeps());
    expect(driver.capabilities).toEqual({
      sshAddressable: false,
      ephemeral: false,
      usesLedger: false,
    });
  });
});

describe("registerLocalWorkerDriver", () => {
  test("registers the local factory and is idempotent", () => {
    const registry = new WorkerDriverRegistry();
    registerLocalWorkerDriver({ workerDrivers: registry });

    expect(registry.get("local")).toBe(localWorkerDriverFactory);
    expect(registry.kinds()).toContain("local");

    // A second registration is a no-op (does not throw on the existing kind).
    registerLocalWorkerDriver({ workerDrivers: registry });
    expect(registry.get("local")).toBe(localWorkerDriverFactory);
  });

  test("the factory constructs a LocalWorkerDriver", () => {
    const driver = localWorkerDriverFactory.create({}, makeDeps());
    expect(driver).toBeInstanceOf(LocalWorkerDriver);
    expect(driver.kind).toBe("local");
  });
});
