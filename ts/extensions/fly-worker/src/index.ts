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

const KIND = "fly";

const CAPABILITIES: DriverCapabilities = {
  sshAddressable: true,
  ephemeral: true,
  usesLedger: true,
};

/** Default Fly Machines REST host. Overridable via `api_host_name`. */
const DEFAULT_API_HOST = "https://api.machines.dev";

/** The readiness command the probe runs over SSH (a cheap liveness check). */
const PROBE_COMMAND = "printf ready";

/** Bound for the timeout-less `list()` HTTP call (reconcile/hydrate path). */
const LIST_TIMEOUT_MS = 30_000;

/** Metadata key marking a machine as pool-owned (so list-reconcile re-adopts). */
const POOL_LABEL_KEY = "symphony_worker_pool";
/** Metadata key carrying the pool's idempotency `workerId`. */
const WORKER_ID_KEY = "symphony_worker_id";

/**
 * Minimal `fetch`-shaped response the driver consumes. Kept deliberately
 * narrow (no `json()`/headers reflection) so the always-on tests can drive it
 * with a tiny in-memory fake and so the global `fetch` satisfies it verbatim.
 */
export interface FlyFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** Init bag for {@link FlyFetch}; mirrors the slice of `RequestInit` we use. */
export interface FlyFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Abort signal so a hung Fly Machines API call can be bounded by a deadline. */
  signal?: AbortSignal;
}

/**
 * Injectable HTTP transport for the Fly Machines API. The global `fetch`
 * satisfies this shape, so production wiring passes nothing and tests pass a
 * scripted fake that records request verb/url/headers/body construction.
 */
export type FlyFetch = (url: string, init?: FlyFetchInit) => Promise<FlyFetchResponse>;

/** Optional dependency overrides (test seam for the HTTP transport). */
export interface FlyDriverOverrides {
  fetch?: FlyFetch;
}

/** Reads a driver-option value accepting BOTH snake_case and camelCase keys. */
function readOption(
  options: Readonly<Record<string, unknown>> | undefined,
  snake: string,
  camel: string,
): unknown {
  return options?.[snake] ?? options?.[camel];
}

