# Glossary

The vocabulary the rest of the docs use, defined once. Each entry is one or two sentences and links
to the page that owns the concept in full. This page is for integrators who hit a term mid-page and
want the precise meaning without re-reading the chapter it came from. Names in backticks are
verbatim: the exact config key, event string, or identifier the engine uses.

A few internal identifiers and `_meta` keys still carry a `symphony/` prefix for historical reasons,
even though the user-facing surface is `lorenz`.

## A

**ACP bridge** - the external subprocess that adapts a coding agent (Codex or Claude) to the Agent
Client Protocol, spawned and driven by the built-in `acp` executor over `@agentclientprotocol/sdk`.
The bridge is a shell command (`bridge_command`, defaulting to `codex-acp` or `claude-agent-acp`)
that runs locally under `bash -lc` or over SSH on a worker host, where the bridge binary must be
installed. See [../agents/acp-bridges.md](../agents/acp-bridges.md).

**Agent kind** - a named per-agent configuration block under `agents.<kind>` (for example
`agents.codex`, `agents.claude`) selecting which executor runs and carrying that executor's options.
The active kind comes from `agent.kind` (default `codex`); `AgentKind` is an open `string` alias, not
a closed set. See [../agents/index.md](../agents/index.md) and
[configuration.md](configuration.md).

## C

**Continuation turn** - the retry Lorenz schedules after a clean agent exit, distinct from a failure
retry. `finish(normal)` always writes a continuation retry (attempt 1, fixed backoff near 1000ms);
reconciliation later prunes it if the issue is no longer active. See
[../agent-orchestrator.md](../agent-orchestrator.md) and
[workflow-prompt.md](workflow-prompt.md) for the continuation prompt.

## D

**Dispatch** - the act of turning an eligible issue into a running agent. The runtime dispatches each
eligible issue as a detached per-run promise: the static or local path claims a slot and runs
immediately, the pool path reserves a slot, acquires a worker, then binds. See
[../dispatch.md](../dispatch.md).

**Dispatch block** - a reason a candidate issue is held back this tick instead of dispatched. The
`DispatchBlockReason` values are `global_concurrency_cap`, `local_concurrency_cap`, and
`worker_host_capacity`; blocked issues surface in the snapshot's `blocked` lane. See
[../dispatch.md](../dispatch.md) and [events.md](events.md).

## E

**Eligibility** - the orchestrator's decision about which fetched issues may be dispatched now.
`eligibleIssues` sweeps expired reservations, prunes retry attempts for inactive issues, resets the
blocked list, then sorts and filters: issues with retries not yet due are dropped. See
[../dispatch.md](../dispatch.md).

**Ensemble** - running more than one agent on the same issue concurrently, one per slot. The count
comes from an `ensemble:<n>` label on the issue or falls back to `agent.ensemble_size`. See
[../features/context-ensembles.md](../features/context-ensembles.md).

**Executor** - the runtime contract (`AgentExecutor`) that starts a session and runs turns for one
agent. Each executor is registered by an `AgentExecutorProvider` under the `agents.<kind>.executor`
selector; the only built-in value is `acp`. See
[../extensions/agent-executor.md](../extensions/agent-executor.md).

## H

**Hook** - an operator script run at a point in the workspace lifecycle: `after_create`,
`before_run`, `after_run`, or `before_remove`, under `hooks.*` with a shared `hooks.timeout_ms`.
Hooks run arbitrary code in the daemon's trust boundary. See [../workspace.md](../workspace.md).

## L

**Ledger** - the write-ahead JSON file the worker pool keeps for cloud drivers so it can recover
leased machines after a crash. It is inert (zero filesystem I/O) unless the driver's
`capabilities.usesLedger` is true and a ledger path is supplied; a sibling `spend.json` tracks daily
worker-seconds. See [../workers/worker-pool.md](../workers/worker-pool.md).

**Lease** - one agent run's hold on a pooled worker. `acquire()` yields a `WorkerLease` (on a leased
result) whose
`release(outcome)` (`healthy` or `poison`), `fail(reason)`, and `heartbeat()` settle it exactly once;
a poison outcome recycles the machine on its last lease return. See
[../workers/worker-pool.md](../workers/worker-pool.md).

## M

**MCP endpoint** - the HTTP `POST /mcp` JSON-RPC surface that exposes agent-callable tools, mounted
by `@lorenz/mcp` and leased per agent run as a local server, an SSH reverse tunnel, or a per-run
tunnel. The ACP server name shown to an agent is `lorenz_<kind>`. See
[http-api.md](http-api.md) and [tracker-tools.md](tracker-tools.md).

## P

**Provider** - the extension that backs a tracker. A `TrackerProvider` is registered under a `kind`,
creates the dispatch client, and optionally supplies tool ops and tool packs; selected by
`trackers.<name>.provider` (or the flat `tracker.kind`). See
[../extensions/tracker-provider.md](../extensions/tracker-provider.md) and
[../trackers/index.md](../trackers/index.md).

## R

**Reaper** - the single serial recurring pass that reconciles the worker pool against
`driver.list()`: it destroys unknown pool-owned machines, reaps over-TTL and idle workers above the
floor, demotes failing probes, and tops up warm capacity. Cadence is
`worker.worker_pool.reap_interval_ms` (default 15000). See
[../workers/worker-pool.md](../workers/worker-pool.md).

