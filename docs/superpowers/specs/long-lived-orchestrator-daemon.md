# Long-Lived Orchestrator Daemon

## Status

Exploration. The current CLI already runs a daemon-shaped foreground process: it loads a
workflow, constructs `LorenzRuntime`, owns the dispatch coordinator, starts the
observability server, renders the TUI when attached to a terminal, and drains resources on
shutdown. This document describes how to turn that foreground process into a durable
same-host service without moving scheduler I/O into `@lorenz/orchestrator`.

## Current Shape

`apps/cli/src/main.ts` is the composition root. `runDaemon()` loads and validates the
workflow, configures logging, builds a dispatch coordinator, constructs `TraceEmitter`,
`IssueStore`, and `LorenzRuntime`, optionally starts `startObservabilityServer()`, and
then calls `runtime.start()`. Signal handlers call `runtime.stop()` and the `finally`
block drains the worker pool, stops the server, and closes the issue store.

`apps/cli/src/daemon.ts` owns backend registration and runtime adapters. It is already
the right boundary for process-level dependencies: tracker registries, agent executors,
worker drivers, MCP endpoint creation, workspace hooks, and log-file
events.

`packages/runtime/src/index.ts` owns the event loop. It serializes polls, reloads
workflow settings before each poll, reconciles tracked issues, dispatches eligible work,
and records runtime history. It also has a `requestRefresh()` path through the server, so
the first control-plane primitive already exists.

`packages/server/src/index.ts` exposes observability routes over HTTP and WebSocket:
state, runs, issue detail, refresh, trace routes, static dashboard assets, and MCP
mounting. It depends on a `RuntimeServerSource`, not the CLI, which makes it a useful
surface for daemon clients.

## Goals

- Make one long-lived same-host owner responsible for polling, dispatch, runtime history,
  worker pool lifecycle, trace emission, issue-store writes, and future durable claims.
- Allow multiple local clients to observe or control that owner without each starting a
  second scheduler.
- Support crash recovery once a durable claim store exists, including retry state and
  active claim reconciliation.
- Improve observability by exposing daemon identity, leadership, store capabilities,
  heartbeat, workflow path, reload status, and control-plane health.
- Keep `@lorenz/orchestrator` synchronous and backend-agnostic. The daemon can own I/O;
  the orchestrator should remain the pure dispatch state machine.

## Non-Goals

- A distributed scheduler or multi-host control plane.
- Raising concurrency limits or changing worker-pool co-residence policy.
- Moving tracker, workspace, MCP, or worker-pool I/O into the orchestrator package.
- Bulk-migrating claim state to SQLite as part of the daemon split. The daemon should
  accept the memory store first and gain durable stores through the claim-store port.

## Architectural Options

### Option A: Managed Foreground Daemon

Keep the current `runDaemon()` process mostly intact and document how launchd, systemd,
or a process supervisor should run it.

Complexity: low.

Benefits:

- Minimal code movement.
- Reuses current shutdown, drain, dashboard, TUI-disabled, and signal behavior.
- Gives operators a stable service process quickly.

Tradeoffs:

- Does not prevent a user from starting a second scheduler in another shell.
- Process-local memory still loses claims, retry timers, and run history on crash.
- CLI commands remain process starters rather than clients.
- Observability improves only through operational supervision, not through a daemon API.

Best use: immediate operational hardening, not the final architecture.

### Option B: Local Singleton Daemon With Control Socket

Add a same-host singleton lock and local control endpoint around the current runtime. The
daemon owns the runtime. CLI commands become clients when the daemon is already running.

Complexity: medium.

Benefits:

- Prevents accidental same-workflow multi-instance dispatch.
- Gives `lorenz runs`, refresh, status, shutdown, and reload commands one stable owner.
- Can reuse the existing HTTP server or add a Unix domain socket for local-only control.
- Establishes daemon identity and heartbeat before durable persistence lands.
- Establishes a `LeadershipStore` boundary so the initial local-file implementation can
  later be replaced by a Turso/SQLite row, Postgres advisory lock, Kubernetes Lease, or
  another deployment-native provider.

Tradeoffs:

- Crash recovery is still limited while the claim store is memory-only.
- Locking and stale-owner detection need careful tests.
- Local API authentication and file permissions become part of the product surface.
- The TUI must become a client view instead of the scheduler owner when attached to an
  existing daemon.
- File-based leadership is same-host only. It prevents duplicate local schedulers, but it
  is not a distributed election primitive for multiple pods.

Best use: first real daemon milestone.

### Option C: Daemon Package Plus Thin CLI Clients

Create a daemon runtime boundary that owns `LorenzRuntime`, the server, the issue store,
locking, and claim-store construction. `apps/cli` becomes a launcher plus a client for
status, runs, refresh, stop, and attach.

Complexity: medium-high.

Benefits:

