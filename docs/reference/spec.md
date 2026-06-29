# Service specification

The verified, implementation-neutral contract for a Lorenz-shaped service: the domain model, the
dispatch state machine, retry and reconciliation math, workspace safety invariants, the agent
runner protocol, and a conformance matrix. This page is for integrators and porters who want exact,
exhaustive behavior without reading the source. It states what the TypeScript implementation in this
repository actually does; where a guarantee is grounded in a behavioral invariant, the EARS wording
is preserved.

The original `SPEC.md` at the repository root is a language-agnostic draft that predates the current extension architecture; this page supersedes it
and corrects the points where the draft drifted from code. Sections marked **Roadmap** describe
behavior that is specified but not shipped.

## 1. Scope and boundary

Lorenz is a long-running service that reads work from an issue tracker, creates an isolated
filesystem workspace per issue, and runs a coding-agent session inside that workspace. It is a
scheduler, a runner, and a tracker reader. It is not a ticket editor: state transitions, comments,
and PR links are written by the coding agent through tools the workflow exposes, not by the
orchestrator. A successful run can end at a workflow-defined handoff state such as `Agent Review`
rather than `Done`.

The service solves four operational problems:

- It turns issue execution into a repeatable daemon instead of manual scripts.
- It confines each agent to a per-issue workspace directory.
- It keeps workflow policy in-repo (`WORKFLOW.md`) so teams version the prompt and runtime settings
  with their code.
- It exposes enough observability to operate and debug concurrent runs.

Non-goals: a rich web UI or multi-tenant control plane, a general workflow engine or distributed job
scheduler, built-in ticket-edit business logic, and a single mandated approval or sandbox posture.
Each implementation documents its own trust boundary.

## 2. Architecture, in two axes

Lorenz is built from a fixed set of components and a fixed set of layers. See
[architecture](../architecture.md) for the package-level map and
[source-map](../source-map.md) for the directory layout.

Components:

1. **Workflow loader** reads `WORKFLOW.md`, splits YAML front matter from the prompt body, returns
   `{config, prompt_template}`.
2. **Config layer** parses front matter into typed `Settings`, applies defaults and `$VAR`
   resolution, and runs dispatch preflight validation.
3. **Tracker client** fetches candidate issues, refreshes states by ID, fetches terminal issues for
   startup cleanup, and normalizes payloads into the issue model.
4. **Orchestrator** owns the single authoritative in-memory scheduling state and is the only
   component that mutates it.
5. **Workspace manager** maps identifiers to paths, creates and reuses per-issue directories, runs
   lifecycle hooks, cleans terminal workspaces.
6. **Agent runner** builds the prompt, selects the configured executor, drives the session, and
   streams agent updates back to the orchestrator.
7. **Status surface** (optional) renders human-readable runtime state.
8. **Logging** emits structured runtime events.

Layers, easiest to port when kept separate: a policy layer (`WORKFLOW.md` body), a configuration
layer (typed getters), a coordination layer (the orchestrator loop), an execution layer (workspace
plus agent subprocess), an integration layer (tracker adapters), and an observability layer.

### 2.1 Extension architecture

The tracker, the agent executor, and the worker driver are pluggable through registries, not
hard-coded. This is the central correction to the original draft, which assumed one Linear tracker
and one Codex backend.

- **`TrackerProvider`** registered in a `TrackerRegistry`. Adding a tracker is one provider plus one
  registration. Built-in providers ship as `extensions/{linear,jira,local,slack,memory}-tracker`.
  See [extensions/tracker-provider](../extensions/tracker-provider.md).
- **`AgentExecutorProvider`** registered in an `AgentExecutorRegistry`, matched against
  `agents.<kind>.executor`. The shipped provider is `acpExecutorProvider` with selector `acp`. See
  [extensions/agent-executor](../extensions/agent-executor.md).
- **`ToolProvider`** mounts a tool pack into agent sessions. A tracker exposes agent tools by
  implementing `defaultToolPacks(settings)`, which names the registered packs it owns. The Jira
  extension owns the `jira` pack of seven `jira_*` tools. See
  [extensions/tool-pack](../extensions/tool-pack.md) and
  [reference/tracker-tools](tracker-tools.md).
