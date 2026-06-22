# Features

A catalog of the capabilities you turn on in `WORKFLOW.md` to shape how Lorenz dispatches, runs, and recovers agent runs. This page is for operators: each card states what the feature buys you, the exact config to enable it, and where to read the full detail. Config keys are the snake_case keys you write in the front matter of `WORKFLOW.md`.

Everything below is opt-in through the YAML front matter of a single repository-owned `WORKFLOW.md`. The runtime re-reads that file before each poll, so most of these switches take effect without a restart. See [workflow hot-reload](workflow-hot-reload.md) for the exceptions.

## Context ensembles

Run several independent agents on the same issue and pick the best result. Each issue gets `agent.ensemble_size` parallel slots; an agent claims one slot, and the slots are tracked independently so one stall or failure does not sink the others.

Set the fleet-wide default in front matter, or override per issue with an `ensemble:<n>` label on the tracker issue:

```yaml
agent:
  ensemble_size: 3
```

The default is `1` (no ensemble). A valid `ensemble:<n>` label on an issue wins over the config default. Slot keys are `${issueId}:${slotIndex}`, and retries reclaim the same slot index for affinity.

See [agent-orchestrator.md](../agent-orchestrator.md) for slot accounting and [dispatch.md](../dispatch.md) for slot selection.

## Dispatch routing

Make one tracker feed many Lorenz instances without double-dispatch. Route labels gate which instance owns an issue: a label whose text starts with `tracker.dispatch.route_label_prefix` (default `Lorenz:`, trailing colon included) marks an issue for a named route, and each instance accepts only the routes you list.

```yaml
trackers:
  linear:
    dispatch:
      route_label_prefix: "Lorenz:"
      only_routes: ["backend"]
      accept_unrouted: false
```

`only_routes` defaults to `null` (accept any routed issue) and `accept_unrouted` defaults to `true` (accept issues with no route label). An issue assigned away from this worker (`assignedToWorker === false`) is never routed here, regardless of labels.

See [dispatch.md](../dispatch.md) for the full routing decision and the eligibility chain.

## Per-state concurrency

Cap how many agents run at once, globally and per tracker state. The global cap is `agent.max_concurrent_agents`; `status_overrides` then lets a specific state carry its own cap and even its own agent settings. Reserved slots (those mid-acquire on the worker pool) count toward every cap, so a burst of acquires cannot exceed the limit.

```yaml
agent:
  max_concurrent_agents: 10
status_overrides:
  "In Review":
    agent:
      max_concurrent_agents: 2
```

The global default is `10`. State keys in `status_overrides` are matched after trim and lowercase, so `"In Review"` and `"in review"` are the same key. A per-state override can change the agent kind and retry backoff for that state, but it cannot switch the executor or retarget skills.

This capability has no dedicated page of its own; [dispatch.md](../dispatch.md) is its home, covering cap precedence (global, then per-state, then per-host), and [agent-orchestrator.md](../agent-orchestrator.md) covers how reserved slots are counted.

## Run history

Watch what each agent is doing and what it did, with no database to run. The runtime keeps the last 20 events and the last 50 run-history entries in memory and merges them into one `RuntimeSnapshot` that feeds the TUI, the web dashboard, and the HTTP API. Run-history outcomes are `success`, `failed`, and `stalled`.

The dashboard and snapshot surface are on by default:

```yaml
observability:
  dashboard_enabled: true
  refresh_ms: 1000
server:
  host: 127.0.0.1
  port: 4040
```

There is no persisted store: history is a bounded in-memory ring buffer, and restart recovery is tracker-driven and filesystem-driven rather than replayed from a log. For a durable record, point `logging.log_file` at a path (default `~/.lorenz/log/lorenz.log`) to append structured JSON events.

See [observability.md](../observability.md) for the dashboards and [reference/events.md](../reference/events.md) for the event vocabulary.

## Secret resolution

Keep API keys out of `WORKFLOW.md`. Any string config value can be a secret reference, resolved at parse time in a fixed order: an exact `$VAR` is replaced by the environment variable, then a per-tracker environment fallback fills an empty value, then any `op://` reference is read through the 1Password CLI.

```yaml
trackers:
  linear:
    provider: linear
    api_key: $LINEAR_API_KEY
  jira:
    provider: jira
    api_key: "op://Vault/Jira/api-token"
```

`$VAR` substitution is whole-value only: it matches the entire field, not a substring. An `op://` value shells out to `op read`, so the `op` CLI must be on `PATH`. Linear falls back to `LINEAR_API_KEY` (and `LINEAR_ASSIGNEE`); Jira falls back to `JIRA_API_KEY`.

See [security.md](../security.md) for the trust boundary and [reference/configuration.md](../reference/configuration.md) for the resolution rules.

## Workflow hot-reload

Edit dispatch behavior on a live daemon. The runtime re-reads `WORKFLOW.md` before each poll, compares a content stamp (mtime, size, sha256), and applies a changed file transactionally: it runs the validation gate and the worker-pool reconcile first, and swaps in the new settings only if both succeed. A failed reload keeps the last-good settings and emits `workflow_reload_failed`.

Hot-reload is automatic when the runtime is given a reload function; there is no config key to flip. The behaviors it governs:

- Editing `WORKFLOW.md` in place is picked up on the next poll (cadence `polling.interval_ms`, default `30000`).
- A parse or validation error leaves the running config untouched and surfaces `workflow_reload_failed`; a clean reload emits `workflow_reloaded`.
- Raising `worker.worker_pool.max_in_flight` past the co-residence gate is re-checked on reload, so a live edit cannot widen the blast radius the startup gate already rejected.

See [workflows.md](../workflows.md) for authoring the file and [reference/configuration.md](../reference/configuration.md) for every key.

## Remote workers

Run agents on machines other than the one hosting the daemon. Two mutually exclusive paths exist. The legacy static path shards runs across a fixed list of pre-existing SSH destinations with no provisioning. The warm worker pool leases, grows, and reaps machines through a swappable driver, with spend caps and crash recovery.

Static SSH hosts:

```yaml
worker:
  ssh_hosts: ["build-1.internal", "build-2.internal"]
  max_concurrent_agents_per_host: 2
```

Warm pool with a driver:

```yaml
worker:
  kind: docker
  worker_pool:
    min: 0
    max: 4
    warm: 1
workers:
  docker:
    driver: docker
    image: lorenz/worker:latest
```

You cannot combine `worker.ssh_hosts` with `worker.worker_pool` or `worker.kind`; the parser rejects it. The pool driver defaults to `fake` when a pool is present but no driver is named. `fake` is the in-memory default; the production built-ins are `static-ssh` and `docker`. Out-of-tree drivers load by module specifier.

This capability has no dedicated page of its own; [workers/index.md](../workers/index.md) is its home, covering the two paths, alongside [workers/static-ssh.md](../workers/static-ssh.md), [workers/worker-pool.md](../workers/worker-pool.md), and [workers/docker.md](../workers/docker.md).

## See also
- [dispatch.md](../dispatch.md) - the eligibility chain, routing, and concurrency caps in full
- [agent-orchestrator.md](../agent-orchestrator.md) - the poll/reconcile loop and in-memory scheduling state
- [workflows.md](../workflows.md) - authoring `WORKFLOW.md` front matter and prompt body
- [reference/configuration.md](../reference/configuration.md) - every config key, default, and meaning
- [workers/index.md](../workers/index.md) - static SSH hosts versus the warm worker pool
