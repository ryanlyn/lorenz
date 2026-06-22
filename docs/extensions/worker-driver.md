# Build a worker driver

A worker driver provisions the SSH-addressable machines the warm pool leases to agent runs: your own cloud, your VM fleet, a container runtime. This page is for extension authors. It covers the `WorkerDriver` contract, what the pool guarantees you for free, what your driver must guarantee in return, and the in-repo recipe to ship one.

The split is the point. The pool in `@lorenz/worker-pool` owns every lifecycle decision (leasing, reaping, spend caps, the ledger, crash recovery) and calls your driver for exactly four operations: provision, probe, destroy, list. You implement a backend; you never touch the engine. The contract lives in `@lorenz/worker-sdk`, which depends on `@lorenz/domain` alone, so an extension implementing a driver pulls in the SDK layer and nothing else.

## The driver contract

A driver is a `WorkerDriver` (in `packages/worker-sdk/src/types.ts`). The pool calls only these members.

| Member | Signature | What you implement |
| --- | --- | --- |
| `kind` | `readonly string` | The selector matched against `worker.worker_pool.driver`. |
| `provision` | `(req: ProvisionRequest) => Promise<WorkerDescriptor>` | Create or re-adopt one machine. Idempotent on `req.workerId`. |
| `probe` | `(worker, { timeoutMs, signal? }) => Promise<WorkerHealth>` | Cheap readiness check. Returns `{ ok: false, reason }` instead of throwing. |
| `destroy` | `(worker, { timeoutMs, reason }) => Promise<void>` | Tear the machine down. Idempotent; a gone machine is tolerated. |
| `list` | `() => Promise<WorkerDescriptor[]>` | The live inventory: provisioned minus destroyed. The pool's source of truth. |
| `capabilities` | `readonly DriverCapabilities` | Three static booleans (see below). |

You register a `WorkerDriverFactory`, not a driver instance:

```ts
interface WorkerDriverFactory {
  readonly kind: string;
  create(options: Readonly<Record<string, unknown>>, deps: DriverDeps): WorkerDriver;
}
```

`create` receives the selected `workers.<name>` profile options verbatim (minus the `driver` key) and the pool's `DriverDeps`. It constructs the driver and validates its options, throwing an actionable error when they are unusable. That throw lands at pool construction, the same fail-loud startup point as an unregistered kind.

### Capabilities

`DriverCapabilities` is three booleans the pool reads to decide how to treat your backend:

| Field | Meaning |
| --- | --- |
| `sshAddressable` | The `workerHost` you yield is an SSH destination. |
| `ephemeral` | Workers are disposable machines the pool may destroy. |
| `usesLedger` | Gate the write-ahead ledger. A cloud backend that bills per machine sets this so survivors recover across a daemon restart. |

The fake driver sets all three false. `static-ssh` sets `{ sshAddressable: true, ephemeral: false, usesLedger: false }`. `docker` sets all three true.

### Descriptors and requests

`provision` takes a `ProvisionRequest` and returns a `WorkerDescriptor`:

- `ProvisionRequest`: `{ workerId, affinityKey?, labels, timeoutMs, signal?, driverOptions? }`. `workerId` is the pool's idempotency key. `affinityKey` carries a prior `workerHost` so a retry can re-land on the same machine. `labels` includes `POOL_OWNED_LABEL` (stamp it onto the machine).
- `WorkerDescriptor`: `{ workerId, workerHost, driverRef, createdAtMs, labels, metadata }`. `workerHost` is the SSH-addressable string the runner threads end to end. `driverRef` is your own handle (a machine id, a container id) that `destroy` and `list` reconcile against.

`WorkerHealth` is `{ ok: true } | { ok: false; reason: string }`. `TeardownReason`, passed to `destroy`, is one of `ttl`, `idle`, `shrink`, `unhealthy`, `failed`, `drain`, `orphan`.

## What the pool gives you for free

You implement four operations. The pool builds the rest of the machinery on top of `list()` and your descriptors. You do not write any of this.

