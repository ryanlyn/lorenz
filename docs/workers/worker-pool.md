# Warm worker pool

The warm worker pool provisions, leases, and reaps the SSH-addressable machines your agent runs execute on. It is a long-lived singleton in `@lorenz/worker-pool` that survives workflow hot-reload, calls a swappable `WorkerDriver` for provision/probe/destroy/list, and owns every lifecycle decision itself: leasing, warm top-up, a reaper, spend caps, a write-ahead ledger, and crash recovery. This page is for operators tuning the pool under `worker.worker_pool`.

The pool is one of two mutually exclusive ways to get a `workerHost`. The other is the legacy static path `worker.ssh_hosts`, a flat list of pre-existing SSH destinations the runtime shards runs across with no provisioning or lifecycle. You cannot combine `worker.ssh_hosts` with `worker.worker_pool` or `worker.kind`; the config parser rejects it. See [static SSH workers](./static-ssh.md) for that path.

## Turning it on

Selecting a `workers.<name>` profile through `worker.kind` auto-enables the pool. A bare `worker.worker_pool` block does not: it needs `enabled: true`, because `enabled` defaults to `false` unless a `worker.kind` profile is selected. The minimum config sets `enabled` and picks a driver:

```yaml
worker:
  worker_pool:
    enabled: true
    driver: docker
    min: 1
    max: 4
    warm: 2
```

When `worker.worker_pool` is present but `driver` is unspecified, the driver defaults to `fake` (in-memory, never touches SSH or disk). Set it to a real driver for real machines.

You can also keep driver options in a named profile and point `worker.kind` at it:

```yaml
worker:
  kind: ci-docker
workers:
  ci-docker:
    driver: docker
    image: ghcr.io/acme/agent-box:latest
```

The keys under `workers.<name>` (minus `driver`) pass to the driver factory verbatim. `worker.kind` cannot be combined with `worker.worker_pool.driver`; pick one place to name the driver.

## Lifecycle

Each worker moves through a small state machine. The pool stamps a worker `LEASED` when a run acquires it and returns it to `WARM_IDLE` on a healthy release; a poisoned release or a failed lease flags the worker for destruction, and the reaper or the last lease return recycles it.

<p align="center"><img src="../assets/diagrams/worker-pool-state.svg" alt="worker pool state diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*Worker states from `PROVISIONING` through `WARM_IDLE`, `LEASED`, `DEGRADED`, and `DESTROYING` to `DESTROYED`, with lease, healthy/poison settle, and reaper transitions.*

A freshly provisioned worker is probed before it can be leased. The pool calls `driver.probe` up to 3 attempts (50 ms times the attempt number between attempts) and only then admits the worker to inventory. An unready worker is destroyed: a failed grow returns `no_capacity` with reason `driver_error`, and a failed warm top-up is skipped. This is the reachable-before-leased contract, so a run never receives a machine that cannot answer.

Two states in the `WorkerState` vocabulary, `WARMING` and `DRAINING`, are never assigned by the pool. They are reserved for future async warmup and per-worker drain. You will not see them in a current snapshot.

## The acquire path

`acquire()` resolves synchronously where it can and parks the caller only when it must. The order is fixed:

1. Short-circuit if the pool is disabled or draining, returning `no_capacity` with reason `pool_disabled`.
2. Roll the UTC day key for daily spend accounting.
3. Check spend caps. If a cap blocks the acquire, return `no_capacity` with reason `spend_cap`.
4. Run `selectAndStamp` synchronously: prefer a sticky-affinity worker, then any idle worker, then an under-capacity worker (co-residence).
5. If nothing is free and the pool can grow, grow under a reservation.
6. If growth is blocked only by a spend cap, return `spend_cap`.
7. Otherwise park on the FIFO waiter queue and wait for capacity.

<p align="center"><img src="../assets/diagrams/worker-pool-acquire.svg" alt="worker pool acquire diagram" width="920" style="width:100%;max-width:920px;height:auto" /></p>
*The acquire decision path: select-and-stamp, reservation-based growth, the FIFO waiter queue, and the four `no_capacity` reasons.*

A parked waiter that is not woken before `acquire_timeout_ms` returns `no_capacity` with reason `acquire_timeout`. The dispatcher maps that signal onto its existing `worker_host_capacity` backpressure, so a timed-out acquire reschedules the run rather than failing it. The four `no_capacity` reasons are a closed set: `acquire_timeout`, `spend_cap`, `pool_disabled`, `driver_error`.

Growth is reservation-based and single-flight. The pool increments a reservation counter synchronously before any provision `await`, so concurrent grows can never overshoot `max` (or `max_workers_per_issue`, when set). The reservation is released in a `finally` block.

A lease settles exactly once. `release('healthy')` keeps the worker warm; `fail(reason)` or `release('poison')` flags it for destruction and recycles it when the last lease returns. A release against a stale or already-destroyed worker is a no-op that never touches the in-flight count.