- **`WorkerDriver`** / `WorkerDriverFactory` (from `@lorenz/worker-sdk`) back the worker pool,
  including out-of-tree module specifiers. The only shipped pool driver is
  `extensions/docker-worker`. See [extensions/worker-driver](../extensions/worker-driver.md).

## 3. Domain model

### 3.1 Issue

The normalized issue record used by dispatch, prompt rendering, and observability.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable tracker-internal ID; used for lookups and map keys. |
| `identifier` | string | Human-readable key (`ABC-123`); used for logs and workspace naming. |
| `title` | string | |
| `description` | string or null | |
| `priority` | integer or null | Lower numbers sort earlier; null sorts last. |
| `state` | string | Current tracker state name. |
| `state_type` | string or null | Tracker state category, e.g. `unstarted`; drives the blocker rule. |
| `branch_name` | string or null | Tracker-provided branch metadata. |
| `url` | string or null | |
| `assignee_id` | string or null | Tracker user ID when present. |
| `labels` | list of strings | Normalized to lowercase. |
| `assigned_to_worker` | boolean | Whether the issue is routed to this instance after assignee filtering. |
| `blocked_by` | list of blocker refs | Each ref carries `id`, `identifier`, `state`. |
| `created_at` | timestamp or null | |
| `updated_at` | timestamp or null | |

### 3.2 Identifiers and normalization

- **Workspace key**: derive from `issue.identifier`, replacing any character outside `[A-Za-z0-9._-]`
  with `_`. Sanitization is idempotent.
- **Normalized state**: compare states case-insensitively after trimming whitespace.
- **Slot key**: `${issueId}:${slotIndex}`. Every running, reserved, and retry entry is keyed by slot
  key, not bare issue ID. A solo run uses slot `0`.
- **Session ID**: composed as `<thread_id>-<turn_id>` for display.

### 3.3 Orchestrator runtime state

The single authoritative in-memory `OrchestratorState`, owned and mutated only by the orchestrator:

| Field | Shape | Meaning |
| --- | --- | --- |
| `running` | `Map<slotKey, RunningEntry>` | Live runs. |
| `reserved` | `Map<slotKey, ReservationRecord>` | Pool-governed slots mid-acquire, host-less. |
| `claimed` | `Set<slotKey>` | Keys that are running or reserved. |
| `retryAttempts` | `Map<slotKey, RetryEntry>` | Scheduled retries. |
| `completed` | `Set<issueId>` | Bookkeeping only; never gates dispatch. |
| `usageTotals` | aggregate | Cumulative tokens plus runtime seconds. |
| `rateLimits` | `unknown` | Latest rate-limit payload; display only. |
| `blockedDispatches` | list | Issues skipped this tick with a cap reason. |

The draft `SPEC.md` omits `reserved` and `blockedDispatches` and keys retries by bare issue ID. Code
includes both maps and keys retries by slot key.

There is no database. Restart recovery is tracker-driven and filesystem-driven: the orchestrator
rebuilds `OrchestratorState` from scratch on boot, re-fetches candidate and tracked issues, cleans
terminal workspaces from disk, and re-dispatches whatever is still eligible. No retry timers or live
sessions survive a restart.

## 4. Workflow contract

`WORKFLOW.md` is the repository-owned policy file: a Markdown body (the prompt template) with
optional YAML front matter (the config). See [workflows](../workflows.md) and
[reference/workflow-prompt](workflow-prompt.md).

### 4.1 Discovery and parsing

Path precedence: an explicit CLI/runtime path, else `WORKFLOW.md` in the process working directory.
A missing file is a `missing_workflow_file` error.

Parsing: if the file starts with `---`, lines up to the next `---` parse as YAML front matter and the
rest is the prompt body. Front matter must decode to a map; non-map YAML is an error. With no front
matter, the whole file is the body and the config is empty. The body is trimmed. The returned
`config` is the front-matter root object, not nested under a `config` key.

### 4.2 Config keys a user writes

Config keys in front matter are snake_case. The complete table with defaults lives in
[reference/configuration](configuration.md); this is the spec-level summary of the keys and their
meaning.

