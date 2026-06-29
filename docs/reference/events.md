# Event catalog

This page is the exhaustive reference for the events Lorenz emits while it polls trackers, dispatches runs, executes agent turns, and reconciles state. It is for integrators who consume the `RuntimeSnapshot` (over the TUI, web dashboard, or HTTP API), parse trace files, or watch the daemon log and need the exact event name, when it fires, and where it surfaces.

There are two distinct event families, and they do not share a namespace:

- **Runtime events** (`RuntimeEventType`) - the canonical scheduling/lifecycle vocabulary defined in `packages/runtime-events`. These flow into the snapshot's `recentEvents` ring buffer and drive the dashboards. The vocabulary is `RUNTIME_EVENT_TYPES`.
- **Worker-pool / driver log events** - string-typed audit records the worker pool and dispatch coordinator emit through a `logEvent` callback. They are not members of `RuntimeEventType` and do not appear in `recentEvents`; they land in the daemon log (`logging.log_file`) and stderr.

Trace lines are a third surface, derived 1:1 from agent updates. Each `AgentUpdate` the runtime streams for a run becomes exactly one JSONL line in that issue's `trace.jsonl`. See [Where events surface](#where-events-surface) for which family reaches which consumer.

## The canonical runtime vocabulary

`RUNTIME_EVENT_TYPES` (in `packages/runtime-events/src/index.ts`) is the spread of `AGENT_UPDATE_TYPES` followed by 19 runtime-specific strings. Every entry of `recentEvents[]` carries a `type` from this set, a `message`, and an ISO `at` timestamp. The agent-turn half (`AGENT_UPDATE_TYPES`, from `packages/domain`) is reused verbatim, so a `turn_completed` in the snapshot and a `turn_completed` line in a trace file are the same string.

The sections below group every name by category. Names are verbatim. None are invented.

### Lifecycle and dispatch

These fire as the runtime moves an issue from eligible candidate to a live run.

| Event | When it fires | Signals |
| --- | --- | --- |
| `dry_run` | Per eligible issue during a `pollOnce({dryRun:true})` tick, in place of an actual dispatch. | The issue would have been dispatched. No workspace, no agent. |
| `poll_error` | A poll tick threw (including a `validateDispatch` failure that aborts the tick). | The whole tick failed; reconciliation and dispatch did not complete that tick. Also surfaced as `poll.lastError`. |
| `dispatch_skipped` | An eligible issue could not claim a slot, or a pool reservation found no capacity. | A capacity or worker-host block. The message carries the reason: `global_concurrency_cap`, `local_concurrency_cap`, `worker_host_capacity`, `worker_pool_acquire_error <msg>`. |
| `run_reserving` | The pool path claims a host-less reservation before acquiring a worker. | A two-phase pool dispatch entered its acquire window. The slot occupies concurrency but has no host yet. |
| `run_started` | A run binds to a concrete host: immediately on the static/local path, or after `bindReservation` on the pool path. | The agent run is live. |
| `dispatch_refresh_failed` | Re-fetching an issue immediately before dispatch failed. | The pre-dispatch state refresh errored; the issue is not dispatched this tick. |
| `run_completed` | A run finished cleanly (clean worker exit). | The run ended; a `continuation` retry is scheduled. |
| `run_failed` | A run finished with a fault. | The run ended in error; a `failure` retry is scheduled with exponential backoff. |

The three concurrency-cap strings (`global_concurrency_cap`, `local_concurrency_cap`, `worker_host_capacity`) are the closed set of `DispatchBlockReason` values. They also populate `blocked[]` in the snapshot, not only the `dispatch_skipped` message. An ineligible issue (inactive, unrouted, or blocked) is never reported as capacity-blocked; it is silently filtered.

### Retry

The retry scheduler fires off the poll cadence to wake an issue when its backoff deadline is due.

| Event | When it fires | Signals |
| --- | --- | --- |
| `retry_timer_due` | A per-issue retry timer's monotonic deadline elapsed. | The issue is due; the scheduler nudges a poll so eligibility re-checks it. |
| `retry_timer_error` | The poll triggered by a due timer threw. | The retry-driven poll failed; the timer's work did not complete. |

Backoff is purely exponential on attempt count: a `continuation` retry is a fixed `1000ms`; a `failure` retry is `10000 * 2^(attempt-1)`, capped at `agent.max_retry_backoff_ms` (default `300000`). Timers fire 5ms after the computed deadline (`RETRY_SCHEDULER_SYNC_DELAY_MS`) so the issue is reliably due when the poll re-evaluates it. There is no Retry-After or 429-driven backoff anywhere in this path.

### Reconcile and workspace

Reconciliation refreshes in-flight issues against the tracker, stops runs that became ineligible, detects stalls, and cleans terminal workspaces.

