# Symphony Behavioral Invariants (EARS Format)

System-level behavioral requirements expressed in EARS (Easy Approach to Requirements Syntax). These are implementation-agnostic properties that any conforming implementation must satisfy.

---

## Workspace Containment

- When a workspace path is resolved, the path SHALL be a strict descendant of the workspace root.
- When directory names are derived from identifiers, the names SHALL contain only alphanumeric characters, dots, hyphens, and underscores.
- When sanitization is applied to a name, applying sanitization again SHALL produce the same result (idempotent).
- When the same inputs are provided, the system SHALL produce the same workspace path (deterministic).
- When a multi-slot ensemble is resolved, each slot SHALL receive a distinct workspace path.
- When a single-slot run is resolved, the workspace path SHALL have no slot suffix.
- When a workspace path contains symlinks, the system SHALL reject it.
- When a workspace path is equal to the workspace root, the system SHALL reject it.
- When a workspace path contains control characters (newlines, carriage returns, null bytes), the system SHALL reject it.

## Dispatch Ordering

- When sort is applied to a dispatch list, the result SHALL be a permutation of the input (no additions or drops).
- When sort is applied to an already-sorted list, the result SHALL be identical (idempotent).
- When two dispatches differ in priority number, the one with the lower priority number SHALL sort first.
- When two dispatches share the same priority, the one with the earlier creation time SHALL sort first.
- When two dispatches share the same priority and creation time, the one with the lexicographically earlier identifier SHALL sort first.
- When a dispatch has null, missing, or out-of-range priority, it SHALL sort last.
- When a dispatch has null, missing, or unparseable creation time, it SHALL sort last within its priority group.

## Dispatch Eligibility

- When a dispatch is missing required fields (id, identifier, title, state), it SHALL be ineligible.
- When a dispatch is in a terminal state, it SHALL be ineligible.
- When a dispatch is in a non-active state, it SHALL be ineligible.
- When a dispatch is not assigned to this worker, it SHALL be ineligible.
- When an unstarted issue has a non-terminal blocker, it SHALL be ineligible.
- When a non-unstarted issue has blockers, it SHALL still be eligible.
- When an unstarted issue has only terminal blockers, it SHALL be eligible.
- When the global concurrency cap is reached, the system SHALL not dispatch new work.
- When a per-state concurrency cap is reached, the system SHALL not dispatch new work in that state.
- When all worker hosts are at capacity, the system SHALL not dispatch new work.
- When all ensemble slots are claimed, the dispatch SHALL be ineligible.

## Routing

- When route names are normalized, normalization SHALL be case-insensitive.
- When route name normalization is applied twice, the result SHALL be the same (idempotent).
- When route names are normalized, leading and trailing whitespace SHALL be stripped.
- When a route name after prefix removal is whitespace-only, it SHALL not be valid.
- When prefix matching is performed, matching SHALL be case-insensitive.
- When the allowlist is null, the system SHALL accept all routes.
- When the allowlist is empty, the system SHALL reject all routes.
- When no route label is present and unrouted dispatch is disabled, the dispatch SHALL be ineligible.
- When prefix matching succeeds but the remaining name is whitespace-only, the route SHALL be rejected as routed-but-invalid.

## State Classification

- When states are normalized, normalization SHALL be case-insensitive.
- When state normalization is applied twice, the result SHALL be the same (idempotent).
- When states are normalized, leading and trailing whitespace SHALL be stripped.
- When a state value is null or undefined, it SHALL be classified as non-terminal.
- When a state value is unknown, it SHALL be classified as non-terminal.
- When states are compared, comparison SHALL be case-insensitive and whitespace-tolerant.

## Ensemble Resolution

- When a valid label with a positive integer is present, the system SHALL use that integer as ensemble size.
- When multiple valid labels are present, the system SHALL use the first encountered.
- When a label specifies zero or a negative integer, the system SHALL ignore it and use the default.
- When matching ensemble labels, matching SHALL be case-insensitive and whitespace-insensitive.
- When no valid ensemble label is present, the system SHALL use the configured default.

## Retry and Backoff

- When a retry delay is calculated, it SHALL be non-negative.
- When failure retry delay is calculated, it SHALL be monotonically non-decreasing with attempt number.
- When a retry delay is calculated, it SHALL never exceed the configured maximum cap.
- When a retry delay is calculated, the minimum delay floor SHALL prevent zero-delay storms.
- When a continuation retry is scheduled, it SHALL use a fixed short delay regardless of attempt number.

