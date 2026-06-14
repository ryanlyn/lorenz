import { execFile } from "node:child_process";

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

const KIND = "docker";

/**
 * Docker workers are disposable SSH-addressable containers, so the pool both
 * destroys them (`ephemeral`) and keeps a write-ahead ledger (`usesLedger`) to
 * recover survivors across a daemon restart by label.
 */
const CAPABILITIES: DriverCapabilities = {
  sshAddressable: true,
  ephemeral: true,
  usesLedger: true,
};

/**
 * The label every pool-owned container carries (with an EMPTY value) so a
 * `docker ps --filter label=<this>` enumerates only our containers and never
 * adopts an unrelated one.
 */
const LABEL_POOL = "symphony.worker-pool";

/** The label that records the pool's idempotency key (workerId) on each container. */
const LABEL_WORKER_ID = "symphony.worker-id";

/** The container's sshd port that the run publishes to a loopback host port. */
const CONTAINER_SSH_PORT = "22";

/** The readiness command the probe runs over SSH (a cheap liveness check). */
const PROBE_COMMAND = "printf ready";

/** Default SSH user baked into the worker image when none is configured. */
const DEFAULT_USER = "root";

/** Result of one `docker` invocation. Mirrors the subprocess transport surface. */
export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  status: number;
}

/** Injectable `docker` transport (test seam); defaults to a real subprocess. */
export type RunDocker = (
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<DockerCommandResult>;

/** Optional dependency overrides (test seam for the docker transport). */
export interface DockerDriverOverrides {
  runDocker?: RunDocker;
}

/** Reads a string driver-option value under any of the given keys. */
function readStringOption(
  options: Readonly<Record<string, unknown>> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = options?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Default `docker` transport: shells out to the `docker` binary on PATH via
 * `execFile`, never throwing on a non-zero exit (the caller maps exits to
 * typed errors). An ENOENT (binary missing) surfaces as a thrown
 * `docker_not_found` so the daemon fails loud at startup.
 */
const defaultRunDocker: RunDocker = async (args, options) =>
  new Promise<DockerCommandResult>((resolve, reject) => {
    execFile(
      "docker",
      [...args],
      { timeout: options.timeoutMs, signal: options.signal, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error("docker_not_found", { cause: error }));
          return;
        }
        const status =
          typeof (error as { code?: unknown } | null)?.code === "number"
            ? ((error as { code: number }).code ?? 0)
            : error
              ? 1
              : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", status });
      },
    );
  });

/**
 * Parses the loopback host port that a `docker port <id> 22` / `docker ps`
 * `Ports` column maps to the container's sshd port. Accepts both the
 * `0.0.0.0:<port>` form emitted by `docker port` and the
 * `0.0.0.0:<port>->22/tcp` mapping emitted in a `ps` row.
 */
function parsePublishedPort(text: string): number | undefined {
  const mapped = text.match(/(?:\d{1,3}(?:\.\d{1,3}){3}|\[[^\]]+\]):(\d+)->22\/tcp/);
  if (mapped?.[1]) return Number.parseInt(mapped[1], 10);
  const direct = text.match(/(?:\d{1,3}(?:\.\d{1,3}){3}|\[[^\]]+\]):(\d+)/);
  if (direct?.[1]) return Number.parseInt(direct[1], 10);
  return undefined;
}

/**
 * A {@link WorkerDriver} that boots disposable Docker containers running `sshd`.
 *
 * `provision` runs `docker run -d` of the `image` driver option, publishing the
 * container's sshd port (22) to an auto-assigned loopback host port and
 * labelling the container with {@link LABEL_POOL} (so `list`/reconcile can adopt
 * survivors) and {@link LABEL_WORKER_ID}=<workerId> (the pool's idempotency key). It is
 * idempotent ACROSS driver instances: a second provision of the same workerId
 * adopts the surviving labelled container rather than launching a duplicate.
 * `probe` runs `printf ready` over SSH against the published `user@127.0.0.1:<port>`;
 * `destroy` runs `docker rm -f <containerId>` and tolerates an already-gone
 * container; `list` runs `docker ps --filter label=<LABEL_POOL>` so unlabelled
 * containers are never touched. Capabilities are
 * `{ sshAddressable: true, ephemeral: true, usesLedger: true }`.
 */
