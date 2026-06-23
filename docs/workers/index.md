# Workers

Workers are where agent runs execute. This page is for operators choosing between running agents on the Lorenz host, sharding them across a fixed set of SSH machines, or leasing machines from a warm pool. It covers the config that selects each mode, how they are mutually exclusive, and how Lorenz spreads runs across hosts.

By default there is no worker config and every agent run executes locally on the machine running the `lorenz` daemon. You opt into remote execution by adding one of two blocks to your `WORKFLOW.md` front matter.

## The three execution modes

Lorenz resolves an SSH-addressable target for each run. Where that target comes from depends on which of three modes you configure.

|              | Local                                    | Static SSH hosts                                           | Warm worker pool                                                       |
| ------------ | ---------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| Config       | none (default)                           | `worker.ssh_hosts`                                         | `worker.worker_pool` or `worker.kind`                                  |
| Provisioning | none, runs on the daemon host            | none, you pre-create and maintain the hosts                | the pool leases, grows, and reaps machines through a driver            |
| Lifecycle    | n/a                                      | hosts are permanent; Lorenz never creates or destroys them | machines are warmed, leased, recycled, and torn down on TTL or idle    |
| Spend caps   | n/a                                      | none                                                       | `max_concurrent_workers`, `max_worker_seconds`, `daily_worker_seconds` |
| Drivers      | n/a                                      | n/a                                                        | `fake`, `static-ssh`, `docker`, or an out-of-tree module               |
| When to use  | single-host development, small workloads | you already run a stable fleet of build boxes              | you want elastic, billed capacity that grows and shrinks with demand   |

`worker.ssh_hosts` and `worker.worker_pool` are mutually exclusive. The config parser throws at startup if you combine them. It also rejects `worker.kind` set alongside `worker.ssh_hosts`, and `worker.kind` set alongside `worker.worker_pool.driver`.

```sh
worker.worker_pool.enabled cannot be combined with worker.ssh_hosts
worker.kind cannot be combined with worker.ssh_hosts
worker.kind cannot be combined with worker.worker_pool.driver
```

### Local (default)

With no `worker.ssh_hosts`, no `worker.worker_pool`, and no `worker.kind`, runs execute on the daemon host. Concurrency is bounded by `agent.max_concurrent_agents`. This is the path you get from a fresh `WORKFLOW.md`.

### Static SSH hosts

`worker.ssh_hosts` is a flat list of pre-existing SSH destinations the runtime shards runs across. Lorenz does not provision or tear these down; it only picks which host each run lands on. There is no spend accounting, no warming, and no driver.

```yaml
worker:
  ssh_hosts:
    - build-01.internal
    - build-02.internal
  ssh_timeout_ms: 60000
  max_concurrent_agents_per_host: 2
```

See [static-ssh.md](static-ssh.md) for host requirements, the `LORENZ_SSH_CONFIG` env override, and timeout behavior.

### Warm worker pool

The warm pool is a long-lived singleton that survives workflow reloads. It leases machines to runs, grows under demand, keeps a warm buffer ready, reaps idle and expired machines, and enforces spend caps. Every provision, probe, and teardown decision goes through a swappable `WorkerDriver`.

You configure the pool one of two ways. Set `worker.worker_pool.driver` directly:

```yaml
worker:
  worker_pool:
    enabled: true
    driver: docker
    min: 1
    max: 4
    warm: 2
```

A directly-configured `worker.worker_pool` block defaults `enabled` to `false`, so it must set `enabled: true` to build a live pool. Without it the pool resolves to disabled and no machines are leased.

Or select a named profile with `worker.kind`, which points at a top-level `workers.<name>` block:

```yaml
worker:
  kind: containers

workers:
  containers:
    driver: docker
    image: lorenz-worker:latest
```

When `worker.kind` is set, the matching `workers.<name>` entry supplies the driver and its options. Every key under that profile except `driver` is passed to the driver verbatim. A `worker.kind` that matches no `workers` entry throws `worker.kind "<name>" does not match any workers entry` at startup. Selecting a profile this way defaults `enabled` to `true`, so the pool runs without an explicit `enabled` key.