## Usage Accounting

- When token counts are updated, they SHALL never become negative.
- When token counters are updated, they SHALL never decrease (monotonic growth).
- When global aggregates are updated, they SHALL never decrease.
- When reported-totals watermark is updated, it SHALL stay in sync with entry totals.
- When usage is accounted, seconds-running SHALL be preserved independently.
- When the same update is applied twice, the result SHALL be the same (idempotent).

## Worker Host Selection

- When a host is selected, it SHALL be from the configured list or "no host available" SHALL be returned.
- When hosts are evaluated, only hosts with load strictly below the cap SHALL be considered.
- When multiple hosts are below the cap, the host with the lowest load SHALL be selected.
- When the host list is empty, "no host available" SHALL be returned.
- When at least one host is below the cap, the system SHALL always select a host (no false starvation).

## Configuration Overrides

- When no override is present, the base settings SHALL remain unchanged.
- When override lookup is performed, it SHALL be case-insensitive.
- When overrides are defined for different states, they SHALL apply independently.
- When a partial override is applied, unmentioned fields SHALL be preserved.
- When nested map fields are overridden, they SHALL be deep-merged.

## Orchestrator Scheduling

- While the orchestrator is running, there SHALL be no duplicate concurrent workers for the same issue-slot pair.
- While the orchestrator is running, claimed slots SHALL be either running or scheduled for retry.
- When a poll tick occurs, the system SHALL reconcile before dispatching.
- When a worker exits normally, the system SHALL schedule a short continuation retry.
- When a worker exits abnormally, the system SHALL schedule an exponential backoff retry.
- When a worker completes, runtime seconds SHALL be added only on completion.
- When absolute token totals are reported, the system SHALL use watermark deltas.

## Reconciliation

- When the tracker state is terminal, the system SHALL stop the worker and cleanup the workspace.
- When the tracker state is non-active and non-terminal, the system SHALL stop the worker and keep the workspace.
- When the assignee no longer matches, the system SHALL stop the worker and keep the workspace.
- When route labels no longer match, the system SHALL stop the worker and keep the workspace.
- When tracker refresh fails, the system SHALL keep the worker running and retry on the next tick.

## Workflow Validation

- When a workflow file is missing, the system SHALL produce a typed error and prevent startup.
- When YAML front matter is not a map, the system SHALL produce a typed error.
- When an unknown prompt variable is encountered, the system SHALL fail strictly.
- When dispatch validation fails, the system SHALL skip dispatches but continue reconciliation.
- When a reload produces invalid configuration, the system SHALL retain the last-known-good configuration and emit an error.

## Agent Execution

- When an agent run starts, the working directory SHALL be set to the validated workspace path.
- When the first turn begins, the system SHALL send the full rendered prompt.
- When a continuation turn begins, the system SHALL send only the continuation guidance.
- When the backend profile changes between turns, the system SHALL end the session and yield to the orchestrator.
- When the turn count reaches the maximum, the system SHALL end the session.

## Resume State

- When resume state is evaluated, reuse SHALL occur only when agent kind, issue identity, workspace, and host all match.
- When a failure, stall, or force-terminate occurs, the system SHALL invalidate resume state before retry.

## Hooks

- When a fresh workspace is created, the system SHALL run the after-create hook.
- When an existing workspace is reused, the system SHALL skip the after-create hook.
- When a before-run hook fails, the system SHALL abort the run.
- When an after-run hook fails, the system SHALL log the failure and continue.
- When a before-remove hook fails, the system SHALL proceed with cleanup.
- When hooks are executed, all hooks SHALL enforce the configured timeout.

## Secret Handling

- When environment variable indirection is used for secrets, the system SHALL resolve values at runtime without logging secrets.

## Observability

- When dashboard, log, or status operations fail, the failure SHALL NOT crash the orchestrator or affect dispatch.
- When multiple usage events occur, the system SHALL maintain correct aggregates.

## Issue Normalization

