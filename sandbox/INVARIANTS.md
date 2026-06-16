# Lorenz Behavioral Invariants (EARS Format)

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