| Key | Default | Meaning |
| --- | --- | --- |
| `tracker.kind` | required | Provider selector (`linear`, `jira`, `local`, `slack`, `memory`). |
| `tracker.active_states` | `[Todo, In Progress]` | States eligible for dispatch. |
| `tracker.terminal_states` | `[Closed, Cancelled, Canceled, Duplicate, Done]` | Terminal states; trigger workspace cleanup. |
| `tracker.dispatch.route_label_prefix` | `Lorenz:` | Prefix that turns a label into a route. |
| `tracker.dispatch.accept_unrouted` | `true` | Accept issues with no route label. |
| `tracker.dispatch.only_routes` | `null` | `null` accepts all routed; `[]` accepts none; a list accepts matches. |
| `polling.interval_ms` | `30000` | Poll cadence. |
| `workspace.root` | `<system-temp>/lorenz_workspaces` | Workspace root. |
| `hooks.after_create` / `before_run` / `after_run` / `before_remove` | unset | Shell hooks. |
| `hooks.timeout_ms` | `60000` | Hook timeout; non-positive falls back to the default. |
| `worker.ssh_hosts` | `[]` | Static SSH host pool; empty means local. |
| `worker.ssh_timeout_ms` | `60000` | SSH command timeout. |
| `worker.max_concurrent_agents_per_host` | falls back to `agent.max_concurrent_agents` | Per-host cap. |
| `agent.max_concurrent_agents` | `10` | Global concurrency cap. |
| `agent.max_turns` | `20` | Back-to-back turns per worker lifetime. |
| `agent.max_retry_backoff_ms` | `300000` | Failure backoff cap (5 minutes). |
| `agent.ensemble_size` | `1` | Default slots per issue. |
| `agents.<kind>.executor` | `acp` | Executor selector for an agent kind. |
| `agents.<kind>.bridge_command` | required for `acp` | The ACP bridge subprocess command. |
| `agents.<kind>.usage_accounting` / `provider_config` / `strict_mcp_config` | executor-defined | ACP option keys. |
| `observability.dashboard_enabled` | `true` | Enable the status surface. |
| `observability.refresh_ms` | `1000` | Status refresh interval. |
| `server.port` | `4040` | Bind port for the web server. The server is gated by `--no-dashboard`, not this key; CLI `--port` overrides it. |
| `server.host` | `127.0.0.1` | Bind host. |
| `logging.log_file` | `~/.lorenz/log/lorenz.log` | JSON event log target. |
| `status_overrides.<state>` | unset | Per-state partial overrides of agent settings. |

#### Agent config: the corrected model

The draft modeled `agent.kind` (codex or claude) with top-level `codex:` and `claude:` blocks. Code
uses an open `Settings.agents` record keyed by agent name. A `codex:` or `claude:` block is
parse-time sugar merged into `agents.<name>`; neither key exists on `Settings` at runtime. Each
agent record selects a driver with `agents.<kind>.executor`, resolved through the
`AgentExecutorRegistry`. The shipped executor is `acp`; an unknown selector raises
`unsupported agents.<kind>.executor`.

`status_overrides` maps a normalized state name to a partial `agent` override. State keys are trimmed
and lowercased. Unknown sections or fields are configuration errors. Partial overrides merge into the
base settings for that state, which is how a single state can raise its own concurrency cap or pick a
different executor.

### 4.3 Prompt template

The body is rendered per turn with strict variable and filter checking; an unknown variable or
filter fails rendering. Template inputs:

- `issue` - all normalized issue fields, including `labels` and `blocked_by`.
- `attempt` - null or absent on the first attempt, an integer on a retry or continuation.
- `ensemble` - `{enabled, slot_index, size}` where `enabled` is true when `size > 1` and
  `slot_index` is zero-based.

If the body is empty, the runtime may fall back to a minimal default prompt. A file read or parse
failure is a validation error and does not silently fall back.

### 4.4 Validation and reload

Error classes: `missing_workflow_file`, `workflow_parse_error`,
`workflow_front_matter_not_a_map`, `template_parse_error`, `template_render_error`.

Reload is required and live. The runtime watches `WORKFLOW.md` and re-reads it on change, and
re-validates defensively before each poll in case a watch event is missed. An invalid reload keeps
the last-known-good effective configuration and emits `workflow_reload_failed`; it never crashes the
service. A successful reload emits `workflow_reloaded`. Reload is transactional: the runtime runs all
throwing side effects first (the slots-per-machine gate, then the worker-pool coordinator reconcile)
and only swaps the live workflow, orchestrator settings, and tracker client after they all succeed.
In-flight sessions are not restarted on reload. See
[features/workflow-hot-reload](../features/workflow-hot-reload.md).

