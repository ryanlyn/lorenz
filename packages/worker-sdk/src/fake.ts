import type { WorkerDriverRegistry } from "./registry.js";
import { defaultWorkerDriverRegistry } from "./registry.js";
import type {
  WorkerDescriptor,
  WorkerDriver,
  WorkerDriverFactory,
  DriverCapabilities,
  DriverDeps,
  WorkerHealth,
  ProvisionRequest,
  TeardownReason,
} from "./types.js";

const KIND = "fake";

const CAPABILITIES: DriverCapabilities = {
  sshAddressable: false,
  ephemeral: false,
  usesLedger: false,
};

/**
 * An in-memory {@link WorkerDriver} used by the always-on test layer and the
 * memory-tracker e2e demo, and the SDK's reference implementation of the
 * driver contract. It owns no real machines and touches no disk: every
 * operation mutates a `Map<workerId, WorkerDescriptor>` and the yielded `workerHost`
 * is a synthetic `fake://worker-<workerId>` address. Determinism comes from the
 * injected clock (so `createdAtMs` is reproducible), and failure can be
 * injected per-worker so tests can exercise probe/provision/destroy faults and
 * the conformance suite's unreachable-worker case.
 */
export class FakeWorkerDriver implements WorkerDriver {
  readonly kind = KIND;
  readonly capabilities = CAPABILITIES;

  // The live inventory: provisioned-minus-destroyed, keyed on the pool's
  // idempotency key so `provision` is idempotent on `workerId`.
  private readonly workers = new Map<string, WorkerDescriptor>();

  // Per-worker failure injections. `probeFailures` flips `probe` to `{ ok: false }`;
  // `provisionFailures`/`destroyFailures` reject the respective call.
  private readonly probeFailures = new Map<string, string>();
  private readonly provisionFailures = new Map<string, string>();
  private readonly destroyFailures = new Map<string, string>();

  // A write counter that proves the driver never touched the disk. It is
  // structurally pinned at 0 (the driver holds only in-memory state), so a
  // test can assert ZERO fs I/O by reading `fsWriteCount`.
  private writes = 0;

  constructor(private readonly deps: Pick<DriverDeps, "clock">) {}

  /** Number of fs writes performed (always 0; the driver is purely in-memory). */
  get fsWriteCount(): number {
    return this.writes;
  }

  /**
   * Provisions (or re-adopts) a worker for `req.workerId`. Idempotent on `workerId`: a
   * second call returns the SAME descriptor without creating a duplicate. The
   * descriptor is stamped from the injected clock so its `createdAtMs` is
   * deterministic.
   */
  async provision(req: ProvisionRequest): Promise<WorkerDescriptor> {
    const injected = this.provisionFailures.get(req.workerId);
    if (injected !== undefined) {
      return Promise.reject(new Error(injected));
    }

    const existing = this.workers.get(req.workerId);
    if (existing) {
      return Promise.resolve(existing);
    }

    const workerHost = `fake://worker-${req.workerId}`;
    const descriptor: WorkerDescriptor = {
      workerId: req.workerId,
      workerHost,
      driverRef: workerHost,
      createdAtMs: this.deps.clock.now().getTime(),
      labels: [...req.labels],
      metadata: {},
    };
    this.workers.set(req.workerId, descriptor);
    return Promise.resolve(descriptor);
  }

  /**
   * Reports the worker healthy unless a probe failure was injected for its
   * `workerId`. An unknown/already-destroyed worker is reported `ok: false` rather
   * than throwing (mirroring a real probe against a gone machine).
   */
  async probe(
    worker: WorkerDescriptor,
    _opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<WorkerHealth> {
    const injected = this.probeFailures.get(worker.workerId);
    if (injected !== undefined) {
      return Promise.resolve({ ok: false, reason: injected });
    }
    if (!this.workers.has(worker.workerId)) {
      return Promise.resolve({ ok: false, reason: "fake_worker_not_found" });
    }
    return Promise.resolve({ ok: true });
  }

  /**
   * Destroys a worker. Idempotent and tolerant of an already-gone (or
   * never-provisioned) worker. Rejects only when a destroy failure was injected
   * for the worker, leaving the worker in place so the caller can retry.
   */
  async destroy(
    worker: WorkerDescriptor,
    _opts: { timeoutMs: number; reason: TeardownReason },
  ): Promise<void> {
    const injected = this.destroyFailures.get(worker.workerId);
    if (injected !== undefined) {
      return Promise.reject(new Error(injected));
    }
    this.workers.delete(worker.workerId);
    return Promise.resolve();
  }

  /** Returns the live inventory (provisioned-minus-destroyed). */
  async list(): Promise<WorkerDescriptor[]> {
    return Promise.resolve([...this.workers.values()]);
  }

  /** Injects a probe failure so `probe` returns `{ ok: false, reason }`. */
  injectProbeFailure(workerId: string, reason: string): void {
    this.probeFailures.set(workerId, reason);
  }

  /** Clears a previously injected probe failure so the worker probes healthy again. */
  clearProbeFailure(workerId: string): void {
    this.probeFailures.delete(workerId);
  }

  /** Injects a provision failure so `provision` rejects with `reason`. */
  injectProvisionFailure(workerId: string, reason: string): void {
    this.provisionFailures.set(workerId, reason);
  }

  /** Clears a previously injected provision failure. */
  clearProvisionFailure(workerId: string): void {
    this.provisionFailures.delete(workerId);
  }

  /** Injects a destroy failure so `destroy` rejects with `reason`. */
  injectDestroyFailure(workerId: string, reason: string): void {
    this.destroyFailures.set(workerId, reason);
  }

  /** Clears a previously injected destroy failure. */
  clearDestroyFailure(workerId: string): void {
    this.destroyFailures.delete(workerId);
  }
}

/** The registered `fake` factory: constructs a fresh in-memory driver per pool. */
export const fakeWorkerDriverFactory: WorkerDriverFactory = {
  kind: KIND,
  create: (_options, deps) => new FakeWorkerDriver(deps),
};

/**
 * Registers the `fake` driver. The SDK ships this reference driver (rather
 * than an extension) so engine and extension test suites alike can exercise
 * the pool without real machines; the composition root registers it next to
 * the real driver extensions.
 */
export function registerFakeWorkerDriver(
  registries: { workerDrivers?: WorkerDriverRegistry | undefined } = {},
): void {
  const drivers = registries.workerDrivers ?? defaultWorkerDriverRegistry;
  if (drivers.get(KIND) === undefined) {
    drivers.register(fakeWorkerDriverFactory);
  }
}