## Config reference

All keys live under `worker.worker_pool`. Write them in snake_case.

| Key                      | Default                                                                           | Meaning                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `enabled`                | `true` when a `worker.kind` profile is selected; otherwise must be set explicitly | Master switch. Disabling it drains the pool.                                                       |
| `driver`                 | `fake`                                                                            | Registered driver kind, or an out-of-tree module specifier.                                        |
| `min`                    | `0`                                                                               | Floor the reaper keeps warm. Never reaped below this.                                              |
| `max`                    | `1`                                                                               | Ceiling on total workers. Must be `>= min`.                                                        |
| `warm`                   | `1`                                                                               | Target idle workers the top-up maintains. Must be `<= max`.                                        |
| `max_in_flight`          | `1`                                                                               | Deprecated alias for `slotsPerMachine` (co-residence slots per machine).                           |
| `ttl_ms`                 | `3600000`                                                                         | Max worker lifetime. A `LEASED` worker past TTL is flagged; an idle one is reaped above `min`.     |
| `idle_reap_ms`           | `300000`                                                                          | Idle duration before a warm worker is eligible for reaping above `min`.                            |
| `acquire_timeout_ms`     | `30000`                                                                           | How long a parked waiter waits before `no_capacity:acquire_timeout`.                               |
| `reap_interval_ms`       | `15000`                                                                           | Reaper tick cadence.                                                                               |
| `stale_heartbeat_ms`     | `600000`                                                                          | Heartbeat staleness threshold.                                                                     |
| `drain_deadline_ms`      | `30000`                                                                           | How long drain waits for in-flight leases before force-destroying.                                 |
| `max_workers_per_issue`  | unset                                                                             | Per-issue fairness cap on concurrent workers.                                                      |
| `co_residence`           | unset                                                                             | Opt-in required for `slotsPerMachine > 1`.                                                         |
| `max_concurrent_tunnels` | unset                                                                             | Ceiling on concurrent reverse SSH tunnels, counted per distinct host (co-resident runs share one). |

### Co-residence