Dispatch preflight validation runs at startup (failure fails startup) and before every dispatch
cycle. It checks that the workflow loads and parses, `tracker.kind` is present and supported, the
tracker credential resolves after `$` indirection, the tracker project identity is present when the
provider requires it, and the configured executor command is non-empty.

## 5. Orchestration state machine

The orchestrator is the only mutator of scheduling state. All worker outcomes are reported back to
it and converted into explicit transitions. See [agent-orchestrator](../agent-orchestrator.md).

### 5.1 Issue claim states

These are the service's internal claim states, distinct from tracker states.

1. `Unclaimed` - not running, no retry scheduled.
2. `Claimed` - reserved to prevent duplicate dispatch; in practice either running or retry-queued.
3. `Running` - tracked in the `running` map.
4. `RetryQueued` - a retry timer exists in `retryAttempts`.
5. `Released` - claim removed because the issue is terminal, non-active, missing, or the retry path
   completed without re-dispatch.

A normal worker exit does not mean the issue is finished. One worker may run multiple back-to-back
turns on the same live agent thread in the same workspace, up to `agent.max_turns`, re-checking the
tracker state after each turn. The first turn sends the full rendered prompt; continuation turns send
only continuation guidance to the existing thread. If a state refresh changes the effective backend
profile (the `agents.<kind>.executor` or its options), the worker ends the session and yields so a
future attempt starts with the new profile. After a normal exit the orchestrator always schedules a
short continuation retry to re-check whether the issue still needs another session.

### 5.2 Poll tick

The runtime serializes polls. Concurrent calls queue and merge intents (`dryRun` AND-ed,
`waitForRuns` OR-ed). The verified per-tick order in code is:

1. Reload `WORKFLOW.md` if configured.
2. Run dispatch preflight validation.
3. Startup terminal-workspace cleanup (once).
4. Stall reconciliation (Part A).
5. Tracked-issue reconciliation (Part B).
6. Fetch candidate issues.
7. Compute eligibility.
8. Sync retry timers (skipped on dry-run).
9. Dispatch each eligible issue, or emit `dry_run`.
10. Optionally await all dispatched runs.

This corrects the draft, which placed reconciliation before validation. Validation runs before
reconciliation. If validation throws, the whole poll aborts into the `poll_error` path and
reconciliation does not run that tick.

### 5.3 Dispatch eligibility

An issue is eligible only when all hold. See [dispatch](../dispatch.md) for the decision tree.

- It has `id`, `identifier`, `title`, and `state`.
- Its state is in `active_states` and not in `terminal_states`.
- It is routed to this worker. `assigned_to_worker == false` excludes it. With no route label,
  `accept_unrouted` decides. With a route label, `only_routes` decides: `null` accepts any routed
  issue, `[]` accepts none, a list accepts the intersection of normalized routes. A blank route such
  as a bare prefix is routed-but-invalid and excluded.
- For an `unstarted` state type, no blocker is non-terminal. When no state type is available, state
  name `Todo` is treated as the unstarted default. Blockers on started issues are ignored.
- It has at least one unclaimed ensemble slot.
- Global, per-state, and worker-host capacity all have room.

Dispatch sort order is deterministic and total: `priority` ascending (null or out-of-range sorts
last as `Number.MAX_SAFE_INTEGER`), then `created_at` ascending (unparseable or empty sorts last),
then `identifier` by `localeCompare`. Sorting an already-sorted list is identical, and the result is
a permutation of the input.

### 5.4 Concurrency

Capacity is checked in a fixed precedence and reported as one of three reasons: global
`agent.max_concurrent_agents` (`global_concurrency_cap`), the per-state cap from
`status_overrides[state].agent.max_concurrent_agents` (`local_concurrency_cap`), then worker-host
capacity (`worker_host_capacity`). Reserved slots mid-acquire count toward both the global and
per-state caps: `occupiedSlotCount = running.size + reserved.size`, so dispatch cannot exceed the cap
during an acquire window. An ineligible issue reports no cap reason; only an eligible-but-blocked
issue does.

### 5.5 Context ensembles