- **Leasing.** The pool selects an idle worker, stamps a lease, hands the `workerHost` to the run, and settles the lease exactly once on release. A long single-turn run is never force-returned.
- **Warm top-up and reaping.** A single serial reaper reconciles against `list()`, reaps idle workers past `idle_reap_ms` above `min`, expires leases past `ttl_ms`, demotes workers that fail a probe, and tops the pool back up toward `warm`.
- **Spend caps.** `max_concurrent_workers`, `max_worker_seconds` (lifetime), and `daily_worker_seconds` (per UTC day) gate growth and acquisition. The pool bills worker-seconds per lease and persists the daily total to a `spend.json` sidecar.
- **Write-ahead ledger.** When `usesLedger` is true and a ledger path is configured, the pool writes a provisional row before it calls `provision` and correlates it after, so a crash mid-provision leaves a recoverable trace. The ledger is inert (zero fs I/O) for drivers that do not set `usesLedger`.
- **Crash recovery.** On `hydrate`, the pool calls `list()`, re-adopts every survivor carrying `POOL_OWNED_LABEL` as idle, drops orphan ledger rows, and reseeds daily spend. A paid driver (`usesLedger` or `ephemeral`) that cannot list after retries fails startup loud with `worker_pool_hydrate_failed`, so a billing backend never proceeds blind.
- **Drain.** On disable or shutdown, the pool rejects new acquires, awaits in-flight leases to a deadline, then force-destroys every worker so no paid machine leaks.

<p align="center"><img src="../assets/diagrams/worker-pool-state.svg" alt="worker pool state diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*The pool drives every worker through this lifecycle by calling your four operations; you never assign these states yourself.*

## What your driver must guarantee

The pool's machinery is correct only if your driver holds up its end. The conformance suite (below) pins each of these.

- **`provision` is idempotent on `workerId`.** A second `provision` with the same `workerId` returns the same descriptor and creates no duplicate in `list()`. The pool retries; `docker` keys idempotency on a label on the live daemon and adopts a surviving container rather than double-launching.
- **`destroy` tolerates a gone machine.** Destroying twice, or destroying a never-provisioned worker, is a no-op that never throws. Throw only on a transport failure the reaper should retry (`docker` throws `docker_rm_failed` when the daemon is unreachable, but swallows `No such container`).
- **`list()` is the truth.** It returns exactly the provisioned-minus-destroyed inventory. The pool reconciles, hydrates, and reaps against this list, so a stale or partial `list()` corrupts ownership accounting.
- **`probe` gates, does not throw.** A created-but-unreachable worker returns `{ ok: false, reason }` with a non-empty reason. Both SSH-addressable built-in drivers (`static-ssh` and `docker`) run `printf ready` over SSH and map any non-zero exit or transport error to `ok: false`, so the reaper can demote it.
- **Round-trip `POOL_OWNED_LABEL`.** The constant is the literal string `lorenz.pool=worker-pool`. The pool stamps it on every `provision` request. If your driver is `ephemeral`, every descriptor your `list()` returns MUST carry it back. The hydrate re-adoption and reaper reconcile gate keys on this label: a survivor missing it is never touched, so a leaked paid machine would leak forever. Non-ephemeral drivers (fixed-inventory, in-memory) own no disposable resource behind this gate, so the label is not load-bearing for them.

## DriverDeps: you never import the engine

`create` receives `DriverDeps`, the only channel between the pool and your driver:

```ts
interface DriverDeps {
  clock: ClockPort;
  logEvent: (event: Record<string, unknown>) => void;
  runSsh: SshRunner;
}
```

`runSsh` is the injected SSH runner. The pool wires in the real `@lorenz/ssh` implementation; your driver probes workers over SSH through `deps.runSsh` and never imports the engine ssh package. `clock` makes `createdAtMs` deterministic in tests. `logEvent` emits structured events. There are deliberately no workspace or hook deps here: a driver manages worker lifecycle only.

A transport the engine does not provide (a cloud SDK client, a Modal or E2B handle) is closed over by your extension's registration, never threaded through `DriverDeps`. The SDK surface stays stable as backends come and go.

## The in-repo recipe

To ship a driver inside the repo:

1. **Create the package.** Add `extensions/<name>-worker`. The `fake` driver lives in `packages/worker-sdk` and `static-ssh` lives in `packages/static-worker`, but `docker`, a built-in too, already lives under `extensions/docker-worker`, which is where your new backend goes. A dependency-cruiser rule (`extensions-depend-on-sdk-layers-only`) blocks an extension from reaching into engine packages, so depend on `@lorenz/worker-sdk` and `@lorenz/domain` only.

2. **Implement the factory.** Export a `class MyWorkerDriver implements WorkerDriver` and a `WorkerDriverFactory` whose `create` constructs it from `options` and `deps`:

   ```ts
   const KIND = "my-cloud";

   export const myWorkerDriverFactory: WorkerDriverFactory = {
     kind: KIND,
     create: (options, deps) => new MyWorkerDriver(options, deps),
   };
   ```