When `worker.worker_pool` is present but no driver is specified, the driver defaults to `fake` (an in-memory driver for tests, not a real backend). The built-in real drivers are `static-ssh` (a fixed host list fed into the pool lifecycle) and `docker` (disposable containers). Drivers can also load out-of-tree by module specifier.

Pool defaults, when the block is present:

| Key                                     | Default                                                        | Meaning                                                                                      |
| --------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `worker.worker_pool.enabled`            | `true` only when selected via `worker.kind`; otherwise `false` | turns the pool on; a directly-configured `worker.worker_pool` block must set `enabled: true` |
| `worker.worker_pool.driver`             | `fake`                                                         | which backend provisions machines                                                            |
| `worker.worker_pool.min`                | `0`                                                            | floor on live machines                                                                       |
| `worker.worker_pool.max`                | `1`                                                            | ceiling on live machines (must be `>= min`)                                                  |
| `worker.worker_pool.warm`               | `1`                                                            | machines kept ready ahead of demand (must be `<= max`)                                       |
| `worker.worker_pool.ttl_ms`             | `3600000`                                                      | max machine lifetime before reap                                                             |
| `worker.worker_pool.idle_reap_ms`       | `300000`                                                       | idle time before a machine above `min` is reaped                                             |
| `worker.worker_pool.acquire_timeout_ms` | `30000`                                                        | how long a run waits for a lease before giving up                                            |
| `worker.worker_pool.reap_interval_ms`   | `15000`                                                        | reaper tick cadence                                                                          |
| `worker.worker_pool.drain_deadline_ms`  | `30000`                                                        | grace window for in-flight leases during drain                                               |

Spend caps live under `worker.worker_pool.spend`:

| Key                      | Meaning                                                  |
| ------------------------ | -------------------------------------------------------- |
| `max_concurrent_workers` | blocks growth past this many live machines               |
| `max_worker_seconds`     | lifetime ceiling on total worker-seconds                 |
| `daily_worker_seconds`   | per-UTC-day ceiling, persisted to a `spend.json` sidecar |

A run that cannot get a lease is reported with one of a closed set of `no_capacity` reasons. See [worker-pool.md](worker-pool.md) for those reasons, the acquire path, and the full lifecycle, ledger, crash recovery, and spend model.

## Concurrency and host selection

For static SSH hosts, Lorenz tracks how many runs occupy each host and assigns the next run to the least-loaded host under its cap. The cap is `worker.max_concurrent_agents_per_host`; when unset it falls back to `agent.max_concurrent_agents`. When every host is at capacity, dispatch holds back the run and surfaces the `worker_host_capacity` signal until a slot frees.

The warm pool governs its own capacity. Its `acquire_timeout`, mapped onto the same `worker_host_capacity` dispatch signal, is what a waiting run sees when no machine is free within the wait window.

For co-residence (more than one run per machine), the parser writes an internal `slots_per_machine` field. The only config key that sets it is `worker.worker_pool.max_in_flight`, a deprecated alias; the schema is strict and rejects any other key. Running more than one run per machine requires both a runtime per-run-claim-enforcement capability (the MCP gateway re-checks each request's per-run scoped claim server-side) and an explicit `worker.worker_pool.co_residence: true` opt-in; the daemon enforces this gate after construction.

## Not the worker pool: reverse SSH tunnels

`@lorenz/worker-host-pool` is separate plumbing. It manages reverse SSH (MCP) tunnels - one `ssh -R` per worker host, shared by every co-resident run on that host - so a remote worker can reach back to the daemon, not the workers themselves. It is not a source of execution capacity. Do not confuse it with the warm worker pool in `@lorenz/worker-pool`.

## See also

- [static-ssh.md](static-ssh.md) - shard runs across a fixed SSH fleet with `worker.ssh_hosts`
- [worker-pool.md](worker-pool.md) - the warm pool lifecycle, spend caps, and crash recovery
- [docker.md](docker.md) - the `docker` driver for disposable container workers
- [../extensions/worker-driver.md](../extensions/worker-driver.md) - build a custom `WorkerDriver`
- [../reference/configuration.md](../reference/configuration.md) - every `worker` and `worker_pool` key with defaults
