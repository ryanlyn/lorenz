# Invariants

System-level behavioral requirements for Symphony, expressed in EARS format.
These are implementation-agnostic properties that any conforming implementation must satisfy.

## Workspace Containment

WHEN a workspace path is resolved for any issue,
THE SYSTEM SHALL produce a path that is a strict descendant of the configured workspace root.

WHEN a workspace directory name is derived from an issue identifier,
THE SYSTEM SHALL produce a name containing only alphanumeric characters, dots, hyphens, and underscores.

WHEN an identifier is sanitized and then sanitized again,
THE SYSTEM SHALL return an identical result (idempotent).

WHEN the same issue identifier and slot configuration are provided,
THE SYSTEM SHALL always produce the same workspace path (deterministic).

WHEN an ensemble has multiple slots,
THE SYSTEM SHALL produce a distinct workspace path for each slot index.

WHEN a single-slot run is requested,
THE SYSTEM SHALL produce a workspace path with no slot suffix.

WHEN a symbolic link exists at any segment of a workspace path,
THE SYSTEM SHALL reject the path and refuse to proceed.

WHEN a resolved workspace path equals the workspace root itself,
THE SYSTEM SHALL reject the path and refuse to use it as a working directory.

WHEN a workspace path contains control characters (newlines, carriage returns, or null bytes),
THE SYSTEM SHALL reject the path.

## Dispatch Ordering

WHEN issues are sorted for dispatch,
THE SYSTEM SHALL return a permutation of the input (no issues added or dropped).

WHEN issues are sorted for dispatch and sorted again,
THE SYSTEM SHALL return the same order (idempotent).

WHEN two issues have different valid priorities (1-4),
THE SYSTEM SHALL dispatch the lower-numbered priority first.

WHEN two issues have the same priority,
THE SYSTEM SHALL dispatch the one with the earlier creation time first.

WHEN two issues have the same priority and creation time,
THE SYSTEM SHALL break ties by lexicographic order of their identifier.

WHEN an issue has a null, missing, or out-of-range priority,
THE SYSTEM SHALL sort it after all valid-priority issues.

WHEN an issue has a null, missing, or unparseable creation time,
THE SYSTEM SHALL sort it after all valid-time issues within its priority group.

## Dispatch Eligibility

WHEN an issue is missing any required field (id, identifier, title, or state),
THE SYSTEM SHALL NOT consider it eligible for dispatch.

WHEN an issue is in a terminal state,
THE SYSTEM SHALL NOT consider it eligible for dispatch.

WHEN an issue is in a state not listed as active,
THE SYSTEM SHALL NOT consider it eligible for dispatch.

WHEN an issue is not assigned to this worker instance,
THE SYSTEM SHALL NOT consider it eligible for dispatch.

WHEN an unstarted issue has at least one non-terminal blocker,
THE SYSTEM SHALL NOT consider it eligible for dispatch.

WHEN a non-unstarted issue has non-terminal blockers,
THE SYSTEM SHALL still consider it eligible (blockers only gate unstarted issues).

WHEN an unstarted issue has only terminal blockers,
THE SYSTEM SHALL consider it eligible for dispatch (all blockers resolved).

WHEN the global concurrency limit is reached,
THE SYSTEM SHALL NOT dispatch any additional issues.

WHEN a per-state concurrency limit is reached,
THE SYSTEM SHALL NOT dispatch additional issues in that state.

WHEN all configured worker hosts are at capacity,
THE SYSTEM SHALL NOT dispatch additional issues.

WHEN all ensemble slots for an issue are already claimed,
THE SYSTEM SHALL NOT consider it eligible for dispatch.

## Routing

WHEN a route name is normalized,
THE SYSTEM SHALL produce the same result regardless of input letter casing.

WHEN a route name is normalized and then normalized again,
THE SYSTEM SHALL return an identical result (idempotent).

WHEN a route name is normalized,
THE SYSTEM SHALL strip leading and trailing whitespace.

WHEN a route label has only whitespace after the prefix,
THE SYSTEM SHALL NOT extract a valid route name from it.

WHEN route label prefix matching is performed,
THE SYSTEM SHALL match regardless of letter casing.

WHEN the route allowlist is null (unrestricted),
THE SYSTEM SHALL accept all validly-routed issues.

