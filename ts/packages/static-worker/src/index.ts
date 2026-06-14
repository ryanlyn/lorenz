import { defaultWorkerDriverRegistry } from "@symphony/worker-sdk";
import type {
  WorkerDescriptor,
  WorkerDriver,
  WorkerDriverFactory,
  WorkerDriverRegistry,
  WorkerHealth,
  DriverCapabilities,
  DriverDeps,
  ProvisionRequest,
  SshRunner,
  TeardownReason,
} from "@symphony/worker-sdk";

const KIND = "static-ssh";

const CAPABILITIES: DriverCapabilities = {
  sshAddressable: true,
  ephemeral: false,
  usesLedger: false,
};

/** The readiness command the probe runs over SSH (a cheap liveness check). */
const PROBE_COMMAND = "printf ready";

/**
 * Reads the configured host list from the driver options, accepting BOTH the
 * snake_case `ssh_hosts` and the camelCase `sshHosts` spellings. This is the
 * documented passthrough: the config normalizer is a flat per-key alias map and
 * does NOT recurse into the driver options, so an operator may write either form.
 * Throws `static_ssh_hosts_required` when neither is a non-empty string array.
 */
function readSshHosts(options: Readonly<Record<string, unknown>> | undefined): string[] {
  const raw = options?.["ssh_hosts"] ?? options?.["sshHosts"];
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((value) => typeof value === "string" && value.length > 0)
  ) {
    return raw as string[];
  }
  throw new Error("static_ssh_hosts_required");
}

/**
 * A {@link WorkerDriver} over a FIXED set of pre-existing SSH machines configured
 * via the `ssh_hosts` (or `sshHosts`) driver option. It owns no lifecycle for the
 * machines themselves: `min == max == hosts.length` is the implicit shape, and
 * the address IS the `workerId`. `provision` hands out one of the configured
 * addresses idempotently; `probe` runs `printf ready` over SSH using the
 * caller-supplied `opts.timeoutMs` (the pool threads `worker.sshTimeoutMs` here);
 * `destroy` merely forgets the address locally - it runs NO workspace hooks and
 * NEVER deletes a machine (a destroyed host is immediately re-provisionable);
 * `list` returns the configured set minus the addresses currently forgotten.
 */
export class StaticSshWorkerDriver implements WorkerDriver {
  readonly kind = KIND;
  readonly capabilities = CAPABILITIES;

  /** The full configured inventory (the fixed address set), in config order. */
  private readonly hosts: readonly string[];
  private readonly hostSet: ReadonlySet<string>;
  /**
   * workerId -> assigned host. Keys are the pool's idempotency keys: either a
   * synthetic `worker-N` the pool minted, or a configured host string (the legacy
   * "address IS the workerId" shape). Tracks the provisioned-minus-destroyed view.
   */
  private readonly assignments = new Map<string, string>();
  private readonly runSsh: SshRunner;

  constructor(
    options: Readonly<Record<string, unknown>>,
    private readonly deps: DriverDeps,
  ) {
    this.hosts = readSshHosts(options);
    this.hostSet = new Set(this.hosts);
    this.runSsh = deps.runSsh;
  }

  /**
   * Hands out a configured address for `req.workerId`. The pool mints synthetic
   * `worker-N` idempotency keys (NOT host strings), so an unknown workerId is ASSIGNED a
   * free configured host round-robin and that mapping is remembered (the
   * `workerHost` is the chosen host while the `workerId` stays the pool's key). A
   * workerId that already IS a configured host is served directly (the legacy
   * "address is the workerId" shape, e.g. a host-keyed hydrate survivor). Idempotent
   * on `workerId`: a second call returns the same assignment. Rejects with
   * `static_ssh_unknown_host` only when the fixed inventory is exhausted (no free
   * host remains).
   */
  async provision(req: ProvisionRequest): Promise<WorkerDescriptor> {
    const existing = this.assignments.get(req.workerId);
    if (existing) {
      return Promise.resolve(this.descriptorFor(req.workerId, existing, [...req.labels]));
    }

    // Legacy shape: the workerId itself is a configured address (the address IS the
    // key). Serve that host directly so a host-keyed provision/hydrate still works.
    if (this.hostSet.has(req.workerId)) {
      this.assignments.set(req.workerId, req.workerId);
      return Promise.resolve(this.descriptorFor(req.workerId, req.workerId, [...req.labels]));
    }

    // Synthetic workerId (the pool's `worker-N`): assign the first free configured host.
    const taken = new Set(this.assignments.values());
    const host = this.hosts.find((candidate) => !taken.has(candidate));
    if (host === undefined) {
      return Promise.reject(new Error(`static_ssh_unknown_host: ${req.workerId}`));
    }
    this.assignments.set(req.workerId, host);
    return Promise.resolve(this.descriptorFor(req.workerId, host, [...req.labels]));
  }

  /**
   * Runs `printf ready` over SSH against the worker's address, using the
   * caller-supplied `opts.timeoutMs` (the pool passes `worker.sshTimeoutMs`). A
   * non-zero exit or any transport error (e.g. `ssh_timeout`) gates the worker to
   * `{ ok: false }` rather than throwing, so the reaper can demote it.
   */
  async probe(
    worker: WorkerDescriptor,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<WorkerHealth> {
    try {
      const result = await this.runSsh(worker.workerHost, PROBE_COMMAND, {
        timeoutMs: opts.timeoutMs,
      });
      if (result.status !== 0) {
        return { ok: false, reason: `static_ssh_probe_exit_${result.status}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Forgets the address locally. This is a pure bookkeeping no-op against the
   * machine: it runs NO workspace hooks and NEVER deletes the machine (a static
   * host is pre-existing infrastructure). Idempotent and tolerant of an
   * already-forgotten or never-provisioned address.
   */
  async destroy(
    worker: WorkerDescriptor,
    _opts: { timeoutMs: number; reason: TeardownReason },
  ): Promise<void> {
    // Free the host assignment so the address re-enters the pool of free hosts a
    // future provision can hand out. Idempotent and tolerant of an already-gone id.
    this.assignments.delete(worker.workerId);
    return Promise.resolve();
  }

  /** Returns the live inventory (provisioned-minus-destroyed assignments). */
  async list(): Promise<WorkerDescriptor[]> {
    return Promise.resolve(
      [...this.assignments.entries()].map(([workerId, host]) =>
        this.descriptorFor(workerId, host, []),
      ),
    );
  }

  private descriptorFor(workerId: string, host: string, labels: string[]): WorkerDescriptor {
    return {
      workerId,
      workerHost: host,
      driverRef: host,
      createdAtMs: this.deps.clock.now().getTime(),
      labels,
      metadata: {},
    };
  }
}

/** The registered `static-ssh` factory: constructs a driver over the configured hosts. */
export const staticSshWorkerDriverFactory: WorkerDriverFactory = {
  kind: KIND,
  create: (options, deps) => new StaticSshWorkerDriver(options, deps),
};

/**
 * Register this built-in worker driver. Idempotent; called by the composition
 * root (or a test) against its registry, defaulting to the process-wide one.
 */
export function registerStaticSshWorkerDriver(
  registries: { workerDrivers?: WorkerDriverRegistry | undefined } = {},
): void {
  const drivers = registries.workerDrivers ?? defaultWorkerDriverRegistry;
  if (drivers.get(KIND) === undefined) {
    drivers.register(staticSshWorkerDriverFactory);
  }
}
