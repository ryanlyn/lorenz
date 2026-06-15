import type { ClockPort } from "@lorenz/domain";

/**
 * The worker driver contract: everything a third party needs to ship a new worker
 * backend (their own cloud, their own VM fleet) as an extension, without
 * touching the pool engine. A driver provisions, probes, destroys, and lists
 * SSH-addressable workers behind one interface; the warm pool in
 * `@lorenz/worker-pool` owns every lifecycle decision (leasing, reaping,
 * spend, crash recovery) and only ever calls these four operations.
 *
 * This module is dependency-light by design: it pulls `ClockPort` from
 * `@lorenz/domain` only, so extensions implementing a driver depend on the
 * SDK layer alone.
 */

/**
 * The label every pool-owned worker carries so a `list()` reconcile can re-adopt
 * or destroy ONLY workers the pool created (never an unlabeled foreign
 * instance). The pool stamps this on every provision request, and every
 * driver's `list()` MUST surface it on the descriptors it returns (the pool's
 * ownership gate keys on it).
 */
export const POOL_OWNED_LABEL = "lorenz.pool=worker-pool";

/**
 * Why a worker is being torn down. Drives driver `destroy` and the pool's
 * ledger/spend bookkeeping; never runs workspace hooks (the runner owns
 * workspace lifecycle).
 */
export type TeardownReason =
  | "ttl"
  | "idle"
  | "shrink"
  | "unhealthy"
  | "failed"
  | "drain"
  | "orphan";

/**
 * Driver-reported health of a single worker. The probe is a cheap readiness
 * check (e.g. `printf ready` over SSH), not a workspace/hook operation.
 */
export type WorkerHealth = { ok: true } | { ok: false; reason: string };

/**
 * Static capabilities of a driver backend. `usesLedger` gates the write-ahead
 * ledger (cloud-only); `sshAddressable` records that the yielded `workerHost`
 * is an SSH destination; `ephemeral` records that workers are disposable
 * machines.
 */
export interface DriverCapabilities {
  sshAddressable: boolean;
  ephemeral: boolean;
  usesLedger: boolean;
}

/**
 * A provisioned worker. `workerHost` is the SSH-addressable string threaded
 * end-to-end by the orchestrator/runner. `driverRef` is the backend's own
 * handle (e.g. a machine id) used for `destroy`/`list` reconcile. `labels`
 * tag pool-owned survivors so a `list()` reconcile can re-adopt them.
 */
export interface WorkerDescriptor {
  workerId: string;
  workerHost: string;
  driverRef: string;
  createdAtMs: number;
  labels: ReadonlyArray<string>;
  metadata: Record<string, unknown>;
}

/**
 * Request to provision one worker. `workerId` is the pool's idempotency key (a
 * driver must return the same worker for the same `workerId`). `affinityKey` carries
 * a prior `workerHost` so a retry can re-land on the same machine. `labels`
 * are stamped on the worker for reconcile. `driverOptions` is the operator's selected
 * `workers.<name>` profile, minus `driver`, passed through verbatim.
 */
export interface ProvisionRequest {
  workerId: string;
  affinityKey?: string | null;
  labels: ReadonlyArray<string>;
  timeoutMs: number;
  signal?: AbortSignal;
  driverOptions?: Record<string, unknown>;
}

/**
 * A swappable backend that provisions, probes, destroys, and lists workers
 * behind one interface. Every implementation must be idempotent on `workerId`
 * for `provision` and idempotent for `destroy` (a second destroy of a gone
 * machine is tolerated, never an error).
 */
export interface WorkerDriver {
  readonly kind: string;
  provision(req: ProvisionRequest): Promise<WorkerDescriptor>;
  probe(
    worker: WorkerDescriptor,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<WorkerHealth>;
  destroy(
    worker: WorkerDescriptor,
    opts: { timeoutMs: number; reason: TeardownReason },
  ): Promise<void>;
  list(): Promise<WorkerDescriptor[]>;
  readonly capabilities: DriverCapabilities;
}

/**
 * Structural mirror of the engine's ssh runner so drivers can probe workers over
 * SSH without depending on the engine ssh package. The pool injects the real
 * implementation through {@link DriverDeps}; tests inject fakes.
 */
export interface SshRunOptions {
  timeoutMs?: number | undefined;
  stderrToStdout?: boolean | undefined;
  abortSignal?: AbortSignal | undefined;
}

export interface SshRunResult {
  stdout: string;
  stderr: string;
  status: number;
}

export type SshRunner = (
  destination: string,
  command: string,
  options?: SshRunOptions,
) => Promise<SshRunResult>;

/**
 * Dependencies a driver factory receives from the pool. Deliberately excludes
 * any workspace or hook deps: drivers manage worker lifecycle only. Cloud
 * transports the engine does not provide (e.g. an E2B client or Modal
 * transport) are closed over by the extension's registration, never threaded
 * through these deps.
 */
export interface DriverDeps {
  clock: ClockPort;
  logEvent: (event: Record<string, unknown>) => void;
  runSsh: SshRunner;
}

/**
 * The unit a worker-driver extension registers: a named constructor for its
 * {@link WorkerDriver}. `create` receives the selected `workers.<name>` profile
 * options verbatim (never the full pool settings, so
 * the SDK surface stays stable) and validates them itself, throwing an
 * actionable error at pool construction when they are unusable - the same
 * fail-loud startup point as an unregistered kind.
 */
export interface WorkerDriverFactory {
  readonly kind: string;
  create(options: Readonly<Record<string, unknown>>, deps: DriverDeps): WorkerDriver;
}
