import { POOL_OWNED_LABEL, defaultWorkerDriverRegistry } from "@symphony/worker-sdk";
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

const KIND = "modal";

/**
 * SSH-ADDRESSABLE TRANSPORT ASSUMPTION. Symphony's executor reaches a worker
 * over SSH, so this driver assumes the Modal Sandbox is provisioned to run
 * `sshd` and expose an SSH endpoint (e.g. `modal@<sandbox>.modal.host:2200`).
 * That endpoint is returned verbatim as the worker `workerHost` and is what the
 * probe + runner connect to. A non-SSH / native-exec Modal integration would
 * require executor changes and is OUT OF SCOPE here (a possible future
 * extension). Hence `capabilities.sshAddressable` is `true`.
 */
const CAPABILITIES: DriverCapabilities = {
  // Modal sandboxes are reached over SSH (see the assumption above).
  sshAddressable: true,
  // Sandboxes are disposable machines created/terminated per pool decision.
  ephemeral: true,
  // A cloud driver: pool-owned survivors are tracked in the write-ahead ledger.
  usesLedger: true,
};

/** The readiness command the probe runs over SSH (a cheap liveness check). */
const PROBE_COMMAND = "printf ready";

/**
 * The label the pool stamps on every worker it owns. `list()` filters on this so a
 * reconcile only adopts sandboxes this pool provisioned (never a foreign one).
 */
const POOL_LABEL = "symphony.worker-pool";

/**
 * A live Modal Sandbox as seen through the transport. `sandboxId` is Modal's own
 * handle (used for `terminate`/`list` reconcile); `sshHost` is the SSH endpoint
 * the sandbox exposes; `labels` are the tags stamped at create time so a
 * `list()` reconcile can re-adopt pool-owned survivors.
 */
export interface ModalSandbox {
  sandboxId: string;
  sshHost: string;
  labels: ReadonlyArray<string>;
}

/**
 * Request handed to the transport to create a sandbox. `labels` are stamped on
 * the sandbox (pool label + a workerId-derived label so survivors correlate back to
 * a `workerId`); `image` is the optional base image from the `image` driver option.
 */
export interface ModalCreateRequest {
  labels: ReadonlyArray<string>;
  image?: string | undefined;
}

/**
 * The Modal seam. Deliberately abstract so this extension takes NO hard dependency
 * on the Modal client/CLI: the composition root injects either a CLI-shelling
 * transport or a Modal-client-backed one via
 * `registerModalWorkerDriver(registries, { transport })`, and the always-on tests
 * inject an in-memory fake. `create` boots a sandbox exposing an SSH endpoint;
 * `terminate` removes it (idempotent at the Modal level); `list` enumerates
 * sandboxes carrying a label.
 */
export interface ModalTransport {
  create(req: ModalCreateRequest): Promise<ModalSandbox>;
  terminate(sandboxId: string): Promise<void>;
  list(opts: { label: string }): Promise<ModalSandbox[]>;
}

/** Dependency overrides (the injected Modal transport seam). */
export interface ModalDriverOverrides {
  transport: ModalTransport;
}

/**
 * Derives the workerId-correlation label stamped on a sandbox at create time so a
 * `list()` reconcile can map a survivor back to its `workerId`.
 */
function workerIdLabel(workerId: string): string {
  return `${POOL_LABEL}.worker-id=${workerId}`;
}

/**
 * A {@link WorkerDriver} backed by Modal Sandboxes via an INJECTED transport (a
 * CLI shim or the Modal client), so this extension carries no Modal SDK dependency.
 * `provision` creates a sandbox exposing SSH and returns the endpoint as the worker
 * `workerHost` (idempotent on `workerId`); `probe` runs `printf ready` over SSH with
 * the caller-supplied timeout; `destroy` terminates the sandbox by its Modal id;
 * `list` enumerates pool-labeled sandboxes for reconcile. Transport faults are
 * mapped to typed `modal_provision_failed` / `modal_destroy_failed` /
 * `modal_list_failed` errors.
 */
export class ModalWorkerDriver implements WorkerDriver {
  readonly kind = KIND;
  readonly capabilities = CAPABILITIES;

  private readonly transport: ModalTransport;
  private readonly runSsh: SshRunner;
  /** Optional base image threaded into every create request. */
  private readonly image: string | undefined;

  /** Live sandboxes provisioned through this instance, keyed by `workerId`. */
  private readonly workers = new Map<string, ModalSandbox>();

  constructor(
    options: Readonly<Record<string, unknown>>,
    private readonly deps: DriverDeps,
    overrides: ModalDriverOverrides,
  ) {
    this.transport = overrides.transport;
    this.runSsh = deps.runSsh;
    const image = options["image"];
    this.image = typeof image === "string" ? image : undefined;
  }

  /**
   * Creates (or re-adopts) a Modal sandbox for `req.workerId`. Idempotent on
   * `workerId`: a second call returns the SAME descriptor without creating a second
   * sandbox. The sandbox is stamped with the pool label AND a workerId-derived label
   * so a `list()` reconcile can re-adopt survivors. A transport fault is mapped to
   * a typed `modal_provision_failed` error (and the worker is NOT recorded as live).
   */
  async provision(req: ProvisionRequest): Promise<WorkerDescriptor> {
    const existing = this.workers.get(req.workerId);
    if (existing) {
      return this.descriptorFor(req.workerId, existing);
    }

    const labels = Array.from(new Set([...req.labels, POOL_LABEL, workerIdLabel(req.workerId)]));
    let sandbox: ModalSandbox;
    try {
      sandbox = await this.transport.create({ labels, image: this.image });
    } catch (error) {
      throw new Error(`modal_provision_failed: ${messageOf(error)}`, { cause: error });
    }
    this.workers.set(req.workerId, sandbox);
    return this.descriptorFor(req.workerId, sandbox);
  }

