# Workflow hot-reload

Lorenz re-reads your `WORKFLOW.md` while the daemon is running, so you can tune
polling, concurrency caps, retry backoff, and per-state behavior without a
restart. This page is for operators: it covers what reloads live, what stays
pinned for the daemon's lifetime, how a bad edit is contained, and how to change
settings safely.

## What reloads, and when

The runtime checks the workflow file once at the top of every poll, before it
fetches candidate issues or dispatches anything. Editing the file is the whole
interface: save it, and the next poll picks up the change. There is no reload
command, no signal, and no separate config file. The cadence is set by
`polling.interval_ms` (default `30000`), so a saved edit takes effect within one
poll interval.

The check is cheap. Lorenz computes a content stamp from three fields and
compares it to the stamp it loaded last:

- `mtimeMs` - the file's modification time
- `size` - the file's byte length
- `contentHash` - a SHA-256 of the file content

If all three match the last-loaded stamp, the file is unchanged and the reload
is skipped with no further work. If any of the three differ, Lorenz re-reads the
file, re-parses the YAML front matter into a `Settings` object, re-parses the
Liquid prompt body, and attempts to swap the live settings.

Because the hash is part of the stamp, touching the file (updating `mtimeMs`)
without changing its bytes does not trigger a re-parse: the content hash still
matches, so the reload is skipped.

## The transactional swap

A changed file is applied in a single transaction. Lorenz runs every step that
can throw *first*, and only swaps the live settings after all of them succeed.
The order is:

1. Re-read the file and re-parse it into a candidate `Settings`. A YAML or
   schema error stops here.
2. Compare the new stamp against the previous one again; if they are equal, or
   the reload returned the same object, nothing changes.
3. Run the slots-per-machine co-residence gate (`checkSlotsPerMachineGate`)
   against the candidate worker-pool settings. This is the same gate the daemon
   runs once at startup.
4. Reconcile the live worker pool / coordinator onto the candidate settings.
5. Only now swap the live `workflow`, the orchestrator's `settings`, and (when a
   `clientFactory` is in use) the tracker client.

On success Lorenz emits `workflow_reloaded` carrying the workflow path.

If any step fails, the runtime keeps its last-good settings. Nothing is
partially applied: the live pool and coordinator stay on the previous config, so
dispatch never runs against settings that do not match the live pool. The
failure surfaces as a `workflow_reload_failed` event carrying the error message,
and the daemon keeps running on the configuration it already had.

This means a syntax error or an invalid value in `WORKFLOW.md` cannot take the
daemon down. The running configuration is only ever replaced by a configuration
that fully validated and reconciled.

## What changes live

Most of the file is live-tunable. Editing these values changes behavior on the
next poll, with no restart:

- `polling.interval_ms` - the poll cadence. The next interval uses the new
  value.
- `agent.max_concurrent_agents` - the global concurrency cap. Reserved
  (in-acquire) slots count toward this cap, so lowering it does not abandon runs
  already in flight; it stops new dispatches until the count falls below the new
  cap.
- `agent.max_turns`, `agent.max_retry_backoff_ms`, `agent.ensemble_size`.
- `agents.turn_timeout_ms`, `agents.stall_timeout_ms` - applied as defaults to
  every agent record.
- `tracker.active_states`, `tracker.terminal_states`, and the
  `tracker.dispatch.*` routing keys (`accept_unrouted`, `only_routes`,
  `route_label_prefix`).
- `status_overrides.<state>.*` - per-state caps and agent fragments (see below).
- The Liquid prompt body. New dispatches render against the updated template.

### status_overrides recompute per issue

`status_overrides` are not applied once at reload. The effective settings for a
given issue are computed every time an issue is dispatched, by merging the
override that matches the issue's current state. The lookup key is the state name
normalized with `normalizeStateName` (trimmed and lowercased), so
`In Progress`, `in progress`, and `IN PROGRESS` all resolve to the same
override.