3. **Register idempotently.** Export a `register*` function guarded so a second call is a no-op:

   ```ts
   export function registerMyWorkerDriver(
     registries: { workerDrivers?: WorkerDriverRegistry } = {},
   ): void {
     const drivers = registries.workerDrivers ?? defaultWorkerDriverRegistry;
     if (drivers.get(KIND) === undefined) {
       drivers.register(myWorkerDriverFactory);
     }
   }
   ```

   `WorkerDriverRegistry.register` throws `worker driver already registered for kind: <kind>` when a different factory claims the same `kind`. `require` throws `worker_pool_driver_unavailable: <kind>` listing the known kinds when an operator names a driver nobody registered, or `worker.worker_pool.driver is required` when the key is unset.

4. **Wire it into the composition root.** `registerBuiltinBackends` in `apps/cli/src/daemon.ts` is the single place builtin backends are registered. Add a `registerMyWorkerDriver({ workerDrivers })` call there alongside `registerFakeWorkerDriver`, `registerStaticSshWorkerDriver`, and `registerDockerWorkerDriver`. An operator then selects it with `worker.worker_pool.driver: my-cloud` and passes options through a `workers.<name>` profile.

5. **Run the conformance suite.** Import `runDriverConformanceSuite` from the `@lorenz/worker-sdk/conformance` subpath and invoke it at the top level of your test file. It registers its own `describe`/`test` blocks:

   ```ts
   import { runDriverConformanceSuite } from "@lorenz/worker-sdk/conformance";

   runDriverConformanceSuite(() => new MyWorkerDriver(options, deps), {
     suiteName: "MyWorkerDriver",
     workerIds: ["worker-a", "worker-b"],
     makeProvisionRequest: (workerId) => ({
       workerId,
       labels: [POOL_OWNED_LABEL],
       timeoutMs: 30_000,
     }),
     makeUnreachable: () => ({ driver: makeFailingDriver(), workerId: "worker-down" }),
   });
   ```

   `makeDriver` must return a fresh driver per call so each case starts clean. `makeUnreachable` is optional: a driver that cannot represent a created-but-unreachable worker omits it and the probe-gating case is skipped. The suite asserts provision idempotency, destroy tolerance, `list = provisioned − destroyed`, the `POOL_OWNED_LABEL` round-trip on every `ephemeral` driver's `list()`, and probe gating.

The conformance source lives under `src/` (not `test/`) on purpose, so it compiles to `dist/` and every driver's own test can import it.

## The fake driver as reference

`FakeWorkerDriver` in `packages/worker-sdk/src/fake.ts` is the SDK's reference implementation. It owns no real machines and touches no disk: every operation mutates a `Map<workerId, WorkerDescriptor>`, the `workerHost` is a synthetic `fake://worker-<workerId>`, and `createdAtMs` comes from the injected clock. Capabilities are all false. Read it to see the exact idempotency and tolerance behavior the suite expects in the smallest possible form.

It exposes per-worker failure injection (`injectProbeFailure`, `injectProvisionFailure`, `injectDestroyFailure`, and the matching `clear*` methods) so tests can drive provision/probe/destroy faults, including the conformance suite's unreachable-worker case. A `fsWriteCount` getter is structurally pinned at `0`, so a test can assert the driver performed zero filesystem I/O.

`static-ssh` (`packages/static-worker/src/index.ts`) and `docker` (`extensions/docker-worker/src/index.ts`) are the two backends that talk to real infrastructure. Read `static-ssh` for the fixed-inventory shape (the address is the `workerId`, `destroy` forgets the address and never deletes a machine) and `docker` for a disposable, `usesLedger` backend that adopts surviving containers by label and force-removes a half-built one before rethrowing.

## Loading a driver out of tree

You do not have to land a driver in the repo. A driver can ship as a standalone npm module and load by specifier at startup through an `sdkVersion` handshake, with no fork of Lorenz. That path, the `defineWorkerDriver` / `assertWorkerDriverModule` shape, and its trust boundary are covered in [out-of-tree extensions](./out-of-tree.md).

## See also

- [Out-of-tree extensions](./out-of-tree.md) - ship a driver as a module without forking the repo
- [Warm worker pool](../workers/worker-pool.md) - the operator-facing view of the pool that leases your workers
- [Docker workers](../workers/docker.md) - the reference disposable, ledger-backed driver in action
- [Extension points](./index.md) - the four SDK contracts and how backends register
- [Configuration reference](../reference/configuration.md) - every `worker.worker_pool` and `workers.<name>` key