function readStringOption(
  options: Readonly<Record<string, unknown>> | undefined,
  snake: string,
  camel: string,
): string | undefined {
  const value = readOption(options, snake, camel);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumberOption(
  options: Readonly<Record<string, unknown>> | undefined,
  snake: string,
  camel: string,
): number | undefined {
  const value = readOption(options, snake, camel);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolved, validated Fly configuration distilled from the driver options. */
interface FlyConfig {
  app: string;
  image: string;
  region: string | undefined;
  token: string;
  apiHost: string;
  sshUser: string;
  sshPort: number;
  sshHostTemplate: string | undefined;
}

/**
 * A {@link WorkerDriver} backed by the Fly Machines REST API. Each worker is a Fly
 * Machine created from an image that runs `sshd`, so the yielded `workerHost`
 * is an SSH destination on the Fly private network (`user@<private-ipv6>:port`)
 * or a configured DNS template. Machines are labeled with the pool marker + the
 * pool's `workerId` via `config.metadata`, so `list()` can re-adopt pool-owned
 * survivors and skip foreign machines. `destroy` issues a forced machine delete
 * and treats a 404 as already-gone (idempotent). The HTTP transport is injected
 * (defaults to the global `fetch`) so always-on unit tests run with zero network
 * and zero cost.
 */
export class FlyWorkerDriver implements WorkerDriver {
  readonly kind = KIND;
  readonly capabilities = CAPABILITIES;

  private readonly config: FlyConfig;
  private readonly fetch: FlyFetch;
  private readonly runSsh: SshRunner;

  constructor(
    options: Readonly<Record<string, unknown>>,
    private readonly deps: DriverDeps,
    overrides: FlyDriverOverrides = {},
  ) {
    this.config = resolveConfig(options);
    this.fetch = overrides.fetch ?? globalFetch;
    this.runSsh = deps.runSsh;
  }

  /**
   * Creates a Fly Machine from the configured image (idempotency is the pool's
   * responsibility via `workerId`; the machine is stamped with the pool label +
   * `workerId` so a list-reconcile can re-adopt it). Returns an SSH-addressable
   * `workerHost`. Maps a non-2xx create to `fly_provision_failed`.
   */
  async provision(req: ProvisionRequest): Promise<WorkerDescriptor> {
    // Idempotent on `workerId`: if a pool-owned machine already carries this
    // workerId (e.g. a re-provision after a crash, or a retry), re-adopt it
    // rather than creating a duplicate machine.
    const existing = (await this.list()).find((worker) => worker.workerId === req.workerId);
    if (existing) {
      return { ...existing, labels: [...req.labels] };
    }

    const body = JSON.stringify({
      name: `symphony-${req.workerId}`,
      region: this.config.region,
      config: {
        image: this.config.image,
        metadata: {
          [POOL_LABEL_KEY]: "true",
          [WORKER_ID_KEY]: req.workerId,
        },
      },
    });

    const response = await this.fetchBounded(
      this.machinesUrl(),
      {
        method: "POST",
        headers: this.headers(),
        body,
      },
      req.timeoutMs,
    );

    if (!response.ok) {
      const detail = await safeText(response);
      throw new Error(`fly_provision_failed: ${response.status} ${detail}`);
    }

    const machine = parseJson(await response.text());
    if (!isRecord(machine) || typeof machine["id"] !== "string") {
      throw new Error(`fly_provision_failed: malformed create response`);
    }

    const driverRef = machine["id"];
    return {
      workerId: req.workerId,
      workerHost: this.workerHostFor(driverRef, machine),
      driverRef,
      createdAtMs: this.deps.clock.now().getTime(),
      labels: [...req.labels],
      metadata: { region: machine["region"] ?? this.config.region },
    };
  }

  /**
   * Runs `printf ready` over SSH against the machine's `workerHost`, using the
   * caller-supplied `opts.timeoutMs`. A non-zero exit or any transport error
   * gates the worker to `{ ok: false }` rather than throwing.
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
        return { ok: false, reason: `fly_probe_exit_${result.status}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Forcibly destroys the machine via `DELETE .../machines/{ref}?force=true`. A
   * 404 (already gone) is swallowed so destroy is idempotent; any other non-2xx
   * maps to `fly_destroy_failed`.
   */
  async destroy(
    worker: WorkerDescriptor,
    opts: { timeoutMs: number; reason: TeardownReason },
  ): Promise<void> {
    const response = await this.fetchBounded(
      `${this.machineUrl(worker.driverRef)}?force=true`,
      {
        method: "DELETE",
        headers: this.headers(),
      },
      opts.timeoutMs,
    );

    if (response.ok || response.status === 404) {
      return;
    }
    const detail = await safeText(response);
    throw new Error(`fly_destroy_failed: ${response.status} ${detail}`);
  }

  /**
   * Lists pool-owned machines for the app. Only machines stamped with the pool
   * label are adopted (foreign machines in the same app are skipped); each is
   * mapped back to its `workerId` from `config.metadata`. Maps a non-2xx to
   * `fly_list_failed`.
   */
  async list(): Promise<WorkerDescriptor[]> {
    const response = await this.fetchBounded(
      this.machinesUrl(),
      {
        method: "GET",
        headers: this.headers(),
      },
      LIST_TIMEOUT_MS,
    );

    if (!response.ok) {
      const detail = await safeText(response);
      throw new Error(`fly_list_failed: ${response.status} ${detail}`);
    }

    const parsed = parseJson(await response.text());
    const machines = Array.isArray(parsed) ? parsed : [];
    const descriptors: WorkerDescriptor[] = [];
    for (const machine of machines) {
      if (!isRecord(machine) || typeof machine["id"] !== "string") continue;
      const config = isRecord(machine["config"]) ? machine["config"] : {};
      const metadata = isRecord(config["metadata"]) ? config["metadata"] : {};
      if (metadata[POOL_LABEL_KEY] !== "true") continue;
      const workerId = metadata[WORKER_ID_KEY];
      if (typeof workerId !== "string" || workerId.length === 0) continue;
      const driverRef = machine["id"];
      descriptors.push({
        workerId,
        workerHost: this.workerHostFor(driverRef, machine),
        driverRef,
        createdAtMs: this.deps.clock.now().getTime(),
        // Surface the pool-owned label so the pool's hydrate/reconcile ownership
        // gate (which keys on POOL_OWNED_LABEL) re-adopts or cleans up this
        // survivor. Only machines stamped with the pool metadata reach here, so
        // every returned descriptor is pool-owned.
        labels: [POOL_OWNED_LABEL, POOL_LABEL_KEY],
        metadata: { region: machine["region"] },
      });
    }
    return descriptors;
  }

  /** Base app-scoped machines collection URL. */
  private machinesUrl(): string {
    return `${this.config.apiHost}/v1/apps/${this.config.app}/machines`;
  }

  /** Single-machine item URL. */
  private machineUrl(driverRef: string): string {
    return `${this.machinesUrl()}/${driverRef}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Issues a Fly Machines API call bounded by `timeoutMs` so a hung request can
   * never keep `recycle()` / `pool.drain()` awaited past the caller's deadline
   * (which would block shutdown and leave a paid machine unmanaged until the process
   * is killed). The deadline is enforced with an `AbortSignal`; on expiry the request
   * is aborted and surfaced as a typed `fly_request_timeout` the callers map/rethrow.
   */
  private async fetchBounded(
    url: string,
    init: FlyFetchInit,
    timeoutMs: number,
  ): Promise<FlyFetchResponse> {
    try {
      return await this.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new Error(`fly_request_timeout: ${timeoutMs}ms ${init.method ?? "GET"} ${url}`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * Builds the SSH-addressable `workerHost`. Prefers an explicit
   * `ssh_host_template` (substituting `{machineId}` and `{app}`); otherwise uses
   * the machine's `private_ip` on the Fly private network. Always
   * `user@host:port`.
   *
   * A bare IPv6 literal (e.g. a Fly private `fdaa:0:...`) is rendered bracketed
   * (`user@[fdaa:0:...]:port`) so the engine's SSH target parser lifts the
   * trailing `:port` into `-p` instead of gluing it into the hostname (which
   * left the probe/runner unable to connect). IPv4 / DNS / configured-template
   * hosts stay unbracketed.
   */
  private workerHostFor(driverRef: string, machine: Record<string, unknown>): string {
    const { sshUser, sshPort, sshHostTemplate, app } = this.config;
    if (sshHostTemplate) {
      const host = sshHostTemplate.replaceAll("{machineId}", driverRef).replaceAll("{app}", app);
      return `${sshUser}@${host}:${sshPort}`;
    }
    const privateIp = typeof machine["private_ip"] === "string" ? machine["private_ip"] : "";
    return `${sshUser}@${sshHostLiteral(privateIp)}:${sshPort}`;
  }
}

/**
 * Renders a host for use in a `user@host:port` SSH destination. A bare IPv6
 * literal (contains `:`, not already bracketed) is wrapped in `[...]` so a
 * trailing `:port` is unambiguous to the SSH target parser; IPv4 and DNS hosts
 * pass through unchanged.
 */
function sshHostLiteral(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

/** Resolves + validates the Fly configuration from the driver options. */
function resolveConfig(options: Readonly<Record<string, unknown>> | undefined): FlyConfig {
  const app = readStringOption(options, "app", "app");
  if (!app) throw new Error("fly_app_required");

  const image = readStringOption(options, "image", "image");
  if (!image) throw new Error("fly_image_required");

  const token = readStringOption(options, "api_token", "apiToken") ?? process.env.FLY_API_TOKEN;
  if (!token) throw new Error("fly_api_token_required");

  return {
    app,
    image,
    region: readStringOption(options, "region", "region"),
    token,
    apiHost: readStringOption(options, "api_host_name", "apiHostName") ?? DEFAULT_API_HOST,
    sshUser: readStringOption(options, "ssh_user", "sshUser") ?? "root",
    sshPort: readNumberOption(options, "ssh_port", "sshPort") ?? 22,
    sshHostTemplate: readStringOption(options, "ssh_host_template", "sshHostTemplate"),
  };
}

/** Reads a response body without throwing (best-effort error detail). */
async function safeText(response: FlyFetchResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** Parses JSON, returning `null` on malformed input rather than throwing. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Adapts the global `fetch` to {@link FlyFetch}. Kept as a thin wrapper so the
 * driver never references the DOM `RequestInit`/`Response` types directly.
 */
const globalFetch: FlyFetch = async (url, init) => {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    text: async () => response.text(),
  };
};

/** The registered `fly` factory: constructs a driver over the global `fetch`. */
export const flyWorkerDriverFactory: WorkerDriverFactory = {
  kind: KIND,
  create: (options, deps) => new FlyWorkerDriver(options, deps),
};

/**
 * Register this extension's worker driver. Idempotent; called by the composition
 * root (or a test) against its registry, defaulting to the process-wide one.
 */
export function registerFlyWorkerDriver(
  registries: { workerDrivers?: WorkerDriverRegistry | undefined } = {},
): void {
  const drivers = registries.workerDrivers ?? defaultWorkerDriverRegistry;
  if (drivers.get(KIND) === undefined) {
    drivers.register(flyWorkerDriverFactory);
  }
}
