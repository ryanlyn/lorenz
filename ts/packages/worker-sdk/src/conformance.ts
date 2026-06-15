import { describe, expect, test } from "vitest";

import { POOL_OWNED_LABEL } from "./types.js";
import type { WorkerDescriptor, WorkerDriver, ProvisionRequest } from "./types.js";

/**
 * Shared, parameterized test body that asserts the {@link WorkerDriver} contract.
 *
 * This module deliberately lives under `src/` (not `test/`) so it compiles to
 * `dist/` and can be imported by every driver's own test file (fake,
 * static-ssh, and each cloud driver behind its own gate). It registers its own
 * `describe`/`test` blocks, so a caller simply invokes it at the top level of a
 * test file:
 *
 * ```ts
 * runDriverConformanceSuite(() => new FakeWorkerDriver(deps), {
 *   suiteName: "FakeWorkerDriver",
 *   workerIds: ["worker-a", "worker-b"],
 *   makeUnreachable: () => ({ driver, workerId: "worker-down" }),
 * });
 * ```
 *
 * The contract asserted here is intentionally minimal and driver-agnostic:
 *   1. `provision` is idempotent on `workerId` (same id -> same worker).
 *   2. `destroy` is idempotent and tolerant of an already-gone worker.
 *   3. `list()` reflects provisioned-minus-destroyed.
 *   4. `probe` gates a created-but-unreachable worker to `{ ok: false }`.
 */

/** Options that tailor the shared suite to a specific driver backend. */
export interface ConformanceSuiteOptions {
  /** Label for the `describe` block (e.g. the driver class name). */
  suiteName?: string;
  /**
   * Two distinct, driver-acceptable worker ids. For fixed-inventory drivers
   * (static-ssh, `min==max==len`) these must map onto real configured hosts.
   */
  workerIds: readonly [string, string];
  /** Timeout passed to `provision` (defaults to 30s). */
  provisionTimeoutMs?: number;
  /** Timeout passed to `probe` (defaults to 30s). */
  probeTimeoutMs?: number;
  /** Timeout passed to `destroy` (defaults to 30s). */
  destroyTimeoutMs?: number;
  /**
   * Builds a {@link ProvisionRequest} for a given worker id. Lets a driver supply
   * its own `labels`/`driverOptions`. Defaults to a minimal request with a
   * single `lorenz.worker-pool` label and the configured `provisionTimeoutMs`.
   */
  makeProvisionRequest?: (workerId: string) => ProvisionRequest;
  /**
   * Yields a driver plus a worker id that is created-but-unreachable, so the
   * suite can assert `probe` returns `{ ok: false }`. Optional: a driver that
   * cannot represent an unreachable-but-created worker omits this and the probe
   * gating case is skipped. Both built-in drivers supply it (fake via failure
   * injection, static-ssh via an unroutable host).
   */
  makeUnreachable?: () => { driver: WorkerDriver; workerId: string };
}

const DEFAULT_TIMEOUT_MS = 30_000;

function descriptorOf(worker: WorkerDescriptor): {
  workerId: string;
  workerHost: string;
  driverRef: string;
} {
  return { workerId: worker.workerId, workerHost: worker.workerHost, driverRef: worker.driverRef };
}

/**
 * Registers the shared {@link WorkerDriver} conformance tests. `makeDriver`
 * must return a FRESH driver per call so each case starts from a clean
 * inventory.
 */
