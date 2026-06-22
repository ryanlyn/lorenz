# Static SSH workers

This page is for operators who already run a fixed set of machines and want Lorenz to dispatch agent runs onto them over SSH. It covers the `worker.ssh_hosts` path: a flat list of pre-existing SSH destinations that the runtime shards runs across, with no provisioning, no lifecycle, and no spend tracking.

Static SSH is the simplest way to run agents off the daemon host. You list the machines, Lorenz picks the least-loaded one for each run, and you keep owning the machines. If you instead want Lorenz to create and destroy ephemeral machines on demand, see the [worker pool](worker-pool.md) and the [Docker driver](docker.md).

## Two surfaces named "static SSH"

There are two distinct config shapes that both involve a fixed SSH host list. Pick one. They are mutually exclusive.

| Surface | Config | Who selects the host | Lifecycle |
| --- | --- | --- | --- |
| Legacy static path | `worker.ssh_hosts` | The runtime, least-loaded across the list | None. You own the machines. |
| `static-ssh` driver | `workers.<name>` with `driver: static-ssh`, option `ssh_hosts` | The [worker pool](worker-pool.md) engine | Pool leasing only. The driver never deletes a machine. |

This page documents the first surface: `worker.ssh_hosts`. The `static-ssh` driver is the same fixed-host idea wired into the pool's lease/reap machinery instead of the runtime's own host selection. Reach for it only when you want the pool's accounting around a fixed fleet; for plain "run on these N boxes" the legacy path is enough.

The config parser refuses to combine them. Setting `worker.ssh_hosts` alongside `worker.worker_pool.enabled` throws `worker.worker_pool.enabled cannot be combined with worker.ssh_hosts`, and combining it with `worker.kind` throws `worker.kind cannot be combined with worker.ssh_hosts`.

## When to use it

Use `worker.ssh_hosts` when:

- You already provision and maintain the machines (bare metal, long-lived VMs, a lab cluster).
- The fleet is fixed for a session. Hosts do not come and go while the daemon runs.
- You want to spread concurrent runs across boxes without standing up the pool, a driver, or spend caps.

With no hosts configured, runs happen on the daemon's local machine. The moment `worker.ssh_hosts` is non-empty, every run is sharded over SSH onto one of the listed destinations.

## Configuration

These keys live under `worker` in your `WORKFLOW.md` front matter.

| Key | Default | Meaning |
| --- | --- | --- |
| `worker.ssh_hosts` | `[]` (empty) | SSH destinations. Empty means run locally. |
| `worker.ssh_timeout_ms` | `60000` | Timeout in ms for the SSH commands it bounds: skill-overlay sync and host discovery probing. Workspace cleanup and remote hook execution use `hooks.timeout_ms` instead. |
| `worker.max_concurrent_agents_per_host` | falls back to `agent.max_concurrent_agents` | Per-host cap on concurrent runs. When every host is at this cap, dispatch waits instead of running locally. |

A minimal config:

```yaml
worker:
  ssh_hosts:
    - build-1
    - alice@build-2
    - alice@build-3:2222
  ssh_timeout_ms: 90000
  max_concurrent_agents_per_host: 2
```

### Host destination format

Each entry is a standard OpenSSH destination. All of these are valid:

- `host` - a bare hostname or a `Host` alias resolved from `~/.ssh/config`.
- `user@host` - destination with an explicit user.
- `user@host:2222` - destination with a non-standard port. The `:port` suffix is parsed off and passed to ssh as `-p 2222`.

Lorenz invokes the system `ssh` binary found on `PATH`. If no `ssh` executable is found it raises `ssh_not_found`. Each command runs through `bash -lc` on the remote, so the worker's login shell environment applies.

### Custom OpenSSH config with `LORENZ_SSH_CONFIG`

Set the `LORENZ_SSH_CONFIG` environment variable to point ssh at a config file other than `~/.ssh/config`. When set, Lorenz passes `-F <path>` to every ssh invocation. Use this to keep per-fleet `Host` aliases, jump hosts, identity files, and `ProxyCommand` settings out of your personal config:

```sh
export LORENZ_SSH_CONFIG=/etc/lorenz/ssh_config
```

Then a `worker.ssh_hosts` entry like `build-1` resolves through that file's `Host build-1` block (hostname, user, port, key). This keeps the host list short and pushes connection detail into standard OpenSSH config.

## How runs shard across hosts

For each run the runtime picks one host from `worker.ssh_hosts` by least current load:

1. It counts how many runs are currently in flight on each host.
2. If the run is a retry and its prior host still has room under the cap, that host is reused (retry affinity).
3. Otherwise it picks the host with the fewest in-flight runs that is still below the cap.
4. If every host is at the cap, no host is selected. Dispatch is skipped and surfaces the `worker_host_capacity` signal rather than falling back to local execution.

The per-host cap is `worker.max_concurrent_agents_per_host` when set, otherwise the global `agent.max_concurrent_agents`. So total fleet concurrency is roughly `cap x number_of_hosts`, bounded by the agent scheduler.

There is no provisioning, probing, or teardown of the machines themselves. The runtime opens SSH connections per command, runs the agent and its workspace hooks remotely, and cleans up the run's workspace over SSH when the run ends. The machines persist across runs and across daemon restarts because Lorenz never created them.

## Prerequisites

Before listing a host in `worker.ssh_hosts`, confirm:

- `ssh <destination> printf ready` succeeds from the daemon host with no password prompt. Static SSH assumes non-interactive key-based auth. Add the host key to `known_hosts` first so the first connection does not block on a prompt.
- The remote has the tools your agent and workspace hooks need (git, your language toolchain, the agent CLI if your executor runs remotely).
- The remote login shell (`bash -lc`) exports the `PATH` and environment your hooks expect.
- The daemon's `ssh` binary is on `PATH`. Check with `lorenz doctor`, which reports the configured host count.

## Worked example

A two-machine build fleet, reached through a custom ssh config that defines the aliases and a shared key.

`/etc/lorenz/ssh_config`:

```ssh-config
Host build-a
  HostName 10.0.0.11
  User ci
  IdentityFile /etc/lorenz/id_ed25519

Host build-b
  HostName 10.0.0.12
  User ci
  Port 2222
  IdentityFile /etc/lorenz/id_ed25519
```

`WORKFLOW.md` front matter:

```yaml
worker:
  ssh_hosts:
    - build-a
    - build-b
  ssh_timeout_ms: 120000
  max_concurrent_agents_per_host: 3
```

Run the daemon with the config exported:

```sh
export LORENZ_SSH_CONFIG=/etc/lorenz/ssh_config
lorenz WORKFLOW.md
```

With this config Lorenz can run up to six agents at once (three per host across two hosts). Each run is sharded onto whichever of `build-a` or `build-b` has the fewest in-flight runs. A retried run prefers the host it last ran on. When both hosts hold three runs, new dispatches wait and the dashboard shows `worker_host_capacity`.

## Failure modes

| Symptom | Likely cause |
| --- | --- |
| `ssh_not_found` | No `ssh` on the daemon's `PATH`. |
| `ssh_timeout` | A command exceeded `worker.ssh_timeout_ms`. On timeout Lorenz sends `SIGTERM`, then `SIGKILL` after 5 seconds, to the whole remote process group. |
| `invalid_ssh_destination` | A host entry is empty or starts with `-`. |
| Runs never leave local execution | `worker.ssh_hosts` is empty, or a parse error rejected the combination with `worker.kind` or `worker.worker_pool`. |
| Dispatch stalls with `worker_host_capacity` | Every host is at `max_concurrent_agents_per_host`. Raise the cap or add hosts. |

## See also

- [Workers overview](index.md) - how the worker layer produces each run's host.
- [Worker pool](worker-pool.md) - warm pool that provisions and reaps machines for you.
- [Docker driver](docker.md) - disposable containers as ephemeral workers.
- [Configuration reference](../reference/configuration.md) - every `worker.*` key, default, and constraint.
- [Troubleshooting](../troubleshooting.md) - diagnosing dispatch and SSH failures.