- Cleanly separates process ownership from command parsing.
- Makes the future SQLite claim store a daemon-owned dependency, not a CLI detail.
- Gives tests a reusable daemon harness that can start, attach, reload, and stop.
- Reduces pressure on `apps/cli/src/main.ts`, which currently owns composition,
  lifecycle, client behavior, and TUI behavior in one path.

Tradeoffs:

- Requires a new API contract between launcher and daemon.
- More files move, so regression risk is higher than Option B.
- The existing server routes need a clear distinction between observability, MCP, and
  privileged control actions.

Best use: target shape after the singleton contract is proven.

### Option D: Service-Managed Daemon

Add generated launchd/systemd service files, service install/uninstall commands, log
locations, and health checks around Option B or C.

Complexity: medium.

Benefits:

- Gives production users restart policy, boot startup, log routing, and health checks.
- Pairs naturally with a durable claim store, because restart becomes expected behavior.

Tradeoffs:

- Platform-specific behavior and permissions need careful documentation.
- Service managers solve process resurrection, not claim correctness.
- A service that restarts into a broken workflow can create noisy failure loops unless
  startup validation is explicit and observable.

Best use: operational packaging after the local daemon protocol stabilizes.

### Option E: External Scheduler Service

Move scheduling into a separate service backed by a remote database or queue.

Complexity: high.

Benefits:

- Can eventually support multi-host scheduling, central observability, and fleet-wide
  claim ownership.

Tradeoffs:

- Too large for the current same-host problem.
- Requires new deployment, auth, schema migration, and failure-mode design.
- Risks turning a local automation tool into infrastructure before the local daemon
  contract is understood.

Best use: future scale-out, not the next step.

## Recommended Direction

Build Option B first, with boundaries that do not block Option C.

1. Add a daemon identity and singleton lock keyed by workflow path and workspace root.
   Store the lock under the workspace's `.lorenz/` tree with owner id, pid, start time,
   workflow path, control endpoint, and heartbeat timestamp.
2. Put that singleton behavior behind a small leadership-store port:
   acquire, read, heartbeat, release, and stale detection. The default store is local
   file-backed; distributed deployments can provide SQL or orchestrator-native stores
   without changing daemon status, attach, or shutdown semantics.
3. Add a local control endpoint. Prefer a Unix domain socket when available; keep HTTP
   bind behavior for dashboard and MCP. If HTTP is reused for control actions, require a
   local token and make privileged routes opt-in.
4. Teach CLI commands to attach to the running owner. `runs`, `status`, `refresh`, and
   `stop` should talk to the daemon when its lock and endpoint are healthy. Starting a
   second scheduler should fail loudly unless the user explicitly asks for an isolated
   foreground run.
5. Expose daemon status in `/api/v1/state` or a dedicated `/api/v1/daemon` route:
   daemon id, pid, started_at, heartbeat_at, workflow path, lock path, control endpoint,
   claim-store status, last reload result, and worker-pool drain status.
6. Keep the in-memory claim store as the default. When the durable claim store lands, the
   daemon should own store construction and pass the store into `Orchestrator`.
7. Split into a daemon package only after the control and singleton behavior are stable.
   The package split should be mechanical: move lifecycle ownership out of `main.ts`,
   not redesign dispatch.

## Durable-Claims Intersection

The daemon should not make claims durable by itself. It should make one process the
obvious owner and create the place where durable stores are constructed.

When the claim store remains in memory:

- crash recovery is still unsafe;
- same-host multi-instance is mitigated only by the singleton lock;
- retry durability lasts only for the daemon process lifetime;
- observability can still report that the active store has no crash-recovery or
  cross-process capabilities.

When a SQLite claim store is introduced:

- the daemon should open the database with WAL, a busy timeout, and explicit
  transactions around claim-store mutations;
- the store should persist retry attempts using wall-clock due times and recompute
  monotonic deadlines after restart;
- active claims should be leases with owner id, heartbeat, and expiry, not permanent rows;
- startup should hydrate state and reconcile active runs before polling;
- a crashed owner should not be considered dead until its heartbeat lease expires or its
  pid is proven stale on the same host.

The daemon should surface these capabilities rather than infer them from the store name.
For example, a memory store reports no crash recovery, no cross-process sharing, and no
retry durability; a SQLite store can report exactly the guarantees it implements.

## Best-Practice Mitigations

### Singleton Leadership

- Use the `LeadershipStore` port. The first implementation can use an atomic local lock
  file keyed by normalized workflow identity; multi-pod deployments need a distributed
  store such as Turso/SQLite with a shared durable file, Postgres, etcd, Consul, or a
  Kubernetes Lease.
- Write owner id, pid, process start time if available, hostname, control endpoint, and
  heartbeat.
- Treat stale locks conservatively. Prefer "owner unavailable" over stealing a lock while
  a process may still be alive.
- Never allow two live leaders for the same workflow root to poll the tracker.

### Crash Recovery

- On startup, hydrate durable claims before polling.
- Reconcile active claims against local child processes, resume-state records, and tracker
  state before dispatching new work.