**Reconciliation** - the per-poll passes that bring in-memory state back in line with truth. Stall
reconciliation finishes runs idle past their stall timeout; tracked-issue reconciliation refetches
in-flight issues and stops, refreshes, or cleans up each one based on its current tracker state.
Reasons are `terminal`, `unrouted`, `blocked`, and `inactive`. See
[../agent-orchestrator.md](../agent-orchestrator.md).

**Route label** - the tracker label that marks an issue for a specific worker, matched against the
`route_label_prefix` (default `Lorenz:`). With `accept_unrouted` (default true) and `only_routes`,
the prefix governs which issues a worker claims. See
[../features/dispatch-routing.md](../features/dispatch-routing.md).

**RuntimeSnapshot** - the single object that feeds every UI. It carries `appStatus`, `poll`,
`running[]`, `reserving?[]`, `retrying[]`, `blocked[]`, `runHistory[]`, `usageTotals`, `rateLimits`,
`logFile`, and `recentEvents[]`, assembled from orchestrator state plus the projection ring buffers
(last 20 events, last 50 history entries). See [../observability.md](../observability.md).

## S

**Skill** - a directory of agent instructions a tool pack overlays into the workspace when mounted,
so enabling a tool ships its companion guidance. The mounted set is the union of every active pack's
`skills`. See [../agents/skills.md](../agents/skills.md).

**Slot** - one unit of agent concurrency on an issue, keyed by `(issueId, slotIndex)`. A slot moves
through claimed or reserved, running, finished, then retry; reserved (in-acquire) slots count toward
every concurrency cap so dispatch cannot exceed `agent.max_concurrent_agents`. See
[../dispatch.md](../dispatch.md).

**Stall timeout** - the inactivity timer that cancels a turn after no agent update for
`agents.<kind>.stall_timeout_ms` (default 300000); a value of `0` or less disables stall detection. A
stall-finished run records a `stalled` outcome and poisons its worker. See
[../agents/index.md](../agents/index.md).

**Status override** - a per-state config block under `status_overrides[state]` that adjusts behavior
for issues in a given tracker state, for example a per-state `agent.max_concurrent_agents`. See
[configuration.md](configuration.md).

## T

**Tool pack** - a named bundle of agent-callable tools (a `ToolProvider`) registered under a `name`,
mounted into the flat MCP namespace, and optionally shipping skills. The neutral `tracker` pack
serves the seven `tracker_*` tools; provider-specific packs (`linear`, `local`, `slack`) ship in the
tracker extensions. See [../extensions/tool-pack.md](../extensions/tool-pack.md) and
[tracker-tools.md](tracker-tools.md).

**Tracker** - the issue backend that drives dispatch: Linear, Jira, a local board, Slack, or the
in-memory fixture. Lorenz polls the tracker for candidate issues and writes status and comments back
through it. See [../trackers/index.md](../trackers/index.md).

**TraceViz** - the dashboard's per-issue trace view, fed by the HTTP API and a WebSocket stream of
`events` and `events_append` messages. See [../observability.md](../observability.md).

**Turn timeout** - the hard timer that cancels a turn after `agents.<kind>.turn_timeout_ms` (default
3600000) regardless of activity, distinct from the stall timeout. On fire it cancels the ACP turn and
rejects the run. See [../agents/index.md](../agents/index.md).

## W

**Warm pool** - the standing set of idle workers the pool keeps ready so an acquire need not wait on
provisioning. The reaper tops up toward `max(min, warm)` within budget; `worker.worker_pool.warm`
defaults to 1. See [../workers/worker-pool.md](../workers/worker-pool.md).

**Workflow** - the `WORKFLOW.md` file: YAML front matter (config) plus a Liquid prompt body. The
runtime reloads it transactionally before each poll and falls back to the last-known-good copy if the
reload fails. See [../workflows.md](../workflows.md) and
[../features/workflow-hot-reload.md](../features/workflow-hot-reload.md).

**Worker** - the SSH-addressable host an agent run executes on, identified by its `workerHost`. A run
reaches a worker either through the legacy static `worker.ssh_hosts` list or through the warm worker
pool. See [../workers/index.md](../workers/index.md).

**Worker driver** - the swappable backend (`WorkerDriver`) the pool calls to `provision`, `probe`,
`destroy`, and `list` machines, selected by `worker.worker_pool.driver`. Built-ins are `fake`,
`static-ssh`, and `docker`; drivers can also load out-of-tree by module specifier with an
`sdkVersion` handshake. See [../extensions/worker-driver.md](../extensions/worker-driver.md) and
[../extensions/out-of-tree.md](../extensions/out-of-tree.md).

## See also
- [configuration.md](configuration.md) - the exact config key behind every term defined here.
- [events.md](events.md) - the named events these concepts emit to a run's trace.
- [../how-it-works.md](../how-it-works.md) - the run loop that ties tracker, dispatch, worker, and agent together.
- [../architecture.md](../architecture.md) - where each subsystem named here lives in the engine.
- [index.md](index.md) - the rest of the reference surface these definitions point into.
