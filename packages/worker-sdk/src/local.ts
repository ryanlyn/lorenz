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

const KIND = "local";

const CAPABILITIES: DriverCapabilities = {
  sshAddressable: false,
  ephemeral: false,
  usesLedger: false,
};

/**
 * The single-machine, in-process {@link WorkerDriver}. It provisions workers
 * whose `workerHost` is the EMPTY string, the canonical "no remote worker"
 * signal the orchestrator/endpoint-manager understands: an empty host mints NO
 * tunnel and NO MCP lease, so acp keeps its own in-process MCP endpoint and the
 * run executes locally. A warm pool at `slotsPerMachine=1` over this driver
 * runs one local worker, single-tenant.
 *
 * Mechanically it is a purely in-memory `Map<workerId, WorkerDescriptor>` with
 * deterministic `createdAtMs` from the injected clock, idempotent
 * provision/destroy, and a probe that returns `{ ok: true }` WITHOUT touching
 * SSH (there is no remote machine to reach). The yielded `workerHost` is empty
 * (so downstream wiring takes the local-execution arm), and the `driverRef`
 * stays distinct per worker (`local://<workerId>`) so destroy/list/reconcile
 * key per-worker even though every worker shares the empty host. There is no
 * failure injection: a local in-process worker has no remote faults to model.
 *
 * This driver is single-machine by design: the pool affinity-keys on
 * `workerHost`, so an empty host collapses every local worker into ONE affinity
 * bucket. That is inert at the configuration this driver is meant for
 * (`slotsPerMachine=1`, `max=1`): there is at most one local worker, so the
 * bucket never matters.
 */
export class LocalWorkerDriver implements WorkerDriver {
  readonly kind = KIND;
  readonly capabilities = CAPABILITIES;

  // The live inventory: provisioned-minus-destroyed, keyed on the pool's
  // idempotency key so `provision` is idempotent on `workerId`.
  private readonly workers = new Map<string, WorkerDescriptor>();

  constructor(private readonly deps: Pick<DriverDeps, "clock">) {}

  /**
   * Provisions (or re-adopts) a local worker for `req.workerId`. Idempotent on
   * `workerId`: a second call returns the SAME descriptor without creating a
   * duplicate. The yielded `workerHost` is the EMPTY string (local execution,
   * no tunnel); the `driverRef` is `local://<workerId>` so it stays distinct
   * per worker for destroy/list keying. `createdAtMs` is stamped from the
   * injected clock so it is deterministic.
   */
  async provision(req: ProvisionRequest): Promise<WorkerDescriptor> {
    const existing = this.workers.get(req.workerId);
    if (existing) {
      return Promise.resolve(existing);
    }

    const descriptor: WorkerDescriptor = {
      workerId: req.workerId,
      // The empty host is load-bearing: it routes the run through acp's own
      // in-process MCP endpoint (no tunnel, no MCP lease).
      workerHost: "",
      // A distinct, non-empty ref per worker so destroy/list/reconcile key
      // per-worker even though every local worker shares the empty host.
      driverRef: `local://${req.workerId}`,
      createdAtMs: this.deps.clock.now().getTime(),
      labels: [...req.labels],
      metadata: {},
    };
    this.workers.set(req.workerId, descriptor);
    return Promise.resolve(descriptor);
  }

  /**
   * Reports the worker healthy if it is in the live inventory. There is no
   * remote machine to reach, so this NEVER calls SSH; an unknown/destroyed
   * worker is reported `ok: false` rather than throwing (mirroring a probe
   * against a gone worker).
   */
  async probe(
    worker: WorkerDescriptor,
    _opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<WorkerHealth> {
    if (!this.workers.has(worker.workerId)) {
      return Promise.resolve({ ok: false, reason: "local_worker_not_found" });
    }
    return Promise.resolve({ ok: true });
  }

  /**
   * Destroys a local worker. Idempotent and tolerant of an already-gone (or
   * never-provisioned) worker.
   */
  async destroy(
    worker: WorkerDescriptor,
    _opts: { timeoutMs: number; reason: TeardownReason },
  ): Promise<void> {
    this.workers.delete(worker.workerId);
    return Promise.resolve();
  }

  /** Returns the live inventory (provisioned-minus-destroyed). */
  async list(): Promise<WorkerDescriptor[]> {
    return Promise.resolve([...this.workers.values()]);
  }
}

/** The registered `local` factory: constructs a fresh in-process driver per pool. */
export const localWorkerDriverFactory: WorkerDriverFactory = {
  kind: KIND,
  create: (_options, deps) => new LocalWorkerDriver(deps),
};

/**
 * Registers the `local` driver. The SDK ships this driver (rather than an
 * extension) because it is the default backend a pool falls back to when no
 * remote workers are configured: the composition root registers it next to the
 * `fake`/`static-ssh`/`docker` drivers so a default-on local pool can provision
 * an empty-host worker and keep execution in-process.
 */
export function registerLocalWorkerDriver(
  registries: { workerDrivers?: WorkerDriverRegistry | undefined } = {},
): void {
  const drivers = registries.workerDrivers ?? defaultWorkerDriverRegistry;
  if (drivers.get(KIND) === undefined) {
    drivers.register(localWorkerDriverFactory);
  }
}
