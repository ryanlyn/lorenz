# Durable Claims and Daemon Control

Lorenz keeps the in-memory claim store as the default. Durable claim persistence is an
explicit operator choice made at daemon startup, and daemon control is exposed through the
local observability server when that server is enabled.

## Claim Store Backends

The daemon accepts three claim-store backends:

| Backend | Selection | Persistence | Process sharing | Retry durability |
| --- | --- | --- | --- | --- |
| `memory` | default | process lifetime only | no | no |
| `sqlite` | explicit | local SQLite file | same host | yes |
| `turso` | explicit | Turso SQLite-compatible file | same host with multiprocess WAL | yes |

Select a backend with `--claim-store <backend>` or `LORENZ_CLAIM_STORE`.

```sh
lorenz --claim-store memory WORKFLOW.md
lorenz --claim-store sqlite --claim-store-path .lorenz/claim-store/claims.db WORKFLOW.md
lorenz --claim-store turso --claim-store-path .lorenz/claim-store/claims.db WORKFLOW.md
```

When a durable backend is selected without `--claim-store-path` or
`LORENZ_CLAIM_STORE_PATH`, the daemon stores claims at:

```text
<workspace.root>/.lorenz/claim-store/<workflow-sha256>/claims.db
```

The workflow hash is derived from the canonical workflow file path. This keeps the default
durable store isolated when multiple workflow files share one workspace root. Operators who
want a shared store can still provide an explicit path.

The claim owner stale threshold defaults inside the orchestrator store. Override it with
`--claim-store-owner-stale-ms <ms>` or `LORENZ_CLAIM_STORE_OWNER_STALE_MS`.

## Schema Versioning

Durable stores create a `claim_store_meta` table and record `schema_version = 1`.
Startup rejects an unknown version instead of reading a schema it does not understand.

The current schema stores:

- one serialized checkpoint row for orchestrator state;
- a bounded event table for recent claim-store mutations;
- owner heartbeat rows used to distinguish live owners from stale owners.

## Runtime Responsibilities

`@lorenz/orchestrator` owns claim-state mutation. It accepts a claim store and serializes
claims, reservations, retry attempts, owner ids, and recovery metadata through that store.
It does not open files or choose a backend.

The CLI daemon is the composition root. It loads the workflow, chooses the backend, opens
the store, passes it to `LorenzRuntime`, and closes it during shutdown. This keeps backend
selection out of the pure dispatch state machine.

## Daemon Leadership

Long-running daemon startup acquires a local leadership lease before tracker polling,
worker-pool hydration, server startup, or runtime start. The lease is keyed by canonical
workflow path under:

```text
<workflow-directory>/.lorenz/daemon/<workflow-sha256>.lock.json
```

A second long-running daemon for the same workflow exits with `daemon_already_running`
and reports the owner pid and endpoint when available. `--once` remains an isolated
single-poll mode and does not acquire the long-lived daemon lease.

When the dashboard server is disabled, the lease records that no HTTP control endpoint is
published. `lorenz status` can still report the lease owner, while `lorenz refresh` and
`lorenz stop` need `--url` or `--port` for an external control endpoint.

The initial leadership store is local-file backed and same-host only. The interface is
generic so another provider can later supply the same acquire, read, heartbeat, stale,
and release operations.

## Control Endpoints

When the dashboard server is enabled, the daemon exposes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/daemon` | Return daemon owner, endpoint, heartbeat, workflow path, and leadership store kind |
| `POST` | `/api/v1/refresh` | Queue an immediate poll and reconcile pass |
| `POST` | `/api/v1/stop` | Request graceful daemon shutdown |

The same daemon status is included in `/api/v1/state` under `daemon`.

CLI attach commands use the daemon lock to discover the owner endpoint:

```sh
lorenz status WORKFLOW.md
lorenz refresh WORKFLOW.md
lorenz stop WORKFLOW.md
```

Each command also accepts `--url`, `--port`, and `--json`.

## Shutdown Order

On graceful shutdown the daemon stops the runtime, unmounts the TUI, drains the worker
pool, stops the server, closes the issue store, closes the claim store, and then releases
the leadership lease.

Forced process exit may leave a lock or claim owner heartbeat behind. Recovery treats
those records as live until their heartbeat is stale rather than assuming a missing local
process proves distributed ownership is gone.