| Event | When it fires | Signals |
| --- | --- | --- |
| `run_reconciled` | A tracked run was stopped during reconciliation for a non-terminal reason. | The run stopped because the issue went `unrouted`, `blocked`, or `inactive` (or is `missing` from the refetch). |
| `run_stalled` | A running entry exceeded its effective `agents.<kind>.stall_timeout_ms`. | The run was force-finished as a failure, its worker forced to poison, and a `stalled` run-history entry recorded. |
| `reconcile_refresh_failed` | Re-fetching tracked issues during reconciliation failed. | The refetch errored; all in-flight runs are kept running for that tick. |
| `workspace_cleanup` | A reconciled issue reached a terminal state and its workspace was removed. | Per-issue workspace dirs were deleted (locally and on every configured SSH host). |
| `startup_workspace_cleanup` | The one-time, disk-driven startup sweep removed workspaces for terminal issues. | On-disk workspaces were enumerated, their issues fetched, and terminal ones cleaned. Runs once per daemon. |
| `startup_workspace_cleanup_failed` | The startup sweep errored. | The startup cleanup did not complete; the daemon continues. |
| `refresh_error` | An on-demand snapshot refresh request failed. | A `requestRefresh` could not complete. |

Workspace hook execution itself does not emit a `RuntimeEventType`. Each hook (`after_create`, `before_run`, `after_run`, `before_remove`) emits a `hook_execution` agent update carrying a `HookExecutionMessage` with `status` of `started`, `completed`, or `failed`. That update reaches traces, not `recentEvents`.

### Config and workflow

Hot-reload runs before each poll and keeps last-known-good settings on any failure.

| Event | When it fires | Signals |
| --- | --- | --- |
| `workflow_reloaded` | A changed `WORKFLOW.md` was re-parsed, gated, and swapped in transactionally. | New settings are live. The message carries the workflow path. |
| `workflow_reload_failed` | Re-reading, re-parsing, the slots-per-machine gate, or the coordinator reconcile threw during a reload. | The reload was rejected; the daemon kept last-known-good settings. No partial apply. |

Parse-time failures surfaced while loading the file carry their own stable error strings (`workflow_parse_error`, `workflow_front_matter_not_a_map`, `missing_workflow_file`, `template_parse_error`). These are thrown messages, not members of `RUNTIME_EVENT_TYPES`; a reload that hits one is reported as `workflow_reload_failed`.

### Agent turn

These 17 names are `AGENT_UPDATE_TYPES`, reused verbatim inside `RUNTIME_EVENT_TYPES`. The ACP executor produces them as it drives one bridge subprocess (Codex or Claude) through a turn. They are the trace stream.

| Event | When it fires | Signals |
| --- | --- | --- |
| `workspace_prepared` | The per-issue workspace is created and ready. | The run has a workspace path. |
| `session_started` | The ACP session opened (`initialize` + `newSession` returned). | The session id is now set. |
| `turn_started` | A prompt was sent for a new turn. | One turn is in flight. Only one concurrent turn per session is allowed. |
| `turn_completed` | The turn's stop reason mapped to `continue` (`end_turn`, `max_tokens`, `max_turn_requests`). | The turn resolved normally; the run loop may continue. |
| `turn_failed` | The stop reason mapped to retry (anything outside continue/cancel, e.g. `refusal`). | The turn rejected with `acp_turn_failed: <stopReason>`. |
| `turn_cancelled` | The stop reason was `cancelled`, or a turn/stall timeout cancelled the turn. | The turn was cancelled (`acp_turn_cancelled`). |
| `turn_input_required` | The bridge requested input mid-turn. | The agent is waiting for input. |
| `approval_required` | A permission request had no auto-approvable option. | A permission could not be auto-approved; the outcome is `cancelled`. |
| `approval_auto_approved` | A permission request matched an `allow`-prefixed option. | Lorenz auto-approved the request (the default for ACP permissions). |
| `tool_input_auto_answered` | A tool-input prompt was answered automatically. | The bridge's input request was satisfied without operator action. |
| `rate_limit` | The bridge reported a rate-limit condition. | Display-only. Captured in `rateLimits` for the snapshot; it does not influence retry timing. |
| `stderr` | The bridge wrote to stderr, or an ignored hook failure was reported. | Diagnostic output. Resets the stall timer. |
| `malformed` | A session notification did not match the locked session id, or was otherwise unparseable. | A protocol mismatch (`acp_session_update_mismatch`). |
| `process_exit` | The bridge subprocess exited. | The child process ended. |
| `fs_write` | The agent wrote a file through the sandboxed client fs (local runs only). | A workspace-scoped file write occurred. |
| `hook_execution` | A workspace lifecycle hook ran. | Carries a `HookExecutionMessage` (`started`/`completed`/`failed`). |
| `session_notification` | The bridge streamed an ACP session update. | Wraps the ACP `sessionUpdate` kinds below. Resets the stall timer. |