`max_in_flight` is deprecated. It parses into `slotsPerMachine`, the number of runs that may share one machine. Co-residence (`slotsPerMachine > 1`) requires both a runtime per-run-claim-enforcement capability (the MCP gateway re-checks each request's per-run scoped claim server-side, so co-resident runs sharing one host and one reverse tunnel cannot authorize against each other) and an explicit `co_residence: true` opt-in. The CLI enforces this with a post-construction gate; the pool and domain layers do not. If you raise `max_in_flight` without setting `co_residence`, startup fails loud.

### Spend caps

Keys under `worker.worker_pool.spend` cap paid machine usage.

| Key                      | Meaning                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `max_concurrent_workers` | Hard ceiling on live workers. Blocks growth, surfaced as `spend_cap`.       |
| `max_worker_seconds`     | Lifetime worker-seconds budget. Gates acquire entirely (`spend_cap`).       |
| `daily_worker_seconds`   | Per-UTC-day worker-seconds budget. Gates acquire, persisted across restart. |

Worker-seconds are billed per lease from its own acquire timestamp. The daily accumulator rolls on UTC day change and persists to a `spend.json` sidecar next to the ledger file (`dirname(ledgerPath)/spend.json`). Daily spend is recorded fire-and-forget on the hot path; only a clean drain flushes the absolute total, so a crash can lose the last few unpersisted deltas.

## The reaper

A single serial reaper runs every `reap_interval_ms`. A `WeakSet` in-progress guard prevents overlapping ticks. Each tick is five phases over the inventory, with every per-worker mutation inside a per-worker mutex:

1. **Reconcile with `driver.list()`.** Destroy pool-owned machines the driver reports but the pool does not know (gated on the pool being hydrated). Mark registered workers the driver no longer lists as `DESTROYED`.
2. **Reap orphans.** Destroy machines carrying the pool ownership label that no record claims.
3. **Reap TTL and idle.** Flag `LEASED` workers past `ttl_ms`. Reap idle workers above `min`, oldest-idle-first.
4. **Probe and demote.** Probe every warm idle worker; demote a failing one to `DEGRADED`, then destroy it.
5. **Top up.** Provision toward `max(min, warm)` within the spend budget.

The reaper never force-returns a `LEASED` worker. A long single-turn run with no heartbeat is never killed mid-flight. Cross-restart orphans are recovered only by hydrate (below), not by the reaper aborting active leases.

## Ledger and crash recovery

For drivers that mark `usesLedger` (cloud and disposable backends), the pool keeps a write-ahead JSON ledger. It writes a provisional row before each provision and correlates the real worker after. Writes are atomic (temp file plus rename). The ledger is inert with zero filesystem I/O unless both the driver's `usesLedger` capability is true and a `ledgerPath` is supplied, so `fake` and `static-ssh` never touch disk.

On startup the pool calls `hydrate()`. It:

- Seeds daily spend from `spend.json`.
- Re-adopts every machine carrying the pool ownership label that `driver.list()` reports, as `WARM_IDLE`.
- Drops orphan ledger rows, keeping provisional rows younger than `ttl_ms`.

`driver.list()` is retried up to 3 times with backoff. A paid driver (one with `usesLedger` or `ephemeral`) that still cannot list throws `worker_pool_hydrate_failed` and fails the daemon startup loud, so a crash never leaks paid machines behind a blind pool. A non-paid driver returns null and proceeds with `hydrated=false`.

## Drain on reload and shutdown

Disabling the pool or shutting the daemon down calls `drain()`. Drain is idempotent, terminal, and awaitable. It stops the reaper, rejects new acquires and parked waiters, awaits the in-flight count reaching zero up to `drain_deadline_ms`, then force-destroys every worker inside the per-worker mutex so no paid machine leaks.

A workflow hot-reload that re-enables the pool bumps an internal drain epoch, so an orphaned drain from the old configuration bails out without destroying the re-enabled pool's workers. Driver hot-reload (`swapDriver`) is transactional: the pool resolves the new driver and builds a fresh ledger into locals first (a failure mutates nothing), captures the origin driver on every existing record, recycles idle workers on their origin backend, then commits. In-flight grows that captured a stale driver generation route their teardown to the origin driver so no paid worker is orphaned across the swap.

## Built-in drivers

The pool resolves `driver` through a registry keyed on driver kind.

| Kind         | Package                    | SSH-addressable | Ephemeral | Ledger | Notes                                                                                          |
| ------------ | -------------------------- | --------------- | --------- | ------ | ---------------------------------------------------------------------------------------------- |
| `fake`       | `@lorenz/worker-sdk`       | no              | no        | no     | In-memory. `workerHost` is `fake://worker-<id>`. For tests and dry runs.                       |
| `static-ssh` | `@lorenz/static-worker`    | yes             | no        | no     | Round-robins a fixed `ssh_hosts` list. `destroy` forgets the address, never deletes a machine. |
| `docker`     | `extensions/docker-worker` | yes             | yes       | yes    | Disposable containers via `docker run -d`. `destroy` is `docker rm -f`.                        |

The `static-ssh` driver requires an `ssh_hosts` (or `ssh_hosts`) option, else it throws `static_ssh_hosts_required` at construction. The `docker` driver requires an `image`, else `docker_image_required`. See [Docker workers](./docker.md) for that driver's full setup.

Drivers can also load out-of-tree by module specifier with an SDK-version handshake, so a custom backend ships without touching the pool engine. See [out-of-tree drivers](../extensions/out-of-tree.md) and the [worker driver contract](../extensions/worker-driver.md).

## Audit events

The pool emits structured events for every lifecycle decision. Watch these in [observability](../observability.md):

- Driver loading: `worker_pool_driver_loaded`, `worker_pool_driver_module_pinned`.
- Provision and probe: `worker_pool_provision_failed`, `worker_pool_warm_provision_failed`, `worker_pool_worker_unready`, `worker_pool_probe_failed`, `worker_pool_degraded`.
- Reaper and reconcile: `worker_pool_list_failed`, `worker_pool_reconcile_destroy_unknown`, `worker_pool_reconcile_missing`, `worker_pool_orphan_reaped`, `worker_pool_topup_budget_blocked`, `worker_pool_reaper_failed`, `worker_pool_destroy_failed`.
- Hydrate: `worker_pool_hydrate_failed`, `worker_pool_hydrate_list_failed`, `worker_pool_hydrate_orphan_dropped`.
- Ledger and callbacks: `worker_pool_ledger_write_failed`, `worker_pool_recycling_callback_failed`, `worker_pool_capacity_callback_failed`, `worker_pool_endpoint_release_failed`.

Driver resolution and out-of-tree loading throw fail-loud errors at startup: `worker_pool_driver_unavailable` (unknown kind), `worker_pool_driver_module_invalid`, `worker_pool_driver_sdk_mismatch`, and `worker_pool_driver_invalid_specifier`. See the full list in the [events reference](../reference/events.md).

## See also

- [Workers overview](./index.md) - how workers fit the run lifecycle
- [Static SSH workers](./static-ssh.md) - the legacy `worker.ssh_hosts` path and the `static-ssh` driver
- [Docker workers](./docker.md) - the disposable-container driver
- [Worker driver contract](../extensions/worker-driver.md) - building your own driver
- [Out-of-tree drivers](../extensions/out-of-tree.md) - loading a driver by module specifier
- [Configuration reference](../reference/configuration.md) - every `worker.worker_pool` key in one table