An issue can request several independent slots. Size resolves in order: the first valid
`ensemble:<n>` label (`n >= 1`), then `agent.ensemble_size` for the issue's effective state, then
`1`. Slots are zero-based `0..size-1` and claimed independently as `{issueId, slotIndex}`. Global,
per-state, and host capacity apply per slot. The retry entry can re-dispatch a missing slot and
preserves the triggering slot index. See [features/context-ensembles](../features/context-ensembles.md).

### 5.6 Retry and backoff

After a clean worker exit the orchestrator always schedules a **continuation** retry: a fixed
`1000` ms delay, attempt fixed to `1`, scheduled even when the issue is now inactive (reconciliation
prunes it later). After a fault it schedules a **failure** retry: attempt is the prior attempt plus
one, delay is `min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`. So failure attempt 1 is
10s, 2 is 20s, 3 is 40s, capped at the configured maximum (default `300000` ms). Backoff is pure
exponential on attempt count.

There is no Retry-After or 429-driven backoff. `rate_limit` is a display-only agent-update field
captured in `rateLimits`; it does not influence retry timing. A claim of HTTP-429 honoring would be
incorrect.

Retries are due-checked against a monotonic clock, not wall time. The `RetryScheduler` fires each
retry timer `5` ms after its monotonic deadline (a guard against firing before the issue is
considered due) and nudges a poll; timers are `unref()`'d so they never hold the process open.
Scheduling a new timer for an issue clears the existing one.

When a retry fires: re-fetch active candidates, find the issue by ID. If absent, release the claim.
If present and eligible with a free slot, dispatch. If present but no slots are free, requeue with
error `no available orchestrator slots` and attempt `+1`. If present but no longer active, release.

### 5.7 Reconciliation