`session_notification` carries the streaming sub-kinds the trace parser reads: `agent_message_chunk`, `user_message_chunk`, `agent_thought_chunk`, `tool_call`, and `tool_call_update`. `usage_update` also rides this channel. The parser coalesces message/thought chunks and pairs `tool_call` with `tool_call_update` by `toolCallId`.

`RuntimeRunLastEvent` adds one value beyond `AGENT_UPDATE_TYPES`: `agent_stalled`. It is a run-history `lastEvent` marker, not an emitted event type.

### Usage

Token usage is not a standalone event name; it rides agent updates as `_meta` extensions and is accumulated into `usageTotals`.

| Marker | Where it appears | Signals |
| --- | --- | --- |
| `_meta["symphony/callUsage"]` | Per-call usage bucket on session notifications (both bridges). | Additive per-call token counts, deduped by `seq`. |
| `_meta["symphony/totalUsage"]` | Codex bridge only. | A monotonic cumulative floor for the session. Claude has no running counter; its totals arrive at turn end via `PromptResponse.usage`. |
| `usageKind: "cumulative"` | Every usage update Lorenz emits to the orchestrator. | Lorenz always reports session-cumulative totals regardless of the bridge's accounting mode. |

`provider_config` is delivered to the bridge over `_meta` too: `_meta["symphony/settings"]` (settings.json shape) for Claude, `_meta["symphony/config"]` (config.toml shape) for Codex.

### MCP

The agent-facing tool surface is an HTTP MCP endpoint at `POST /mcp`, not an event emitter. Its "events" are JSON-RPC methods and result fields.

| Name | Kind | Meaning |
| --- | --- | --- |
| `initialize` | JSON-RPC method | Handshake; returns `protocolVersion` (default `2025-11-25`), `capabilities {tools:{}}`, `serverInfo {name:'mcp',version:'0.1.0'}`. |
| `notifications/initialized` | JSON-RPC method | Acknowledged with `null` (HTTP 204). |
| `tools/list` | JSON-RPC method | Returns the mounted tool specs. |
| `tools/call` | JSON-RPC method | Runs one tool; wraps the result as `{content:[...], isError}`. |
| `isError` | result field | `true` when the tool's `ToolResult.success` is `false`. A failed tool is still an HTTP 200 JSON-RPC result. |
| `unauthorized` | 401 error code | Missing or wrong bearer token for the endpoint's auth scope. |
| `-32700` / `-32601` / `-32602` | JSON-RPC error codes | Parse error / method not found / invalid params. |

Tool failures cross the MCP seam as data, never as thrown errors. The seven `jira_*` tools the Jira extension's pack mounts are `jira_read_issue`, `jira_query`, `jira_update_status`, `jira_list_comments`, `jira_comment`, `jira_update_comment`, and `jira_create_issue`.

## Worker-pool and driver events

These are string-typed log records from `packages/worker-pool`, `packages/dispatch-coordinator`, and the out-of-tree driver loader. They reach the daemon log and stderr, not the snapshot `recentEvents` ring. They are the audit trail for the warm worker pool's lifecycle.

### Driver loading

| Event | When it fires | Signals |
| --- | --- | --- |
| `worker_pool_driver_loaded` | An out-of-tree driver module was dynamically imported and registered. | A driver specifier resolved and loaded at startup or on a reload that changed it. |
| `worker_pool_driver_module_pinned` | The loaded driver module was pinned for the daemon lifetime. | The module code is fixed until restart; cache-busting is rejected. |

`worker_pool_driver_unavailable`, `worker_pool_driver_module_invalid`, `worker_pool_driver_sdk_mismatch`, and `worker_pool_driver_invalid_specifier` are thrown error codes that fail startup loudly rather than log-and-continue.

### Pool lifecycle, reaper, and ledger