- When a state value is resolved, the system SHALL accept nested object form, snake_case, camelCase, and direct string form (in that priority order).
- When labels are normalized, they SHALL be trimmed, lowercased, and empty strings filtered out.
- When blockers are resolved, the system SHALL prefer an explicit `blockers` array, falling back to filtering `relations` where type equals "blocks" (case-insensitive).
- When an assignee filter is configured and the issue has no assignee, the issue SHALL be marked as not assigned to this worker.
- When an assignee filter is configured, comparison SHALL be case-insensitive.
- When an issue is missing any of `id`, `identifier`, `title`, or `state`, normalization SHALL reject it.
- When a state type is normalized, only values in the canonical set (backlog, unstarted, started, completed, canceled, triage) SHALL be accepted; others become null.

## Prompt Rendering

- When the workflow prompt body is empty or whitespace-only, the system SHALL use a minimal default prompt.
- When a prompt template references an unknown variable, rendering SHALL fail strictly.
- When a prompt template references an unknown filter, rendering SHALL fail strictly.
- When a prompt is rendered, the `issue`, `attempt`, and `ensemble` objects SHALL be available as template inputs.
- When a first turn begins, the system SHALL send the full rendered prompt.
- When a continuation turn begins, the system SHALL send only continuation guidance (not the full prompt).

## Dynamic Reload

- When WORKFLOW.md changes, the system SHALL re-read and re-apply config and prompt without restart.
- When a reload produces invalid configuration, the system SHALL retain the last-known-good configuration and emit an error.
- When a reload succeeds, the new config SHALL affect future dispatch, retry scheduling, reconciliation, hook execution, and agent launches.
- When a reload changes poll interval, the system SHALL apply the new interval to future tick scheduling.
- When a reload changes concurrency limits, the system SHALL apply the new limits to subsequent dispatch decisions.

## Workspace Validation

- When a workspace path is validated, the system SHALL canonicalize both root and target via realpath before comparison.
- When a workspace path does not exist on the filesystem, validation SHALL reject it.
- When a workspace root itself is a symlink, validation SHALL reject it.
- When intermediate path segments contain symlinks within the root, validation SHALL reject the path.
- When a workspace path contains blank or whitespace-only components, validation SHALL reject it.
- When a remote workspace is validated, the system SHALL canonicalize paths on the remote host (via `pwd -P`).

## Dispatch Concurrency

- When the global concurrency cap is evaluated, the count of entries in the running map SHALL be compared against the configured limit.
- When a per-state concurrency cap is evaluated, only running entries in that specific state SHALL count toward the state limit.
- When both global and state-specific caps exist, both SHALL be satisfied for dispatch to proceed.
- When worker host capacity is tracked, each host's running count SHALL be computed from the running map entries assigned to that host.
- When host selection is performed, the least-loaded host below the cap SHALL be selected deterministically (first in config order on tie).

## Claim Lifecycle

- While a slot is claimed, it SHALL NOT be claimable by another dispatch.
- When a claim succeeds, any existing retry entry for that issue SHALL be removed.
- When a worker finishes, its slot key SHALL be removed from both `running` and `claimed`.
- When all ensemble slots for an issue are claimed, the issue SHALL be ineligible for further dispatch.
- When a retry becomes due, stale claims (claimed but not running) SHALL be released before re-dispatch.

## Running Entry Updates

- When an update targets an unknown slot key, the system SHALL silently ignore it (no error, no state change).
- When a turn_completed event is received, the turn count SHALL increment by exactly one.
- When usage totals are updated via watermark, entry totals SHALL never decrease (monotonic via max).
- When global usage totals are updated, only positive deltas (relative to last-reported values) SHALL be added.
- When a running entry is refreshed, all slots for that issue SHALL see the same updated issue state.

## Orchestrator Completion

- When an issue is cleaned up, all running entries, all claimed slots, and the retry entry for that issue SHALL be removed.
- When a worker finishes, runtime seconds SHALL be computed as elapsed time since `startedAt` and added to cumulative totals.
- When a worker finishes normally, the system SHALL schedule a continuation retry (not mark the issue as permanently done).
- When a snapshot is produced, it SHALL return defensive copies that do not alias internal state.

## SSH Worker Execution

- When an SSH command is executed, a timeout SHALL be enforced via cascading signals (SIGTERM then SIGKILL after grace period).
- When an SSH timeout occurs, the entire process group SHALL be terminated (not just the direct child).
- When a remote file is written, the system SHALL use `printf '%s'` to preserve exact byte content.
- When a remote file is written, parent directories SHALL be created first.
- When an SSH host is not reachable or ssh binary is missing, the system SHALL produce a typed error.
- When remote commands are constructed, arguments SHALL be shell-escaped to prevent injection.