  /**
   * Runs `printf ready` over SSH against the sandbox's endpoint using the
   * caller-supplied `opts.timeoutMs` (the pool threads `worker.sshTimeoutMs`). A
   * non-zero exit or any transport error (e.g. an sshd that has not come up yet)
   * gates the worker to `{ ok: false }` rather than throwing, so the reaper can
   * demote it.
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
        return { ok: false, reason: `modal_probe_exit_${result.status}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: messageOf(error) };
    }
  }

  /**
   * Terminates the sandbox by its Modal id (`driverRef`). Always issues the
   * terminate so a SURVIVOR adopted via `list()` (a sandbox a prior daemon
   * provisioned, hence absent from this instance's `workers`) is still torn down by
   * a reconcile/drain - never silently skipped. Idempotent: an already-gone
   * sandbox (a "not found" transport fault) is the desired end state and is
   * swallowed. Any other transport fault maps to a typed `modal_destroy_failed`.
   */
  async destroy(
    worker: WorkerDescriptor,
    _opts: { timeoutMs: number; reason: TeardownReason },
  ): Promise<void> {
    try {
      await this.transport.terminate(worker.driverRef);
    } catch (error) {
      if (isNotFound(error)) {
        // Already gone: the desired end state (sandbox terminated) holds.
        this.workers.delete(worker.workerId);
        return;
      }
      throw new Error(`modal_destroy_failed: ${messageOf(error)}`, { cause: error });
    }
    this.workers.delete(worker.workerId);
  }

  /**
   * Lists pool-owned sandboxes by filtering on the pool label, mapping each to an
   * SSH-addressable descriptor for reconcile. A transport fault is mapped to a
   * typed `modal_list_failed` error.
   */
  async list(): Promise<WorkerDescriptor[]> {
    let sandboxes: ModalSandbox[];
    try {
      sandboxes = await this.transport.list({ label: POOL_LABEL });
    } catch (error) {
      throw new Error(`modal_list_failed: ${messageOf(error)}`, { cause: error });
    }
    return sandboxes.map((sandbox) =>
      this.descriptorFor(workerIdFromLabels(sandbox), sandbox, {
        // Surface the pool-owned label so the pool's hydrate/reaper ownership gate
        // (which keys on POOL_OWNED_LABEL) re-adopts or cleans up this survivor.
        // Only POOL_LABEL-tagged sandboxes reach here, so every returned
        // descriptor is pool-owned.
        ownedLabel: true,
      }),
    );
  }

  private descriptorFor(
    workerId: string,
    sandbox: ModalSandbox,
    opts: { ownedLabel?: boolean } = {},
  ): WorkerDescriptor {
    const labels = opts.ownedLabel
      ? Array.from(new Set([POOL_OWNED_LABEL, ...sandbox.labels]))
      : [...sandbox.labels];
    return {
      workerId,
      workerHost: sandbox.sshHost,
      driverRef: sandbox.sandboxId,
      createdAtMs: this.deps.clock.now().getTime(),
      labels,
      metadata: { sandboxId: sandbox.sandboxId },
    };
  }
}

/**
 * Recovers the `workerId` a survivor was provisioned under from its labels, falling
 * back to the Modal sandbox id when the correlation label is absent.
 */
function workerIdFromLabels(sandbox: ModalSandbox): string {
  const prefix = `${POOL_LABEL}.worker-id=`;
  const match = sandbox.labels.find((label) => label.startsWith(prefix));
  return match ? match.slice(prefix.length) : sandbox.sandboxId;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when a "not found"-style error means the sandbox is already gone. */
function isNotFound(error: unknown): boolean {
  return /not[\s_-]?found/i.test(messageOf(error));
}

/**
 * Builds the `modal` factory over an injected {@link ModalTransport}. The
 * extension carries no Modal SDK/CLI dependency, so a working factory only
 * exists once the composition root supplies the transport.
 */
export function modalWorkerDriverFactory(io: { transport: ModalTransport }): WorkerDriverFactory {
  return {
    kind: KIND,
    create: (options, deps) => new ModalWorkerDriver(options, deps, io),
  };
}

/**
 * The fail-loud `modal` factory registered when no transport is injected:
 * enabling the kind then fails at pool construction with an actionable message
 * instead of failing at first provision.
 */
const failLoudFactory: WorkerDriverFactory = {
  kind: KIND,
  create: () => {
    throw new Error(
      "worker_pool_driver_unavailable: modal requires an injected transport; register a configured modal driver via registerModalWorkerDriver(registries, { transport }) before enabling it",
    );
  },
};

/**
 * Register this extension's worker driver. Idempotent; called by the composition
 * root (or a test) against its registry, defaulting to the process-wide one.
 * With `io` it registers a working factory closing over the supplied transport;
 * without `io` it registers a fail-loud factory so the stock daemon (which
 * ships no Modal transport) surfaces an actionable error if the kind is enabled.
 */
export function registerModalWorkerDriver(
  registries: { workerDrivers?: WorkerDriverRegistry | undefined } = {},
  io?: { transport: ModalTransport },
): void {
  const drivers = registries.workerDrivers ?? defaultWorkerDriverRegistry;
  if (drivers.get(KIND) === undefined) {
    drivers.register(io ? modalWorkerDriverFactory(io) : failLoudFactory);
  }
}