- Expire abandoned reservations and active claims by owner heartbeat, not by process memory.
- Record a startup event when claims are recovered, expired, or quarantined.

### Retry Durability

- Persist retry attempt number, issue id, identifier, slot index, worker host,
  workspace path, error, and wall-clock due time.
- Recompute monotonic timers from wall-clock due time at hydration.
- Keep retry restoration behavior for cancelled reservations: capacity misses should not
  burn a retry attempt or lose affinity.

### Same-Host Multi-Instance Safety

- Make singleton acquisition happen before tracker polling, worker-pool hydrate, or server
  startup.
- Include the control endpoint in the lock so a second CLI can attach instead of starting.
- Fail loudly on lock conflicts with the owning pid and endpoint.
- Keep `--once` explicit: either it attaches to the daemon for one refresh or it requires a
  flag that permits isolated foreground execution.

### Observability

- Add daemon identity and claim-store capability fields to state output.
- Emit structured lifecycle events: lock_acquired, lock_conflict, daemon_heartbeat,
  workflow_reload_failed, claim_store_hydrated, claim_store_recovered,
  claim_store_recovery_failed, daemon_shutdown_started, daemon_shutdown_completed.
- Keep dashboard and TUI views honest when the store is memory-only.

### Shutdown

- Preserve the existing order: stop runtime, unmount TUI, drain worker pool, stop server,
  close issue store.
- Release the singleton lock only after drain and store close complete.
- On forced exit, rely on heartbeat expiry rather than best-effort cleanup.

### Security

- Bind privileged control routes to local-only transports by default.
- Use file permissions on sockets and lock files.
- Keep MCP auth scopes distinct from daemon-control auth.
- Do not expose stop, reload, or claim-store actions through the public dashboard bind
  without an explicit operator choice.

## Suggested Package Boundaries

- Keep `@lorenz/orchestrator` synchronous. It should accept a claim store, but not open
  files, sockets, or databases.
- Keep backend registration in `apps/cli/src/daemon.ts` until the daemon package exists.
- Add lifecycle helpers in small daemon modules first: leadership-store acquisition,
  status model, control endpoint address, attach-client resolution.
- Keep leadership and claim persistence as separate store interfaces. Leadership chooses
  the one active control-plane owner for a scope; claim persistence serializes dispatch
  state, retry state, and owner leases. They can share a provider, such as Turso, while
  preserving separate responsibilities and schemas.
- Reuse `@lorenz/server` for read-only observability. Add privileged control routes only
  behind local auth or in a separate local socket server.
- Keep `LorenzRuntime` as the event-loop owner. Avoid teaching it about process locks or
  service managers.

## Scale-Out Direction

Nothing in the daemon direction should require all scheduling forever to live in one
process. The narrow singleton is the poller/decision owner for a workflow scope. The rest
of the system should become event-driven from durable state:

- A leadership store elects exactly one poller that reads tracker state and writes
  eligible work decisions.
- A claim store serializes claim, reservation, retry, and heartbeat mutations.
- Workers or runtime executors consume claimed work and publish updates through durable
  state or explicit event channels.
- Observers attach to the daemon or read projection state; they do not become schedulers.

That gives two scale paths. First, keep one leader per workflow but scale execution
horizontally through worker pools and durable claims. Second, shard leadership by workflow,
route, tenant, or tracker project so multiple leaders own disjoint scopes. A fully
leaderless scheduler would need compare-and-swap claim transactions on every poll result
and careful tracker-rate coordination; it is possible, but it is a larger architecture than
the same-host daemon milestone.

## Testing Plan

- Unit-test lock acquisition, stale-lock handling, owner metadata, and endpoint discovery.
- Unit-test daemon status payloads, including memory-store capability reporting.
- Integration-test two CLI starts for the same workflow: first owns, second attaches or
  fails without polling.
- Integration-test refresh and stop through the local control endpoint.
- With a future durable store, add kill-and-restart tests that prove retry attempts are
  hydrated, abandoned active claims are expired, and no duplicate claim is dispatched.
- Keep existing shutdown tests green: TUI unmount, signal handling, server stop, issue
  store close, and worker-pool drain.

## Open Questions

- Should the daemon be one per workflow file, one per workspace root, or one process
  hosting multiple workflows?
- Should `--once` attach to the daemon by default, or always remain an isolated foreground
  mode?
- Should the TUI be only a client when a daemon is running, or can it still own a
  foreground runtime for development?
- What is the first supported service manager: launchd, systemd, or a documented generic
  supervisor?
- How much remote access should the dashboard support once privileged daemon controls
  exist?

## Implementation Sequence

1. Add daemon status data to runtime/server output without changing ownership.
2. Add singleton lock and attach-or-fail startup behavior.
3. Add local control client plumbing for status, refresh, runs, and stop.
4. Convert TUI/dashboard attachment to observe an existing daemon when present.
5. Introduce durable claim-store construction in the daemon once the store exists.
6. Package service-manager integration after local daemon semantics are stable.