export function runDriverConformanceSuite(
  makeDriver: () => WorkerDriver,
  opts: ConformanceSuiteOptions,
): void {
  const suiteName = opts.suiteName ?? "WorkerDriver conformance";
  const provisionTimeoutMs = opts.provisionTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const destroyTimeoutMs = opts.destroyTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const [workerIdA, workerIdB] = opts.workerIds;

  const provisionRequest = (workerId: string): ProvisionRequest =>
    opts.makeProvisionRequest?.(workerId) ?? {
      workerId,
      labels: ["lorenz.worker-pool"],
      timeoutMs: provisionTimeoutMs,
    };

  describe(suiteName, () => {
    test("provision is idempotent on workerId", async () => {
      const driver = makeDriver();
      const first = await driver.provision(provisionRequest(workerIdA));
      const second = await driver.provision(provisionRequest(workerIdA));

      // Same idempotency key must yield the same worker identity (no duplicate).
      expect(first.workerId).toBe(workerIdA);
      expect(descriptorOf(second)).toEqual(descriptorOf(first));

      // A second provision must NOT create a duplicate in the inventory.
      const listed = await driver.list();
      const matching = listed.filter((worker) => worker.workerId === workerIdA);
      expect(matching).toHaveLength(1);
    });

    test("list() descriptors carry the pool-owned label", async () => {
      // The pool's hydrate re-adoption and reaper reconcile gate ONLY re-adopt /
      // destroy survivors whose list() descriptor carries POOL_OWNED_LABEL. A
      // descriptor missing it is NEVER touched, so for a driver that creates
      // disposable, pool-owned workers (ephemeral), a leaked survivor (e.g. a paid
      // E2B/Modal/Fly/Docker worker left by a crashed daemon) would leak forever.
      // Pinning the label on every ephemeral driver's list() descriptors
      // catches that class of bug going forward.
      //
      // Non-ephemeral drivers (fixed-inventory static-ssh, in-memory fake) own
      // no disposable resource the pool re-adopts/reaps via this gate, so the
      // label is not load-bearing for them and the assertion does not apply.
      const driver = makeDriver();
      if (!driver.capabilities.ephemeral) return;

      await driver.provision(provisionRequest(workerIdA));

      const listed = await driver.list();
      expect(listed.length).toBeGreaterThan(0);
      for (const worker of listed) {
        expect(worker.labels).toContain(POOL_OWNED_LABEL);
      }
    });

    test("list() reflects provisioned-minus-destroyed", async () => {
      const driver = makeDriver();
      const a = await driver.provision(provisionRequest(workerIdA));
      const b = await driver.provision(provisionRequest(workerIdB));

      const afterProvision = (await driver.list()).map((worker) => worker.workerId).sort();
      expect(afterProvision).toContain(workerIdA);
      expect(afterProvision).toContain(workerIdB);

      await driver.destroy(b, { timeoutMs: destroyTimeoutMs, reason: "shrink" });

      const afterDestroy = (await driver.list()).map((worker) => worker.workerId);
      // The surviving worker is still listed; the destroyed one is gone.
      expect(afterDestroy).toContain(a.workerId);
      expect(afterDestroy).not.toContain(b.workerId);
    });

    test("destroy is idempotent (already-gone is ok)", async () => {
      const driver = makeDriver();
      const worker = await driver.provision(provisionRequest(workerIdA));

      // Destroying twice must not throw; the worker is gone after the first call.
      await driver.destroy(worker, { timeoutMs: destroyTimeoutMs, reason: "idle" });
      await driver.destroy(worker, { timeoutMs: destroyTimeoutMs, reason: "idle" });

      const listed = (await driver.list()).map((entry) => entry.workerId);
      expect(listed).not.toContain(worker.workerId);
    });

    test("destroy of a never-provisioned worker is a no-op (does not throw)", async () => {
      const driver = makeDriver();
      const phantom: WorkerDescriptor = {
        workerId: workerIdA,
        workerHost: "unknown",
        driverRef: "unknown",
        createdAtMs: 0,
        labels: ["lorenz.worker-pool"],
        metadata: {},
      };

      // Destroying a worker the driver has never seen must be tolerated.
      await driver.destroy(phantom, { timeoutMs: destroyTimeoutMs, reason: "orphan" });
    });

    if (opts.makeUnreachable) {
      const makeUnreachable = opts.makeUnreachable;
      test("probe gates a created-but-unreachable worker to ok:false", async () => {
        const { driver, workerId } = makeUnreachable();
        const worker = await driver.provision(provisionRequest(workerId));

        const health = await driver.probe(worker, { timeoutMs: probeTimeoutMs });
        expect(health.ok).toBe(false);
        if (!health.ok) {
          // The failure must carry a non-empty reason for diagnostics.
          expect(typeof health.reason).toBe("string");
          expect(health.reason.length).toBeGreaterThan(0);
        }
      });
    }
  });
}