Two fields cannot be retargeted in a per-state override, by design: `executor`
and `skills`. A per-state agent record cannot switch executor, and an override
cannot change which skills an agent loads. Everything else - the concurrency
cap, model, timeouts - can vary per state. Because the merge happens per
dispatch, editing a `status_overrides` block reaches every issue moving through
that state on the next poll.

## What stays pinned

One class of change does not take effect on a live reload: the worker driver
*code* loaded by the worker pool is bound for the daemon's lifetime. The
coordinator and its pool are a reload-surviving singleton. Lorenz reconciles
pool settings in place across reloads rather than tearing the coordinator down,
because reconstructing it would orphan in-flight (and paid) cloud workers.

The distinction that matters:

- Changing the driver *specifier* - the `worker.worker_pool.driver` value, or an
  out-of-tree driver module path - is reconciled live. The coordinator's
  driver loader can dynamic-import the new module during reconcile before the
  pool reconcile runs.
- Numeric pool tuning (`min`, `max`, `warm`, `ttl_ms`, `idle_reap_ms`,
  `acquire_timeout_ms`, and friends under `worker.worker_pool`) reconciles live.

The hard guard is `worker.worker_pool.max_in_flight` (the slots-per-machine
count). A live daemon cannot raise it past the startup gate. If a reload sets
`max_in_flight` above 1 without the per-run-endpoint capability or the
`co_residence` opt-in, the gate rejects the candidate settings, the reload fails,
and `workflow_reload_failed` carries the gate's message. This stops a live edit
from widening the shared-machine blast radius that the startup gate already
refused. If you removed the `worker.worker_pool` block entirely, Lorenz
reconciles the live pool to a disabled equivalent so its workers drain to zero
rather than leaking.

To change the worker driver implementation that is compiled into the daemon (as
opposed to which registered driver is selected), restart the daemon.

## Tuning safely while running

A few practical rules:

- **Watch for `workflow_reload_failed`.** It is the signal that your last edit
  did not take. The daemon is still running on the prior config. Check the event
  message, fix the file, and save again. The reload retries on the next poll.
- **Lower caps freely.** Dropping `agent.max_concurrent_agents` or a per-state
  `status_overrides.<state>.agent.max_concurrent_agents` does not kill in-flight
  runs. New dispatch pauses until live runs finish and the occupied count falls
  under the new cap.
- **Raise caps with headroom for backoff.** `agent.max_retry_backoff_ms` caps
  failure backoff; failure retries grow as `10000 * 2^(attempt-1)` and saturate
  at the cap (default `300000`). Lowering it makes a failing issue retry sooner.
- **Validate the YAML before you save.** A malformed front matter throws during
  parse and is contained, but it costs a poll and a `workflow_reload_failed`. An
  empty or whitespace-only prompt body is not an error: it silently falls back to
  the built-in default template.
- **Treat `max_in_flight` as restart-only in spirit.** Plan the co-residence
  capability up front. A live edit that tries to widen it will be rejected, not
  applied.

A dry run still exercises the reload path. The reload runs as the first step of
every poll, before the `dryRun` branch, so a dry-run poll reads the file, runs
`checkSlotsPerMachineGate`, reconciles the live coordinator and pool, and emits
`workflow_reloaded` or `workflow_reload_failed` exactly as a normal poll does.
The `dryRun` flag suppresses dispatch, not reload. To iterate on a config
quickly, set a short `polling.interval_ms` on a scratch tracker and watch the
`workflow_reloaded` / `workflow_reload_failed` events land.

## See also

- [Events reference](../reference/events.md) - the exact `workflow_reloaded` and
  `workflow_reload_failed` payloads, plus the rest of the runtime event
  vocabulary.
- [Agent orchestrator](../agent-orchestrator.md) - the poll loop and where the
  reload sits in each tick.
- [Workflows](../workflows.md) - writing the `WORKFLOW.md` file the reload reads.
- [Configuration reference](../reference/configuration.md) - every config key,
  default, and meaning.
- [Secret resolution](secret-resolution.md) - how `$VAR` and `op://` values in
  the file are resolved on each load.
