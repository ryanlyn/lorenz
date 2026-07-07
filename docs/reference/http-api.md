# HTTP and WebSocket API

The observability server exposes the Lorenz runtime's live state over HTTP, a `/ws` WebSocket push transport, and an MCP mount. This page is the integrator's contract: every route, its parameters, its response shape, its status codes. Payloads are snake_case JSON produced by the presenter. The internal runtime snapshot is camelCase, but nothing on the wire is.

The server is a Hono app started by `startObservabilityServer(runtime, options)` in `packages/server/src/index.ts`. The CLI starts it when the dashboard is enabled (see [the CLI reference](cli.md)). It binds `server.host` (default `127.0.0.1`) and `server.port` (default `4040`; `0` selects an ephemeral port that is written back into settings after bind). All bodies use `content-type: application/json; charset=utf-8`, except `GET /`, which returns `text/html`.

## Conventions

- **Error shape.** Every error response is `{"error": {"code": "<code>", "message": "<text>"}}`. The full code list is in the [status code reference](#status-codes) below.
- **Method fallback.** Each concrete route registers an `app.all(...)` fallback that returns `405 method_not_allowed` for the wrong verb. An unknown path returns `404 not_found` ("Route not found").
- **Snapshot reads.** State-bearing routes call `runtime.snapshot()`. If that throws, the error code maps to `snapshot_timeout` (when the underlying code or message is `snapshot_timeout` / `timeout`) or `snapshot_unavailable` (everything else). Each route handles that failure its own way, documented per route.
- **Path parameters** are percent-decoded with `decodeURIComponent`. Malformed encoding returns `400 invalid_path_parameter` ("Malformed percent encoding in path parameter").
- **Route order.** Trace routes and `/api/v1/state|runs|refresh|daemon|stop` register before the catch-all `GET /api/v1/:identifier`, so a literal path like `/api/v1/tickets` never falls into the identifier route.

## REST routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness check |
| `GET` | `/` | Dashboard SPA (`index.html`) |
| `GET` | `/assets/*` | Built dashboard static assets |
| `GET` | `/api/v1/state` | Live ops state (running / retrying / blocked) |
| `GET` | `/api/v1/runs` | Run list and run views |
| `POST` | `/api/v1/refresh` | Queue an out-of-band poll + reconcile |
| `GET` | `/api/v1/daemon` | Daemon owner, endpoint, heartbeat, and leadership status |
| `POST` | `/api/v1/stop` | Request graceful daemon shutdown |
| `GET` | `/api/v1/:issue_identifier` | Detail for one in-flight issue |
| `GET` | `/api/v1/issues/recent` | Recent issues from the issue store |
| `GET` | `/api/v1/issues/search` | Search issues by query |
| `GET` | `/api/v1/tickets` | Trace tickets with metadata |
| `GET` | `/api/v1/tickets/:id/exists` | Whether a trace ticket exists |
| `GET` | `/api/v1/tickets/:id/events` | Parsed trace events for a ticket |
| `GET` | `/ws` | WebSocket upgrade (push transport) |
| `POST` | `/mcp` | MCP endpoint for workflow tool packs |

The `/api/v1/issues/*` and `/api/v1/tickets/*` routes exist only when the server is started with both `traceDir` and an `issueStore`. Without them, those paths return `404 not_found`, and `/ws` accepts connections but ignores `subscribe` messages.

### GET /health

Returns `200` with `{"status": "ok"}`. No snapshot read; always available while the process is listening.

### GET /

Serves `<staticDir>/index.html`. When the file is missing (the dashboard was not built), returns `503` with code `dashboard_not_built` and message `Dashboard assets not found. Run: pnpm build`. `staticDir` defaults to the `apps/web/dist` directory bundled with the server build; override it with the `staticDir` option. Hashed assets are served from `/assets/*`.

### GET /api/v1/state

The live ops snapshot used by the dashboard Overview. On success returns `200` with an `OpsStatePayload`:

```json
{
  "generated_at": "2026-06-17T12:00:00.000Z",
  "counts": { "running": 2, "retrying": 1, "blocked": 0 },
  "blocked_by_reason": { "global_concurrency_cap": 0 },
  "running": [ /* RunningEntryPayload[] */ ],
  "retrying": [ /* RetryEntryPayload[] */ ],
  "blocked": [ /* BlockedEntryPayload[] */ ],
  "usage_totals": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0,
    "seconds_running": 0
  },
  "rate_limits": null,
  "claim_store": {
    "kind": "memory",
    "owner_id": "memory:12345:1",
    "capabilities": {
      "crash_recovery": false,
      "shared_across_processes": false,
      "retry_durability": false
    },
    "hydrated_at": "2026-06-17T12:00:00.000Z",
    "transactions_applied": 0,
    "last_operation": null,
    "last_checkpoint_at": null
  },
  "daemon": null
}
```

This route does not fail with `503` on a snapshot error. It returns `200` with a degraded body carrying only `generated_at` and `error`:

```json
{
  "generated_at": "2026-06-17T12:00:00.000Z",
  "error": { "code": "snapshot_unavailable", "message": "Snapshot unavailable" }
}
```

The `error.code` is `snapshot_timeout` ("Snapshot timed out") or `snapshot_unavailable` ("Snapshot unavailable").

Each `RunningEntryPayload` has: `issue_id`, `issue_identifier`, `issue_url`, `state`, `slot_index`, `ensemble_size`, `worker_host`, `workspace_path`, `session_id`, `turn_count`, `agent_kind`, `executor_pid`, `usage_totals`, `last_event`, `last_message`, `started_at`, `last_event_at`, `tokens`.

Each `RetryEntryPayload` has: `issue_id`, `issue_identifier`, `issue_url`, `attempt`, `due_at`, `error`, `worker_host`, `workspace_path`.

Each `BlockedEntryPayload` has: `issue_id`, `issue_identifier`, `issue_url`, `state`, `reason`, `label`, `worker_host`. The `reason` is the raw enum (`global_concurrency_cap`, `local_concurrency_cap`, `worker_host_capacity`); `label` is the human form (`global concurrency cap`, `local state concurrency cap`, `worker host capacity`).

`tokens` is `{input_tokens, output_tokens, total_tokens}`. `usage_totals` adds `seconds_running`.

`claim_store` reports the runtime-owned orchestrator's claim-store status. The default in-memory
store reports `kind: "memory"` with all durability capabilities set to `false`. Durable stores use
the same shape with their own `kind`, `owner_id`, `capabilities`, `hydrated_at`,
`transactions_applied`, `last_operation`, and `last_checkpoint_at`. The field is `null` only when
the mounted runtime source has no claim-store status.

`daemon` is `null` when the runtime source has no daemon status. Long-running CLI daemons report
`owner_id`, `pid`, `hostname`, `started_at`, `workflow_path`, `workspace_root`, `lock_path`,
`endpoint`, `heartbeat_at`, `heartbeat_age_ms`, `stale`, and `leadership_store_kind`.

### GET /api/v1/runs

Returns running entries plus the run history (capped at the last 50). The response `view` field switches on query parameters.

| Param | Type | Effect |
| --- | --- | --- |
| `issue` | string | Keep runs whose `issue_identifier` or `issue_id` exactly matches |
| `failed` | flag | Keep runs with outcome `failed` or `stalled` |
| `cost` | flag | Return the `cost` view (token totals; dollar fields are `null`) |
| `retries` | flag | Return the `retries` view (issues with retry attempts) |
| `id` | string | Return the `run` view for that run id |
| `limit` | int | List size, default `20`, clamped to `200` |

Flag params are truthy for `true`, `1`, `yes`, or `on`. `cost` is checked before `retries`, then `id`; with none set, the response is the default `runs` list view.

Default (`view: "runs"`):

```json
{
  "generated_at": "2026-06-17T12:00:00.000Z",
  "view": "runs",
  "summary": { "total": 3, "running": 1, "success": 2, "failed": 0, "stalled": 0, "canceled": 0 },
  "runs": [ /* RunPayload[], sliced to limit */ ]
}
```

Each `RunPayload` carries: `id`, `issue_id`, `issue_identifier`, `issue_title`, `state`, `slot_index`, `ensemble_size`, `agent_kind`, `outcome`, `retry_attempt`, `worker_host`, `workspace_path`, `session_id`, `executor_pid`, `usage_totals`, `turn_count`, `failure_reason`, `last_event`, `last_message`, `last_event_at`, `started_at`, `ended_at`, `duration_ms`, `cost`, `tokens`, and `log_hints`.

- `outcome` is `running` for live entries, or one of `success`, `failed`, `stalled`, `canceled` for history.
- `id` for a running entry is its `runId`, falling back to `running-<issue_identifier>-<slot_index>`.
- `cost.estimated_cost_usd` is always `null`; dollar cost is not computed. `tokens` carries the real token counts.
- `log_hints` is `{lorenz_log_file, workspace_path, session_id, issue_identifier}`, pointing at where to find the [trace](../observability.md) and log output.

The `run` view (`?id=<run-id>`) returns `{generated_at, view: "run", run, related_runs}`, where `related_runs` is up to 10 other runs sharing the same `issue_id`. An unknown id returns `404 run_not_found` ("Run not found"). An empty `id` (`?id=`) falls through to the list view.

The `cost` view returns `{generated_at, view: "cost", summary}` with per-agent token breakdowns and `top_runs` (top 10 by total tokens). The `retries` view returns `{generated_at, view: "retries", issues}` listing issues that have a non-zero retry attempt.

On a snapshot error this route returns `503` with code `snapshot_timeout` or `snapshot_unavailable`.

### POST /api/v1/refresh

Queues an immediate poll and reconcile pass rather than waiting for the next scheduled poll. Requires `Authorization: Bearer <control-token>`. On success returns `202`:

```json
{
  "requested_at": "2026-06-17T12:00:00.000Z",
  "queued": true,
  "coalesced": false,
  "operations": ["poll", "reconcile"]
}
```

`coalesced` is `true` when a poll is already in flight; no new poll starts. If the runtime cannot accept the request, returns `503 orchestrator_unavailable` ("Orchestrator is unavailable"). If the bearer token is missing or invalid, returns `401 unauthorized`.

### GET /api/v1/daemon

Returns daemon leadership status for a long-running CLI daemon:

```json
{
  "owner_id": "hostname:12345:abcdef",
  "pid": 12345,
  "hostname": "hostname",
  "started_at": "2026-06-17T12:00:00.000Z",
  "workflow_path": "/repo/WORKFLOW.md",
  "workspace_root": "/repo",
  "lock_path": "/repo/.lorenz/daemon/<workflow-sha256>.lock.json",
  "endpoint": { "kind": "http", "address": "http://127.0.0.1:4040/" },
  "heartbeat_at": "2026-06-17T12:00:10.000Z",
  "heartbeat_age_ms": 25,
  "stale": false,
  "leadership_store_kind": "local-file"
}
```

If daemon status is unavailable, returns `503 daemon_status_unavailable` ("Daemon status
unavailable"). This can happen when a non-daemon runtime source is mounted into the observability
server.

### POST /api/v1/stop

Requests a graceful daemon shutdown. Requires `Authorization: Bearer <control-token>`. On success returns `202`:

```json
{
  "requested_at": "2026-06-17T12:00:00.000Z",
  "stopping": true
}
```

If the mounted runtime source does not expose stop control, returns
`503 daemon_control_unavailable` ("Daemon control unavailable"). If the bearer token is missing or invalid, returns `401 unauthorized`.

### GET /api/v1/:issue_identifier

Detail for a single in-flight issue, matched by `issue_identifier` against the running and retrying sets. The path segment is percent-decoded; malformed encoding returns `400 invalid_path_parameter`.

On success returns `200`:

```json
{
  "issue_identifier": "ENG-123",
  "issue_id": "abc",
  "status": "running",
  "workspace": { "path": "/tmp/ws", "host": null },
  "attempts": { "restart_count": 0, "current_retry_attempt": 0 },
  "running": { /* slot detail, or null */ },
  "retry": { /* retry detail, or null */ },
  "logs": { "codex_session_logs": [] },
  "recent_events": [ { "at": "...", "event": "...", "message": "..." } ],
  "last_error": null,
  "tracked": {}
}
```

`status` is `running` or `retrying`. `logs.codex_session_logs` and `tracked` are present but always empty. If no running or retrying entry matches, returns `404 issue_not_found` ("Issue not found"). A snapshot error also returns `404 issue_not_found` from this route.

### Trace routes

These read from the SQLite issue store and the `TraceWatcher` over `traceDir`. They are mounted only when both are configured.

- **`GET /api/v1/issues/recent`** returns `{issues}` from the issue store, newest first. `limit` (1-100, default 5).
- **`GET /api/v1/issues/search`** returns `{issues}` matching `q` (default empty). `limit` (1-100, default 20).
- **`GET /api/v1/tickets`** returns `{tickets}`, each a `TicketInfo` (`issueId`, `identifier`, optional `title`, `url`, `agentKind`, `startedAt`, `turnCount`, `status` of `running` / `completed` / `failed` / `idle`) enriched with `title` and `url` from the store when present.
- **`GET /api/v1/tickets/:id/exists`** returns `{exists}`. The `:id` is the URL-encoded issue id, percent-decoded by the route.
- **`GET /api/v1/tickets/:id/events`** returns `{issueId, identifier, events}`, where `events` is the parsed `DisplayEvent[]` for the ticket. The dashboard computes trace stats client-side from this list.

For the `DisplayEvent` shape and how raw trace lines map to it, see the [events reference](events.md).

### POST /mcp

The Model Context Protocol endpoint serving the workflow's tool packs. Settings resolve per request, so a [hot-reloaded workflow](../features/workflow-hot-reload.md) updates the served tools without restarting the server. The auth scope derives from settings, host, and port (or random when the port is ephemeral). Any non-`POST` method returns `405 method_not_allowed`. The tool contracts live in the [tracker tools reference](jira-tools.md).

## The /ws WebSocket

`/ws` is the single push transport for the dashboard. It streams both trace events and ops-state snapshots. Upgrade with a standard WebSocket handshake against `ws://<host>:<port>/ws`.

### Lifecycle

1. **Connect.** On open the server sends `init` with the current trace tickets, then `ops_state` if a runtime snapshot is available.
2. **Subscribe.** The client sends `{"type": "subscribe", "issueId": "<id>"}`. The server subscribes the watcher to that issue and replies with a full `events` snapshot. Re-subscribing to the same issue re-sends the snapshot.
3. **Deltas.** When the watcher detects new trace lines, it broadcasts `update` (refreshed ticket list) to every client, and sends `events_append` (only the changed tail) to clients subscribed to that issue.
4. **Ops broadcasts.** When the runtime emits a new snapshot, the server broadcasts `ops_state` to all clients, but only while at least one connection is open.
5. **Unsubscribe.** `{"type": "unsubscribe", "issueId": "<id>"}` releases the subscription for that issue.

The dashboard client reconnects on a 3 second cadence after a drop. The server does not restore subscriptions automatically; the client re-subscribes after reconnect.

### Server to client messages

| `type` | Fields | When |
| --- | --- | --- |
| `init` | `tickets: TicketInfo[]` | On connect, first message |
| `ops_state` | `state: OpsStatePayload` | On connect (if available) and on each runtime snapshot |
| `events` | `issueId`, `events: DisplayEvent[]` | Reply to `subscribe`; full snapshot |
| `events_append` | `issueId`, `events: DisplayEvent[]`, `fromIndex` | On watcher change, to subscribers; `events` is the slice from `fromIndex` |
| `update` | `issueId`, `tickets: TicketInfo[]` | On watcher change, broadcast to all |

`events_append` carries only the tail that changed. `fromIndex` is the first changed event index; the client splices `events` in at that offset. A `fromIndex` the client cannot reconcile makes it request a fresh full snapshot.

### Client to server messages

| `type` | Fields | Effect |
| --- | --- | --- |
| `subscribe` | `issueId` | Stream `events` then `events_append` deltas for the issue |
| `unsubscribe` | `issueId` | Stop streaming that issue |

Both fields are required and `issueId` must be a string. Malformed JSON and any other message type are ignored. When the server was started without trace support, `subscribe` and `unsubscribe` are silently dropped.

The `OpsStatePayload`, `RunningEntryPayload`, `RetryEntryPayload`, and `BlockedEntryPayload` shapes are identical to those returned by `GET /api/v1/state`.

## Status codes

| Code | HTTP | Routes | Meaning |
| --- | --- | --- | --- |
| `dashboard_not_built` | 503 | `GET /` | `index.html` not found; build the dashboard |
| `method_not_allowed` | 405 | all concrete routes | Wrong HTTP method |
| `not_found` | 404 | any unknown path | No matching route |
| `snapshot_timeout` | 200 / 503 | `state`, `runs` | Snapshot read timed out |
| `snapshot_unavailable` | 200 / 503 | `state`, `runs` | Snapshot read failed |
| `unauthorized` | 401 | `refresh`, `stop` | Missing or invalid daemon control token |
| `orchestrator_unavailable` | 503 | `refresh` | Runtime could not queue the refresh |
| `daemon_status_unavailable` | 503 | `daemon` | No daemon status hook or snapshot status was available |
| `daemon_control_unavailable` | 503 | `stop` | The mounted runtime source cannot accept stop requests |
| `issue_not_found` | 404 | `:issue_identifier` | No running or retrying entry matches |
| `run_not_found` | 404 | `runs?id=` | No run matches the id |
| `invalid_path_parameter` | 400 | path-param routes | Malformed percent encoding in the path |

`GET /api/v1/state` returns the `snapshot_*` codes with `200` (in the body's `error`); `GET /api/v1/runs` returns them with `503`.

## See also
- [Observability](../observability.md) - the dashboards and trace viewer these routes feed
- [Events reference](events.md) - `DisplayEvent` and runtime event types on the wire
- [Configuration reference](configuration.md) - `server.*` and `observability.*` keys
- [Tracker tools reference](jira-tools.md) - the tools served on `/mcp`
- [CLI reference](cli.md) - flags that start, bind, and disable the server