Reconciliation runs every tick before dispatch, in two parts. See
[dispatch](../dispatch.md#reconciliation) for the decision tree.

**Part A, stall detection.** For each running entry, elapsed time is measured from
`last_agent_timestamp` if any event has been seen, else `started_at`. When elapsed exceeds the
effective `agents.<kind>.stall_timeout_ms` the run is finished as a failure, recorded `stalled`,
aborted, and its worker forced to poison. A non-positive stall timeout disables stall detection.

**Part B, tracker state refresh.** Tracked issue IDs (running, reserving, and retrying) are
re-fetched. For each:

- Terminal state: stop the run and clean the workspace (`workspace_cleanup`).
- Non-active and non-terminal state: stop the run, keep the workspace.
- Assignee no longer matches this worker: stop the run, keep the workspace.
- Route labels no longer match: stop the run, keep the workspace.
- Still active and routed and unblocked: refresh the in-memory issue snapshot (`run_reconciled`).
- An issue missing from the refetch is reconciled as missing.

If the refetch itself fails, every worker keeps running and the tick emits `reconcile_refresh_failed`
to retry next tick.

The reconciliation stop reason is classified as one of `terminal`, `unrouted`, `blocked`,
`inactive`.

### 5.8 Two-phase pool dispatch

When a worker pool governs capacity, dispatch is two-phase. `claim()` returns a host-less
`ReservationRecord` (claimed and reserved, surfaced in a separate `reserving` lane, emits
`run_reserving`). The runtime then awaits the coordinator's `acquireRunSlot`. On `bound` it binds the
host into a `RunningEntry` and emits `run_started`. On `no_capacity` it cancels the reservation with
no backoff (restoring the consumed retry so affinity and attempt count survive) and emits
`dispatch_skipped` with reason `worker_host_capacity`. On an acquire throw it emits `dispatch_skipped`
with `worker_pool_acquire_error`. Reservation tokens are an ABA guard: bind and cancel are no-ops on
token mismatch, and a defensive expiry of `acquireTimeoutMs * 2 + 60000` ms sweeps a hung
reservation. Without a governing pool, `claim()` mints the running entry immediately by selecting the
least-loaded host among `worker.ssh_hosts` (honoring the per-host cap) and emits `run_started` right
away. See [workers/worker-pool](../workers/worker-pool.md).

## 6. Workspace management and safety

### 6.1 Layout

Per-issue workspace path: `<workspace.root>/<sanitized_issue_identifier>`. For an ensemble of
`size > 1`, the issue root is a container and each slot runs in
`<workspace.root>/<sanitized_issue_identifier>/<slot_index>`; hooks and the agent run in the slot
directory. For `size == 1`, the run uses the issue root directly. Workspaces are reused across runs
for the same issue; a successful run never auto-deletes a workspace. See [workspace](../workspace.md).

### 6.2 Hooks

| Hook | When | On failure |
| --- | --- | --- |
| `after_create` | Only when the directory is newly created. | Fatal to workspace creation. |
| `before_run` | Before each attempt, after preparation, before launch. | Fatal to the current attempt. |
| `after_run` | After each attempt, success or failure, once the workspace exists. | Logged, ignored. |
| `before_remove` | Before deletion, if the directory exists. | Logged, ignored; cleanup proceeds. |

Hooks run with the workspace directory as `cwd` and enforce `hooks.timeout_ms` (default `60000`).

### 6.3 Safety invariants

These are the load-bearing portability constraints. Code is stricter than the draft `SPEC.md`, which
listed only the first three.

- The agent's `cwd` equals the validated workspace path for the run.
- The workspace path is a strict descendant of the workspace root, with both normalized to absolute.
  A path equal to the workspace root is rejected.
- Workspace directory names contain only `[A-Za-z0-9._-]`; any other character becomes `_`, and
  sanitization is idempotent.
- A symlinked workspace path is rejected.
- A path containing control characters (newline, carriage return, null byte) is rejected.

## 7. Agent runner protocol

Lorenz drives coding agents over the Agent Client Protocol (ACP). This replaces the draft's
Codex app-server JSON-RPC handshake; the draft's `initialize` / `initialized` / `thread/start` /
`turn/start` transcript and its `codex app-server` command default no longer describe the
implementation.

The shipped executor provider is `acpExecutorProvider` with selector `acp`. An agent record selects
it through `agents.<kind>.executor: acp` and configures it with these option keys (snake_case in
front matter, listed with their canonical aliases):

| Front-matter key | Internal | Meaning |
| --- | --- | --- |
| `bridge_command` | `bridgeCommand` | The ACP bridge subprocess command. Required; the legacy `command` key folds into it. |
| `usage_accounting` | `usageAccounting` | Token-accounting mode; inferred from the bridge command when omitted. |
| `provider_config` | `providerConfig` | Provider-specific configuration passed to the bridge. |
| `strict_mcp_config` | `strictMcpConfig` | Launch the agent with only the injected MCP configuration. |

The executor launches the bridge subprocess in the workspace, drives one ACP session across the
worker's turns, and forwards normalized agent updates to the orchestrator. The session lifecycle
(first turn sends the full prompt, continuation turns send only guidance, turn count bounded by
`agent.max_turns`, profile change ends the session) matches Section 5.1. See
[agents/acp-bridges](../agents/acp-bridges.md) and [agents/index](../agents/index.md).

Tooling reaches the agent through MCP, not a Codex client-tool channel. The mounted set is driven by
the dispatch tracker's `defaultToolPacks()` plus the workflow `tools:` map keys, de-duplicated and
collision-checked. The Jira extension's `jira` pack mounts seven tools: `jira_read_issue`,
`jira_query`, `jira_update_status`, `jira_list_comments`, `jira_comment`,
`jira_update_comment`, `jira_create_issue`. This replaces the draft's single `linear_graphql`
tool. Generated MCP config is workspace-local and
carries only the Lorenz-issued bearer token for the local endpoint; raw tracker secrets are never
written to disk. Remote workers reach the local MCP endpoint through an SSH tunnel or equivalent
forwarding, and acquired tokens and tunnels are released when a session stops. See
[reference/tracker-tools](tracker-tools.md) and [agents/skills](../agents/skills.md).

Approval, sandbox, and user-input posture is implementation-defined. The contract is that an approval
or user-input request must not leave a run stalled forever: an implementation satisfies it, surfaces
it to an operator, auto-resolves it, or fails the run by a documented policy. An unsupported tool
call returns a failure result and continues the session rather than stalling.

The stop reason classifies the next action: `end_turn`, `max_tokens`, and `max_turn_requests`
continue; `cancelled` cancels; anything else, including `refusal`, retries.

## 8. Tracker integration contract

A tracker provider must support three read operations, used by the poll loop:

1. Fetch candidate issues in the configured active states for the configured project.
2. Fetch issues by ID, for active-run reconciliation.
3. Fetch issues by state, for startup terminal cleanup. An empty state list returns empty without a
   network call.

Normalization produces the Section 3.1 issue shape: labels lowercased; `state_type`, `assignee_id`,
and `assigned_to_worker` set; `blocked_by` derived from inverse `blocks` relations; `priority`
coerced to integer or null; timestamps parsed as ISO-8601. On a candidate-fetch failure the tick logs
and skips dispatch; on a refresh failure it keeps workers running; on a startup-cleanup failure it
logs and continues startup.

Tracker writes are out of scope for the orchestrator: ticket mutations run through the agent's
`jira_*` tools. Built-in providers ship as `extensions/{linear,jira,local,slack,memory}-tracker`.
See [trackers/index](../trackers/index.md), [trackers/linear](../trackers/linear.md),
[trackers/jira](../trackers/jira.md), [trackers/local](../trackers/local.md), and
[trackers/slack](../trackers/slack.md).

## 9. Observability

### 9.1 Runtime snapshot

One `RuntimeSnapshot` feeds every consumer: the TUI, the web dashboard, and the HTTP API. It
carries `appStatus`, `workflowPath`, a `poll` block (status, candidates, eligible, last and next poll
times, last error), the `running`, `reserving`, `retrying`, and `blocked` lanes, `runHistory`,
`usageTotals`, `rateLimits`, `logFile`, and `recentEvents`. The `reserving` lane is the host-less
two-phase reservations, kept separate from `running`. A `ProjectionActor` bounds the ring buffers to
the last `20` events and last `50` run-history entries. There is no persisted log beyond the optional
`logging.log_file` sink. See [observability](../observability.md).

### 9.2 Events

The runtime emits a fixed orchestrator-level event vocabulary, the authoritative list for
[reference/events](events.md):

```
dry_run            poll_error            dispatch_skipped       run_reserving
run_started        dispatch_refresh_failed  run_completed       run_failed
workflow_reloaded  workflow_reload_failed   reconcile_refresh_failed  workspace_cleanup
run_reconciled     run_stalled              startup_workspace_cleanup
startup_workspace_cleanup_failed  retry_timer_due  retry_timer_error  refresh_error
```

Run-history outcomes are `success`, `failed`, `stalled`, `canceled`. The runtime records only
`success`, `failed`, and `stalled` today; `canceled` is defined but unused, since reconciliation
cleans up without writing a history entry. These names replace the draft's Codex-flavored event names
(`session_started`, `turn_completed`, `approval_auto_approved`, and the rest), which the runtime does
not emit at this level.

### 9.3 Token accounting

Usage merges monotonically. Cumulative totals track deltas against the last reported watermark to
avoid double-counting; incremental deltas are deduped against already-reported deltas. Token counters
never decrease and never go negative. Runtime seconds are added only when a session ends and are
reported as a live aggregate that adds active-session elapsed time at snapshot time. Rate-limit data
is captured for display and never drives logic.

### 9.4 Optional HTTP server

The HTTP server runs by default and is disabled with `--no-dashboard`. `server.port` in front matter
and the CLI `--port` set the bind port (`--port` wins). It binds loopback by default. It serves a dashboard at `/` and a read-only JSON API
under `/api/v1/*` with a `/api/v1/state` summary, a `/api/v1/<issue_identifier>` detail (404 when the
issue is unknown), and a `POST /api/v1/refresh` trigger that queues a poll and reconcile. Errors use
a `{"error":{"code","message"}}` envelope; an unsupported method on a defined route returns `405`.
The server is observability and control only and is never required for orchestrator correctness. See
[reference/http-api](http-api.md).

## 10. Security and safety posture

Each implementation defines its own trust boundary and documents whether it relies on auto-approval,
operator approval, sandboxing, or a combination. Mandatory filesystem controls: the workspace path
stays under the workspace root, the agent `cwd` is the per-issue workspace, and directory names are
sanitized (Section 6.3). `$VAR` indirection resolves secrets at runtime without logging them; secret
presence is validated without printing. Workspace hooks are fully trusted shell scripts from
`WORKFLOW.md` and run inside the workspace with an enforced timeout. Tracker data, repository
contents, prompt inputs, and tool arguments should not be assumed fully trustworthy; hardening
(tighter sandbox and approval settings, OS or container isolation, narrowing eligible issues,
reducing exposed tools and credentials) is part of the safety model, not an afterthought. See
[security](../security.md).

## 11. Failure and recovery model

| Failure class | Recovery |
| --- | --- |
| Workflow or config failure | Skip new dispatches, keep the service alive, continue reconciliation where possible. |
| Worker failure | Convert to a retry with exponential backoff. |
| Candidate-fetch failure | Skip this tick, retry next tick. |
| Reconciliation refresh failure | Keep current workers, retry next tick. |
| Observability failure | Never crash the orchestrator or affect dispatch. |

Restart recovery is in-memory by design: no retry timers and no running sessions are restored. The
service recovers through startup terminal-workspace cleanup, a fresh poll of active issues, and
re-dispatch of eligible work. Operators steer behavior by editing `WORKFLOW.md` (re-applied live) or
by changing tracker states: moving an issue to a terminal state stops its run and cleans the
workspace at reconcile; moving it to a non-active state stops the run without cleanup. See
[troubleshooting](../troubleshooting.md).

## 12. Conformance and tests

A conforming implementation ships tests across three profiles.

- **Core conformance** - deterministic tests required of every implementation: workflow and config
  parsing, workspace safety, the tracker client contract, dispatch and reconciliation and retry,
  the executor client, observability, and CLI lifecycle.
- **Extension conformance** - required only for optional features an implementation ships: context
  ensembles, per-state `status_overrides`, the worker pool and SSH workers, the HTTP server, and the
  `jira_*` tool pack.
- **Real integration profile** - environment-dependent smoke checks recommended before production,
  skippable when credentials or network are unavailable; a skipped check is reported skipped, not
  silently passed.

In this repository the deterministic conformance suite is the chaos sandbox. It runs the real
`LorenzRuntime` against a fake tracker, a fake agent runner, and a fake clock, so scenarios execute
in virtual time and assert behavioral invariants. The default clock is fake: retry, backoff, and tick
timing run in virtual time, so a scenario completes near-instantly. The fake-clock driver drains
microtasks and fires the earliest pending timer; more than three idle flushes with no pending timer
is treated as a stall and throws, emulating the real stall watchdog. The sandbox assertion vocabulary
covers running counts, `is_running` and `not_running`, event occurrence, retry count, usage bounds,
final state, dispatch order, blocker respect, and the concurrency cap. The behavioral requirements the
suite encodes are written in EARS form in `sandbox/INVARIANTS.md` across seventeen groups: workspace
containment, dispatch ordering, dispatch eligibility, routing, state classification, ensemble
resolution, retry and backoff, usage accounting, worker-host selection, config overrides,
orchestrator scheduling, reconciliation, workflow validation, agent execution, hooks, secrets, and
observability.

Tests are organized by filename prefix: `sandbox-*` for deterministic conformance, `live-*` and
`worker-pool-*` for environment-dependent integration, and `tracker-extension`,
`architecture-boundaries`, `docs-workflows`, and `github-workflows` for contract and documentation
guards.

## 13. Roadmap

These are specified but not shipped. They live in [roadmap/index](../roadmap/index.md).

- **Durable scheduler state.** Persisting the retry queue and session metadata across restarts.
  Today the orchestrator state is in-memory only and recovery is tracker-driven.
- **First-class tracker writes in the orchestrator.** State transitions and comments from the
  orchestrator rather than only through agent tools.
- **Additional out-of-tree worker drivers.** The worker driver interface and the worker pool are
  pluggable, but the only shipped pool driver is `docker-worker`. Other targets are possible to add,
  not present as code.

The draft's "pluggable tracker adapters beyond Linear" item is done: the `TrackerRegistry` and the
five shipped trackers satisfy it.

## See also
- [architecture](../architecture.md) - the package-level map this spec describes
- [agent-orchestrator](../agent-orchestrator.md) - the runtime loop and orchestrator state in depth
- [dispatch](../dispatch.md) - eligibility, routing, caps, and reconciliation decision trees
- [reference/configuration](configuration.md) - every config key, default, and alias
- [reference/events](events.md) - the full event vocabulary and run-history outcomes
