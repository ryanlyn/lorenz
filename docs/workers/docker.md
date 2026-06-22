# Docker worker driver

The `docker` worker driver boots disposable local containers as SSH-addressable workers. Point the warm worker pool at a Docker image that runs `sshd`, and the pool provisions, probes, leases, and tears down containers on the local Docker daemon. This page is for operators configuring local or test runs. The driver does not provision cloud machines and is not meant for production scale-out.

The driver ships in `extensions/docker-worker` (package `@lorenz/docker-worker`) and registers under the kind `docker`. The composition root registers it at daemon startup, so no extra wiring is needed to use it.

## When to use it

Reach for the `docker` driver when you want SSH workers with a real provision/destroy lifecycle but no cloud account:

- Local development of workflows that run agents on a remote worker rather than in-process.
- Live and end-to-end tests that need disposable, reproducible SSH hosts the test can throw away.
- Exercising the warm pool's lease, reap, ledger, and crash-recovery paths against a driver that actually creates and removes machines.

Use a different backend when:

- You have fixed, long-lived SSH hosts you manage yourself. Use the [`static-ssh` driver](static-ssh.md) (or the legacy `worker.ssh_hosts` path).
- You need machines on a cloud provider. Bring an [out-of-tree worker driver](../extensions/out-of-tree.md); the `docker` driver only talks to the local Docker daemon.

The `docker` driver is a dev/test convenience. Every container is a local resource the pool must clean up, and the driver is built so a fault never leaks a running container.

## What it provisions

On each `provision`, the driver runs `docker run -d` of the configured `image`, publishing the container's sshd port (`22`) to an auto-assigned loopback host port:

```sh
docker run -d -p 127.0.0.1::22 \
  --label lorenz.worker-pool= \
  --label lorenz.worker-id=<workerId> \
  [--label <caller label>...] \
  <image>
```

The resulting worker host is `<user>@127.0.0.1:<hostPort>`, where `<hostPort>` is the loopback port Docker assigned, read back via `docker port <containerId> 22`. The port binds to `127.0.0.1`, so containers are reachable only from the host running the daemon.

Two Docker labels identify pool-owned containers:

| Label | Value | Purpose |
| --- | --- | --- |
| `lorenz.worker-pool` | empty | Marks the container as pool-owned. `list` filters on it so unrelated containers are never adopted or removed. |
| `lorenz.worker-id` | the pool's `workerId` | The idempotency key. A second `provision` of the same `workerId` adopts the surviving container instead of launching a duplicate. |

The driver's `list` output also surfaces the pool's `POOL_OWNED_LABEL` (`lorenz.pool=worker-pool`) so the pool's hydrate and reconcile ownership gate can re-adopt or clean up survivors after a restart.

## Lifecycle operations

The pool drives the driver through four operations:

- **`provision`** runs `docker run -d` as above, then resolves the published port. Idempotency is keyed on the `lorenz.worker-id` label on the live daemon: an existing labelled container is adopted with no new `docker run`. If resolving the port fails after the container is created, the driver runs `docker rm -f` to remove it before rethrowing, so a post-create fault never leaks a paid container.
- **`probe`** runs `printf ready` over SSH against the published `workerHost`. A non-zero exit or transport error returns an unhealthy result rather than throwing, so the reaper can demote an unreachable container. Every provisioned worker is probed before it enters the pool's inventory.
- **`destroy`** runs `docker rm -f <containerId>`. It is idempotent: a `No such container` exit is tolerated. Any other non-zero exit throws `docker_rm_failed` so the reaper retries.
- **`list`** runs `docker ps --filter label=lorenz.worker-pool`, parsing the worker id and published port from each row. Unlabelled containers are never returned.

## Capabilities

The driver reports `{ sshAddressable: true, ephemeral: true, usesLedger: true }`:

| Capability | Value | What it means |
| --- | --- | --- |
| `sshAddressable` | `true` | Workers are reachable over SSH at `<user>@127.0.0.1:<port>`; agent runs execute there. |
| `ephemeral` | `true` | Containers are disposable. The pool destroys them on ttl, idle, drain, and recycle. |
| `usesLedger` | `true` | The pool keeps a write-ahead ledger so it can recover surviving containers across a daemon restart by label. |

Because `usesLedger` is `true`, the pool persists a write-ahead ledger (and a `spend.json` sidecar) when a `ledgerPath` is configured. A `docker` pool that cannot `list` on startup fails loud with `worker_pool_hydrate_failed` rather than silently losing track of running containers. See [The worker pool](worker-pool.md) for the full lease, reap, ledger, and drain behavior.

## Configuration

The `docker` driver requires an `image` option, so configure it through a named worker profile under `workers.<name>` and select that profile with `worker.kind`. The `worker.worker_pool` block carries the pool's sizing and lifecycle knobs; the `workers.<name>` block carries the driver kind and its options.

```yaml
worker:
  kind: docker
  worker_pool:
    min: 0
    max: 2
    warm: 1

workers:
  docker:
    driver: docker
    image: lorenz/worker:latest
    ssh_user: root
```

Driver options:

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `image` | yes | none | The Docker image to run. Must run `sshd` on port `22`. Missing `image` throws `docker_image_required`. |
| `user` / `sshUser` / `ssh_user` | no | `root` | The SSH user in the worker host string. The first of these keys that is set wins. |

Keys in `workers.<name>` other than `driver` pass to the driver verbatim, so the option set is exactly what the driver reads. Selecting `worker.kind: docker` cannot be combined with `worker.worker_pool.driver` (the two driver selectors conflict), and the pool path cannot be combined with the legacy `worker.ssh_hosts` list.

The pool's own settings (`worker.worker_pool.min` / `max` / `warm`, `ttl_ms`, `idle_reap_ms`, `acquire_timeout_ms`, `reap_interval_ms`, `drain_deadline_ms`, and the `spend` caps) apply unchanged with the `docker` driver. Their defaults and meanings are in the [configuration reference](../reference/configuration.md) and [The worker pool](worker-pool.md).

## Requirements and errors

- The `docker` binary must be on `PATH`. If it is missing, the driver throws `docker_not_found` and the daemon fails loud at startup.
- A non-zero `docker run` exit throws `docker_run_failed`. A failure resolving the published port throws `docker_port_failed` or `docker_port_unresolved`, and the container is force-removed before the error propagates.
- The image must run an SSH server on port `22` and accept the configured `user`. Probes (`printf ready`) and agent runs both connect over SSH. An image without a reachable `sshd` fails the readiness probe and is destroyed.

## See also

- [The worker pool](worker-pool.md) - the lease, reap, ledger, spend-cap, and drain engine that drives this driver.
- [Static SSH workers](static-ssh.md) - the fixed-host driver for SSH machines you manage yourself.
- [Out-of-tree worker drivers](../extensions/out-of-tree.md) - load a cloud or custom driver by module specifier.
- [Worker driver extension contract](../extensions/worker-driver.md) - the `WorkerDriver` interface every driver implements.
- [Configuration reference](../reference/configuration.md) - every `worker` and `worker_pool` key with its default.