| Event | When it fires | Signals |
| --- | --- | --- |
| `worker_pool_provision_failed` | A grow-path provision threw. | A worker could not be provisioned for an acquire. |
| `worker_pool_warm_provision_failed` | A warm top-up provision threw. | A warm-pool replenishment failed. |
| `worker_pool_worker_unready` | A freshly provisioned worker failed its readiness probe. | The worker was destroyed before entering inventory. |
| `worker_pool_probe_failed` | A reaper-tick probe of a warm worker failed. | The worker is demoted toward destruction. |
| `worker_pool_degraded` | A worker was marked degraded after a failing probe. | The worker is on its way out. |
| `worker_pool_destroy_failed` | A teardown `destroy` call threw. | A worker may not have been cleaned up; the pool continues. |
| `worker_pool_list_failed` | A reaper `driver.list()` reconcile failed. | The pool could not reconcile its inventory against the driver this tick. |
| `worker_pool_reconcile_destroy_unknown` | `list()` surfaced a pool-owned worker the pool did not register. | An orphan was destroyed during reconcile. |
| `worker_pool_reconcile_missing` | A registered worker was absent from `list()`. | The worker was marked destroyed. |
| `worker_pool_orphan_reaped` | An orphan worker was reaped. | A leftover machine was cleaned up. |
| `worker_pool_topup_budget_blocked` | A warm top-up was blocked by a spend cap. | The pool could not grow toward `warm` within budget. |
| `worker_pool_reaper_failed` | A reaper tick threw. | The serial reaper pass errored; the next tick retries. |
| `worker_pool_ledger_write_failed` | A write-ahead ledger write failed. | Ledger persistence errored (cloud/`usesLedger` drivers only). |

### Crash recovery, callbacks, and endpoints

| Event | When it fires | Signals |
| --- | --- | --- |
| `worker_pool_hydrate_failed` | Hydrate could not list survivors for a paid driver. | Startup fails loudly so no paid machine leaks unowned. Also a thrown code. |
| `worker_pool_hydrate_list_failed` | A hydrate `list()` attempt failed (retried up to three times). | A transient list failure during crash recovery. |
| `worker_pool_hydrate_orphan_dropped` | A ledger row had no matching survivor in `list()`. | A stale ledger entry was dropped during recovery. |
| `worker_pool_recycling_callback_failed` | An `onMachineRecycling` callback threw. | A recycle notification failed; recycle proceeds. |
| `worker_pool_capacity_callback_failed` | An `onCapacityAvailable` callback threw. | A freed-capacity nudge failed. |
| `worker_pool_endpoint_release_failed` | A per-run MCP endpoint release threw. | Best-effort endpoint teardown failed; it never blocks lease settle. |

The coordinator maps every no-capacity reason (`acquire_timeout`, `spend_cap`, `pool_disabled`, `driver_error`, `tunnel_exhausted`) onto the single `worker_host_capacity` dispatch signal. Acquire-path faults such as `mcp_endpoint_open_failed` and `run_slot_collision` settle the bound lease healthy and surface to the runtime as `dispatch_skipped` with a `worker_pool_acquire_error` message.

`machine_recycled` is a separate, run-side reason. When the worker pool recycles a machine out from under a bound run, the coordinator's `onMachineRecycling` callback passes `machine_recycled` to the affected run slot's `fail()`. That settles the lease and surfaces to the runtime as a run failure (`run_failed`). Unlike the acquire-path faults above, it ends a live run rather than blocking a dispatch.

## Where events surface

The same name can reach different consumers, and many runtime events never reach the UI at all.

- **Snapshot `recentEvents`** holds the last 20 `RuntimeEvent`s (hard cap in `ProjectionActor`). This is what the TUI, web dashboard, and HTTP API read. Only `RuntimeEventType` members appear here.
- **Run history** holds the last 50 entries, each with an `outcome` from `RUNTIME_RUN_OUTCOMES`: `success`, `failed`, `stalled`, `canceled`. The runtime records only `success`, `failed`, and `stalled`; `canceled` is defined but unused today (reconciliation cleans up without writing a history outcome).
- **Trace files** receive one line per `AgentUpdate`, written to `<server.trace_dir>/<issueId>/trace.jsonl`. The trace parser drops eight raw types entirely (`rate_limit`, `workspace_prepared`, `session_started`, `process_exit`, `stderr`, `fs_write`, `approval_auto_approved`, `approval_required`); they still count toward the watcher's line summary. The dashboard's trace timeline maps lines to its own `DisplayEvent` kinds (`thought`, `message`, `tool_call`, `turn_started`, `turn_completed`, `turn_failed`, `notification`, `unknown`).
- **Daemon log** (`logging.log_file`) receives the worker-pool/driver log events. These never enter `recentEvents`.

There is no database. The 20-event and 50-history ring buffers, plus the optional log file, are the only event surfaces; nothing is persisted beyond them.

## See also
- [Configuration reference](configuration.md) - the keys (`agent.max_retry_backoff_ms`, `agents.<kind>.stall_timeout_ms`, `server.trace_dir`) that govern these events.
- [Dispatch](../dispatch.md) - the eligibility, cap, and two-phase reservation logic behind the lifecycle events.
- [Observability](../observability.md) - how the snapshot, dashboards, and traces consume this catalog.
- [HTTP API reference](http-api.md) - the REST and `/ws` shapes that carry `recentEvents`, run history, and trace deltas.
- [Tracker tools reference](tracker-tools.md) - the MCP tool surface behind the `tools/call` events.