WHEN the route allowlist is empty,
THE SYSTEM SHALL reject all routed issues.

WHEN an issue has no route label and unrouted acceptance is disabled,
THE SYSTEM SHALL NOT consider it eligible for this worker.

WHEN a route label has a matching prefix but only whitespace as the route name,
THE SYSTEM SHALL treat it as routed-but-invalid (rejected, not treated as unrouted).

## State Classification

WHEN a state name is normalized,
THE SYSTEM SHALL produce the same result regardless of input letter casing.

WHEN a state name is normalized and then normalized again,
THE SYSTEM SHALL return an identical result (idempotent).

WHEN a state name is normalized,
THE SYSTEM SHALL strip leading and trailing whitespace.

WHEN a null or undefined state is checked against a terminal state list,
THE SYSTEM SHALL classify it as non-terminal.

WHEN a state not present in the terminal list is checked,
THE SYSTEM SHALL classify it as non-terminal.

WHEN a state is compared against the terminal list,
THE SYSTEM SHALL match regardless of letter casing or surrounding whitespace.

## Ensemble Resolution

WHEN an issue has a valid ensemble label with a positive integer,
THE SYSTEM SHALL use that integer as the ensemble size.

WHEN an issue has multiple valid ensemble labels,
THE SYSTEM SHALL use the first one encountered.

WHEN an ensemble label specifies zero or a negative number,
THE SYSTEM SHALL ignore it and fall back to the configured default.

WHEN ensemble label matching is performed,
THE SYSTEM SHALL match regardless of letter casing or surrounding whitespace.

WHEN an issue has no valid ensemble label,
THE SYSTEM SHALL fall back to the configured default ensemble size.

## Retry and Backoff

WHEN a retry delay is computed,
THE SYSTEM SHALL produce a non-negative value.

WHEN a failure retry delay is computed for a higher attempt number,
THE SYSTEM SHALL produce a value greater than or equal to the value for a lower attempt number (monotonically non-decreasing).

WHEN a retry delay is computed,
THE SYSTEM SHALL NOT exceed the configured maximum backoff cap.

WHEN a failure retry delay is computed and the cap allows it,
THE SYSTEM SHALL enforce a minimum delay floor (preventing zero-delay retry storms).

WHEN a continuation retry is scheduled after a normal worker exit,
THE SYSTEM SHALL use a fixed short delay regardless of attempt number or cap.

## Usage Accounting

WHEN usage totals are updated from an agent event,
THE SYSTEM SHALL NOT produce negative token counts.

WHEN usage totals are updated from an agent event,
THE SYSTEM SHALL NOT decrease any token counter from its previous value (monotonic growth).

WHEN global aggregate usage totals are updated,
THE SYSTEM SHALL NOT decrease them from their previous values.

WHEN usage totals are updated,
THE SYSTEM SHALL keep the reported-totals watermark in sync with the entry totals.

WHEN usage totals are updated,
THE SYSTEM SHALL preserve the runtime-seconds field independently (not conflated with token updates).

WHEN the same usage update is applied twice in succession,
THE SYSTEM SHALL produce the same result as applying it once (idempotent).

## Worker Host Selection

WHEN a worker host is selected for dispatch,
THE SYSTEM SHALL choose from the configured host list or indicate no host is available.

WHEN a worker host is selected,
THE SYSTEM SHALL only choose a host with current load strictly below the per-host cap.

WHEN multiple hosts are below the cap,
THE SYSTEM SHALL choose the one with the lowest current load.

WHEN the host list is empty,
THE SYSTEM SHALL indicate no host is available.

WHEN at least one host is below the cap,
THE SYSTEM SHALL always select a host (no false starvation).

## Configuration Overrides

WHEN no per-state override exists for a given issue state,
THE SYSTEM SHALL use the base settings unchanged.

WHEN per-state overrides are looked up,
THE SYSTEM SHALL match state names regardless of letter casing.

WHEN two different states each have overrides,
THE SYSTEM SHALL apply each override independently without cross-contamination.

WHEN a per-state override specifies only some fields,
THE SYSTEM SHALL preserve all unmentioned fields from the base settings.

WHEN a per-state override targets a nested map-valued policy field,
THE SYSTEM SHALL deep-merge it rather than replacing the entire map.