export class DockerWorkerDriver implements WorkerDriver {
  readonly kind = KIND;
  readonly capabilities = CAPABILITIES;

  private readonly image: string | undefined;
  private readonly user: string;
  private readonly runDocker: RunDocker;
  private readonly runSsh: SshRunner;

  constructor(
    options: Readonly<Record<string, unknown>>,
    private readonly deps: DriverDeps,
    overrides: DockerDriverOverrides = {},
  ) {
    this.image = readStringOption(options, "image");
    this.user = readStringOption(options, "user", "sshUser", "ssh_user") ?? DEFAULT_USER;
    this.runDocker = overrides.runDocker ?? defaultRunDocker;
    this.runSsh = deps.runSsh;
  }

  /**
   * Boots (or adopts) the container for `req.workerId`. Idempotency is keyed on the
   * {@link LABEL_WORKER_ID} label on the live daemon: if a labelled container
   * already exists it is adopted (no `docker run`), so two driver instances
   * sharing one daemon never double-launch. Otherwise it runs
   * `docker run -d -p 127.0.0.1::22 --label symphony.worker-pool= --label
   * symphony.worker-id=<workerId> [--label <caller label>...] <image>`, then resolves
   * the published loopback port via `docker port`. Rejects with
   * `docker_image_required` when the `image` driver option is unset and
   * `docker_run_failed` on a non-zero `docker run` exit.
   */
  async provision(req: ProvisionRequest): Promise<WorkerDescriptor> {
    if (!this.image) throw new Error("docker_image_required");

    const existing = (await this.list()).find((worker) => worker.workerId === req.workerId);
    if (existing) return existing;

    const labelArgs: string[] = [
      `--label`,
      `${LABEL_POOL}=`,
      `--label`,
      `${LABEL_WORKER_ID}=${req.workerId}`,
    ];
    for (const label of req.labels) {
      if (label === LABEL_POOL) continue;
      labelArgs.push("--label", label);
    }

    const runArgs = [
      "run",
      "-d",
      "-p",
      `127.0.0.1::${CONTAINER_SSH_PORT}`,
      ...labelArgs,
      this.image,
    ];
    const run = await this.runDocker(runArgs, {
      timeoutMs: req.timeoutMs,
      ...(req.signal ? { signal: req.signal } : {}),
    });
    if (run.status !== 0) {
      throw new Error(`docker_run_failed: ${run.status} ${run.stderr.trim()}`);
    }
    const containerId = run.stdout.trim();

    // The container now exists on the daemon. Any failure resolving its published
    // port would otherwise leave a running container the pool never records: `grow()`
    // drops the provisional ledger row and writes NO inventory record, so a later
    // drain/reaper can never see or destroy it. Force-remove it before rethrowing so
    // a post-create fault never leaks a paid container.
    try {
      const port = await this.runDocker(["port", containerId, CONTAINER_SSH_PORT], {
        timeoutMs: req.timeoutMs,
        ...(req.signal ? { signal: req.signal } : {}),
      });
      if (port.status !== 0) {
        throw new Error(`docker_port_failed: ${port.status} ${port.stderr.trim()}`);
      }
      const hostPort = parsePublishedPort(port.stdout);
      if (hostPort === undefined) {
        throw new Error(`docker_port_unresolved: ${port.stdout.trim()}`);
      }

      return {
        workerId: req.workerId,
        workerHost: this.workerHostFor(hostPort),
        driverRef: containerId,
        createdAtMs: this.deps.clock.now().getTime(),
        labels: [
          LABEL_POOL,
          LABEL_WORKER_ID,
          ...req.labels.filter((label) => label !== LABEL_POOL),
        ],
        metadata: { containerId, hostPort },
      };
    } catch (error) {
      // Best-effort: a cleanup failure must not mask the original provision error.
      await this.runDocker(["rm", "-f", containerId], { timeoutMs: req.timeoutMs }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  /**
   * Runs `printf ready` over SSH against the published `workerHost`, using the
   * caller-supplied `opts.timeoutMs`. A non-zero exit or any transport error
   * gates the worker to `{ ok: false }` (with a reason) rather than throwing, so the
   * reaper can demote an unreachable-but-created container.
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
        return { ok: false, reason: `docker_probe_exit_${result.status}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Force-removes the container via `docker rm -f <driverRef>`. Idempotent: a
   * `No such container` exit (the container is already gone) is tolerated, while
   * any other non-zero exit (e.g. the daemon is unreachable) throws
   * `docker_rm_failed` so the reaper can retry.
   */
  async destroy(
    worker: WorkerDescriptor,
    opts: { timeoutMs: number; reason: TeardownReason },
  ): Promise<void> {
    const result = await this.runDocker(["rm", "-f", worker.driverRef], {
      timeoutMs: opts.timeoutMs,
    });
    if (result.status === 0) return;
    if (/no such container/i.test(result.stderr)) return;
    throw new Error(`docker_rm_failed: ${result.status} ${result.stderr.trim()}`);
  }

  /**
   * Enumerates pool-owned containers via `docker ps --filter label=<LABEL_POOL>`,
   * reading the {@link LABEL_WORKER_ID} label and the published loopback port out of
   * the tab-separated `ID<TAB>worker-id<TAB>Ports` rows. Unlabelled containers are
   * never returned (the filter excludes them), so reconcile never adopts an
   * unrelated container.
   */
  async list(): Promise<WorkerDescriptor[]> {
    const result = await this.runDocker(
      [
        "ps",
        "--filter",
        `label=${LABEL_POOL}`,
        "--no-trunc",
        "--format",
        `{{.ID}}\t{{.Label "${LABEL_WORKER_ID}"}}\t{{.Ports}}`,
      ],
      { timeoutMs: 30_000 },
    );
    if (result.status !== 0) {
      throw new Error(`docker_ps_failed: ${result.status} ${result.stderr.trim()}`);
    }
    const createdAtMs = this.deps.clock.now().getTime();
    const workers: WorkerDescriptor[] = [];
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [containerId, workerId, ports = ""] = trimmed.split("\t");
      if (!containerId || !workerId) continue;
      const hostPort = parsePublishedPort(ports);
      if (hostPort === undefined) continue;
      workers.push({
        workerId,
        workerHost: this.workerHostFor(hostPort),
        driverRef: containerId,
        createdAtMs,
        // Surface the pool-owned label so the pool's hydrate/reconcile ownership
        // gate (which keys on POOL_OWNED_LABEL) re-adopts or cleans up this
        // survivor. The `docker ps --filter label=<LABEL_POOL>` filter already
        // guarantees every returned container is pool-owned.
        labels: [POOL_OWNED_LABEL, LABEL_POOL, LABEL_WORKER_ID],
        metadata: { containerId, hostPort },
      });
    }
    return workers;
  }

  private workerHostFor(hostPort: number): string {
    return `${this.user}@127.0.0.1:${hostPort}`;
  }
}

/** The registered `docker` factory: constructs a driver over the real docker CLI. */
export const dockerWorkerDriverFactory: WorkerDriverFactory = {
  kind: KIND,
  create: (options, deps) => new DockerWorkerDriver(options, deps),
};

/**
 * Register this extension's worker driver. Idempotent; called by the composition
 * root (or a test) against its registry, defaulting to the process-wide one.
 */
export function registerDockerWorkerDriver(
  registries: { workerDrivers?: WorkerDriverRegistry | undefined } = {},
): void {
  const drivers = registries.workerDrivers ?? defaultWorkerDriverRegistry;
  if (drivers.get(KIND) === undefined) {
    drivers.register(dockerWorkerDriverFactory);
  }
}