## Orchestrator Scheduling

WHEN an issue-slot pair is already running,
THE SYSTEM SHALL NOT dispatch a second concurrent worker for that same pair.

WHEN a slot is claimed,
THE SYSTEM SHALL ensure it is either actively running or scheduled for retry (never orphaned).

WHEN a poll tick fires,
THE SYSTEM SHALL perform reconciliation before attempting any new dispatches.

WHEN a worker exits normally,
THE SYSTEM SHALL schedule a short continuation retry to re-check the issue's tracker state.

WHEN a worker exits abnormally,
THE SYSTEM SHALL schedule an exponential-backoff retry.

WHEN runtime seconds are counted toward global totals,
THE SYSTEM SHALL add them only upon run completion (no double-counting from in-progress sessions).

WHEN token usage events arrive with absolute totals,
THE SYSTEM SHALL compute deltas from a watermark to avoid double-counting.

## Reconciliation

WHEN a running issue's tracker state becomes terminal,
THE SYSTEM SHALL stop the active worker and clean up its workspace.

WHEN a running issue's tracker state becomes non-active but non-terminal,
THE SYSTEM SHALL stop the active worker without cleaning up its workspace.

WHEN a running issue's assignee routing no longer matches this worker,
THE SYSTEM SHALL stop the active worker without cleaning up its workspace.

WHEN a running issue's route labels no longer match this worker,
THE SYSTEM SHALL stop the active worker without cleaning up its workspace.

WHEN a tracker state refresh request fails,
THE SYSTEM SHALL keep existing workers running and retry on the next tick.

## Workflow Validation

WHEN the workflow file is missing,
THE SYSTEM SHALL produce a typed error and prevent startup.

WHEN the workflow file contains non-map YAML front matter,
THE SYSTEM SHALL produce a typed error.

WHEN prompt rendering encounters an unknown variable,
THE SYSTEM SHALL fail the render strictly rather than silently omitting the variable.

WHEN dispatch validation fails on a tick,
THE SYSTEM SHALL skip new dispatches but continue reconciliation and stay alive.

WHEN a workflow file reload produces invalid configuration,
THE SYSTEM SHALL retain the last-known-good configuration and emit an operator-visible error.

## Agent Execution

WHEN a coding agent process is launched,
THE SYSTEM SHALL set the working directory to the validated per-issue workspace path.

WHEN the first turn of a session is started,
THE SYSTEM SHALL send the full rendered prompt template.

WHEN a continuation turn is started on an existing session,
THE SYSTEM SHALL send only continuation guidance (not the full original prompt).

WHEN the effective backend profile changes between turns,
THE SYSTEM SHALL end the current session and yield control to the orchestrator for re-dispatch.

WHEN the turn count reaches the configured maximum,
THE SYSTEM SHALL end the worker session rather than starting another turn.

## Resume State

WHEN resume state is considered for reuse,
THE SYSTEM SHALL accept it only when agent kind, issue identity, workspace path, and worker host all match the current run.

WHEN a run fails, stalls, or is force-terminated,
THE SYSTEM SHALL invalidate any associated resume state before scheduling a retry.

## Hooks

WHEN a workspace is freshly created,
THE SYSTEM SHALL run the after-create hook.

WHEN a workspace already exists and is reused,
THE SYSTEM SHALL NOT run the after-create hook.

WHEN a before-run hook fails or times out,
THE SYSTEM SHALL abort the current run attempt.

WHEN an after-run hook fails or times out,
THE SYSTEM SHALL log the failure but continue without affecting orchestrator state.

WHEN a before-remove hook fails or times out,
THE SYSTEM SHALL proceed with workspace cleanup regardless.

WHEN any hook is executed,
THE SYSTEM SHALL enforce the configured timeout (no unbounded execution).

## Secret Handling

WHEN environment variable indirection is used for secrets,
THE SYSTEM SHALL resolve the value at runtime without logging or exposing the resolved secret.

## Observability

WHEN a dashboard, log sink, or status surface encounters a failure,
THE SYSTEM SHALL NOT crash the orchestrator or affect dispatch correctness.

WHEN multiple usage events arrive within a single session,
THE SYSTEM SHALL maintain correct aggregate token and rate-limit totals.
