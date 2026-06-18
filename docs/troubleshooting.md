# Troubleshooting

Most Lorenz failures trace to one of a few causes: the workflow file won't parse, the config fails validation, an eligible issue refuses to dispatch, a reload keeps stale settings, an agent bridge isn't on `PATH`, or a tracker/worker is unreachable. This page maps each symptom to its cause and fix. It is for operators running the `lorenz` daemon.

Two tools do most of the work. Run [`lorenz doctor`](cli.md) before you start to catch config and environment problems up front. Watch the dashboards and the event stream while running. The `poll.lastError` field and the last 20 `recentEvents` are the only in-memory error surface, so the exact event name in the snapshot is your primary diagnostic.

Many errors below are emitted as runtime events. The full catalog lives in [reference/events.md](reference/events.md).

## The workflow won't load or parse

Lorenz loads `WORKFLOW.md` before every poll. A load failure at startup aborts the daemon; a load failure on reload keeps the last-good settings (see [Reload kept stale settings](#reload-kept-stale-settings)). The error strings are stable prefixes, so match on them exactly.

| Symptom / error prefix | Cause | Fix |
| --- | --- | --- |
| `missing_workflow_file: <abs path> <code>` | No file at the resolved path. Resolution is `LORENZ_WORKFLOW` (absolute used as-is, relative joined to cwd) else `<cwd>/WORKFLOW.md`. | Create the file, fix the path argument, or unset/correct `LORENZ_WORKFLOW`. The `<code>` is the OS errno (`ENOENT`, `EACCES`). |
| `workflow_front_matter_not_a_map: front matter must be a map` | The YAML front matter parsed to `null` or a non-object (a list, a bare scalar). | Make the front matter a key/value map. An empty front matter block is allowed and yields an empty config. |
| `workflow_parse_error: <msg>` | The front matter is not valid YAML. | Fix the YAML syntax `<msg>` points at. Tabs, bad indentation, and unquoted colons are common. |
| `template_parse_error` (carries the template text) | The Markdown body is not a valid Liquid template. | Fix the Liquid syntax. The body is parsed with `strictVariables` and `strictFilters`, so an unknown variable or filter throws. |

Front matter is delimited by a literal `---` on the first line and a closing `---`. If the first line is not exactly `---`, the whole file is treated as the prompt body with empty config. The parser then applies the Jira and Claude defaults, so validation usually fails on missing Jira provider essentials rather than on a missing selector.

An empty or whitespace-only Markdown body is not an error: Lorenz falls back to a built-in default prompt template that renders `issue.identifier`, `issue.title`, and `issue.description`.

Prompt variables are snake_case even though config keys are camelCase internally. Use `state_type`, `branch_name`, `assignee_id`, `blocked_by`, `assigned_to_worker`, `created_at`, `updated_at`. A camelCase variable name throws `template_parse_error` under strict mode.

## Config validation fails

Config validation runs at startup and again as the per-reload dispatch hook. Run `lorenz doctor` to see the same `dispatch_config` check without starting the daemon. Error labels are emitted in snake_case (for example `tracker.active_states must be a list of strings`), even though parsing happens on camelCase keys.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Jira reports a missing `base_url`, `email`, `api_key`, or project/JQL scope when no tracker was selected | `tracker.kind` defaults to `jira`, but Jira still needs its provider essentials. | Run `lorenz config`, supply Jira references and scope, or set `tracker.kind` explicitly to another provider such as `local`. |
| `tracker.<key> is not supported` / `<section>.<key> is not supported` | An unknown key in a `.strict()` section. | Remove or rename the key. Provider-specific options pass through under the tracker/agents records; core sections reject unknowns. |
| `tracker.api_key is required` (Linear) | Linear dispatch has no API key. | Set `tracker.api_key`, or export `LINEAR_API_KEY` (the provider's env fallback). |
| Linear: exactly-one-of error on `project_slug` / `project_slugs` / `project_labels` | Zero or more than one project selector set. | Set exactly one. `project_slug` is the deprecated single form; `project_slugs` is the explicit list; `project_labels` discovers projects by label. |
| `<field> must be a positive integer` / `valid port number` | A numeric config key is non-positive or malformed. | Supply a positive integer. `stall_timeout_ms` is the one timeout that may be `0` (which disables stall detection); every other `*_ms` must be positive. |
| `worker.kind` combined with `worker.ssh_hosts`, or `worker_pool.enabled` with `ssh_hosts`, or `worker.kind` with `worker_pool.driver` | Mutually exclusive worker shapes set together. | Pick one worker model. Also `worker_pool.max >= min` and `warm <= max` are enforced. |
| `workspace.isolation = "none" does not support hooks; remove <names>` | A lifecycle hook is configured in shared (`isolation: none`) mode. | Remove the hooks, or switch to `isolation: per-agent`. Shared mode never runs hooks. |

When the same workflow validates here but fails in CI or a different shell, the difference is almost always an unset environment variable used by `$VAR` or an env fallback. See [Secrets won't resolve](#secrets-wont-resolve).

## The config wizard will not overwrite a workflow

`lorenz config [workflowPath]` and `lorenz-config [workflowPath]` run the same onboarding wizard.
When the target exists, choose a different path or pass `--force` when replacement is intentional.

Credential prompts default to environment references and the wizard writes them without resolving
them. API secret prompts reject literal values. If the generated workflow later reports a missing
credential, export the referenced variable in that shell.

Both entrypoints require stdin and stdout to be interactive terminals. The error
`Lorenz config requires an interactive terminal` means the wizard was launched from a pipe, CI job,
or other non-TTY context.

## Nothing dispatches

The daemon is polling, candidates come back, but no run starts. An issue is dispatched only when it passes every eligibility gate. Walk the gates in order.

- **Wrong active states.** Candidates are polled by `tracker.active_states` (Jira default `[To Do, In Progress]`; other built-ins `[Todo, In Progress]`). An issue sitting in any other state is never fetched. Move it to an active state or add that state to `active_states`.
- **Terminal state.** States in `tracker.terminal_states` (default `[Closed, Cancelled, Canceled, Duplicate, Done]`) are treated as done and trigger workspace cleanup, not dispatch.
- **Not routed.** With `tracker.dispatch.only_routes` set, an issue must carry a matching route label (prefix `tracker.dispatch.route_label_prefix`, default `Lorenz:`). With `accept_unrouted: false` (default `true`), an unrouted issue is skipped. Reconciliation also stops an in-flight run whose issue becomes `unrouted`.
- **Blocked.** An issue with open blockers is not dispatched, and an in-flight run is stopped during reconciliation with reason `blocked`. Blockers come from a `blockers` array or from `relations` entries whose type is `blocks`.
- **Concurrency caps hit.** Dispatch cannot exceed `agent.max_concurrent_agents` (default 10), or the per-state cap from `status_overrides.<state>.agent.max_concurrent_agents`. Reserved (in-acquire) slots count toward every cap, so a worker pool mid-acquire can hold capacity. The snapshot shows these as `dispatch_skipped` events.
- **Retry not yet due.** A failed run schedules a retry with backoff. The issue is filtered out of eligibility until the retry deadline. Failure backoff is `10000 * 2^(attempt-1)` capped at `agent.max_retry_backoff_ms` (default 300000); a clean exit schedules a continuation retry at roughly 1000ms.
- **Worker host has no capacity (pool path).** A pool-governed claim that finds no capacity emits `dispatch_skipped` with reason `worker_host_capacity` and reschedules without backoff. An acquire error emits `dispatch_skipped` with `worker_pool_acquire_error <msg>`.

Blocked dispatches surface in the snapshot `blocked` lane and in the dashboard. If `--dry-run` is set the daemon evaluates candidates and emits `dry_run` events without dispatching; confirm you did not leave it on.

If the poll itself is failing, look for `poll_error` in the events. A failing `validateDispatch` throws and aborts the whole poll tick, so no reconciliation or dispatch happens that tick.

## Reload kept stale settings

You edited `WORKFLOW.md`, but behavior did not change.

Hot-reload runs before each poll and is transactional. It only acts when the content stamp (mtime, size, sha256) changed. All throwing side effects run first: the slots-per-machine co-residence gate, then `coordinator.reconcile`. Only after they all succeed does the runtime swap in the new workflow, settings, and tracker client.

On any reload failure the runtime keeps the last-good settings (no partial apply) and emits `workflow_reload_failed` with the error message. A successful reload emits `workflow_reloaded` with the path. So if your edit had a parse or validation error, the daemon keeps running on the previous good config and tells you only through `workflow_reload_failed` in the event stream.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Edit ignored, `workflow_reload_failed` in events | The new file fails parse or validation. | Read the error in the event, fix the file. The daemon stays on last-good until a clean reload. |
| Edit ignored, no reload event at all | Content stamp unchanged (for example an editor that rewrote identical bytes). | Make a real content change, or restart the daemon. |
| `max_in_flight` / `slots_per_machine` raise rejected on reload | The live co-residence gate (`checkSlotsPerMachineGate`) re-runs on every reload, so a running daemon cannot widen blast radius past what startup allowed. | Restart with the wider setting if the worker driver and `co_residence` opt-in actually support it. |

## Agent bridge missing

The ACP executor drives an external bridge subprocess. The built-in bridges are `codex-acp` (for Codex) and `claude-agent-acp` (for Claude), and each in turn needs the underlying agent CLI on `PATH`: `codex` for codex bridges, `claude` for claude bridges.

`lorenz doctor` checks this directly in its `agent_bridge` and `agent_cli` checks. The checks run only for `executor: acp`, and inspect the active config plus every `status_overrides` state. Remote workers (`worker.ssh_hosts` non-empty) skip the bridge probe with a warning instead of testing over SSH.

| Symptom | Cause | Fix |
| --- | --- | --- |
| doctor `agent_bridge` warning, runs never start a session | The bridge command is not resolvable. | Ensure `codex-acp` / `claude-agent-acp` is on `PATH`, or set `agents.<kind>.bridge_command` to a resolvable command. Bare names resolve to the vendored workspace packages locally. |
| doctor `agent_cli` warning | The underlying agent binary is missing. | Install `codex` / `claude`, or point `CODEX_PATH` / `CLAUDE_CODE_EXECUTABLE` at the binary. An explicit env value always wins. |
| doctor checks Claude when Codex was expected | `agent.kind` now defaults to `claude`. | Set `agent.kind: codex`; explicit workflow config wins over the default. |
| `agents.claude.bridge_args` rejected as unsupported | There is no `bridge_args` key. The bridge is a single shell command string. | Put any arguments inline in `agents.<kind>.bridge_command`. |
| `claude.permission_mode` rejected | There is no `permission_mode` key. | Set permissions through `provider_config` (for example `permissions.defaultMode`). |

The bridge command is a single shell string split on whitespace. `parseAcpAgentOptions` rejects unknown option keys, so a typo'd or non-existent key fails config validation rather than being ignored.

## Linear rate limits (429)

The Linear client and the `linear_graphql` tool both retry HTTP 429 honoring `Retry-After`, with up to 4 retries (base delay 1000ms, max 30000ms). `Retry-After` is parsed as integer seconds or an HTTP-date; a blank value falls back to exponential backoff. After retries are exhausted the client throws `linear api status 429`.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `linear api status 429` in events | Sustained rate limiting beyond the 4 retries. | Reduce poll frequency (`polling.interval_ms`, default 30000), narrow `project_slugs`, or lower concurrency so fewer agents call Linear at once. |
| `linear api timeout after 30000ms` | A single request exceeded the 30000ms per-request timeout. | Check network reachability to `https://api.linear.app/graphql`; a slow connection or an oversized query is the usual cause. |
| `linear api status <N>` (other than 429) | A non-retryable HTTP error. | Inspect `<N>`. A 401/403 means a bad or revoked `tracker.api_key`. |
| `linear_truncated_connection: <name>` | A healthy issue had a truncated `labels`/`relations`/`teams`/`states` page; Lorenz hard-fails rather than silently drop data. | An integrity guard: the issue has more related records than one page holds. This is a real data shape, not a transient fault. |
| `linear_missing_end_cursor` | Pagination claimed more pages but returned no cursor. | A Linear API anomaly; retry the poll. Persistent failures warrant checking the Linear status page. |

## SSH worker unreachable

Remote runs execute on hosts in `worker.ssh_hosts` over SSH. Use `LORENZ_SSH_CONFIG` to point `ssh -F` at a specific config file.

| Symptom / error prefix | Cause | Fix |
| --- | --- | --- |
| `ssh_timeout:<...>` | An SSH operation exceeded `worker.ssh_timeout_ms` (default 60000). The run is classified as a poison worker. | Raise `ssh_timeout_ms`, check host reachability, confirm SSH keys and `LORENZ_SSH_CONFIG`. |
| `remote_home_lookup_failed:<...>` | The worker's `$HOME` could not be resolved over SSH (needed to expand `~`/`~/...` in `workspace.root`). | Confirm SSH login works and the remote shell prints `$HOME`. Marked poison. |
| `workspace_prepare_failed:<...>` | Remote workspace creation failed (mkdir, containment check, skill sync). | Check remote disk, permissions, and that the resolved root is writable. Marked poison. |
| `invalid_ssh_timeout` | `worker.ssh_timeout_ms` is zero, missing, or non-integer where a positive timeout is required (remote skill sync, remote root/cwd lookup). | Set a positive integer `ssh_timeout_ms`. |

Poison classification matches on a fixed set of error prefixes, so `ssh_timeout:` poisons a worker but a string like `invalid_ssh_timeout` stays healthy. A run aborted by stall reconciliation is forced to poison regardless of how it resolved.

## Workspace bootstrap hook failed

Each issue workspace runs up to four lifecycle hooks via `bash -lc`: `after_create`, `before_run`, `after_run`, `before_remove`. Their failure policy differs, which decides whether a hook problem stops the run.

- `after_create` failure or timeout **aborts workspace creation** (throws).
- `before_run` failure **aborts the attempt**.
- `after_run` failure is **logged and ignored** (a stderr update, not a run failure).
- `before_remove` failure is **caught and ignored**; cleanup continues.

So only `after_create` and `before_run` fail-fast. If a teardown hook is broken, the run still completes and you only see a logged warning.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `hook timed out after <n>ms` | A hook ran past `hooks.timeout_ms` (default 60000). The process group is SIGTERM'd, then SIGKILL after 5000ms. | Speed up the hook or raise `hooks.timeout_ms`. |
| Hooks never run | `workspace.isolation: none` (shared mode) never runs hooks, and rejects any hook config at parse time. | Use `isolation: per-agent` if you need hooks. |
| Hook command not interpolating the issue | Liquid templating activates only when the command references `issue.` / `issue[`. Variables are snake_case and shell-escaped by default. | Reference `issue.identifier` etc. Use `| raw` to opt out of escaping, `| shell_escape` to be explicit. |
| `workspace_skill_source_missing` / `workspace_skill_source_symlink` / `workspace_skill_source_unsupported` | A configured skill path is missing, contains a symlink anywhere in its tree, or is a file not a directory. | Point `agent.skills` at real directories with no symlinks. |
| `workspace outside root` / `unsafe symlink in workspace path` | The resolved workspace cwd escaped the configured root via a symlink. | Remove the symlink; the containment check is realpath-based and not negotiable. |

## Finding logs and traces

Lorenz keeps no database. The live error surface is the in-memory snapshot: `poll.lastError` plus the last 20 `recentEvents`. Beyond that there are two on-disk sources.

- **Event log file.** When `logging.log_file` is set (default `~/.lorenz/log/lorenz.log`), runtime events are appended as JSON. The daemon flag `--logs-root <path>` redirects this to `<path>/log/lorenz.log`.
- **Per-issue trace.** Every `AgentUpdate` is written as one JSON line to `<server.trace_dir>/<urlencoded issueId>/trace.jsonl`. The default `trace_dir` is `~/.lorenz/issues` (note: `issues`, not `traces`). View a single trace file standalone with `pnpm traceviz <file.jsonl>`, which serves the dashboard SPA at `http://localhost:4040/#/trace/<issueId>`.

The live dashboard renders the same traces under the `#/trace/<issueId>` hash route, streaming over `/ws`. Several runtime event types (`rate_limit`, `workspace_prepared`, `session_started`, `process_exit`, `stderr`, `fs_write`, `approval_required`, `approval_auto_approved`) are parsed then dropped by the trace viewer, so a run can look quiet in the UI while still recording those lines on disk. See [observability.md](observability.md) for the full picture.

## Querying run history

The `lorenz runs` command queries the observability HTTP API for completed-run history.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No observability server port configured. Pass --port/--url or set server.port in WORKFLOW.md.` | No base URL could be derived. | Pass `--url`, pass `--port`, or set `server.port`. `--url` wins over `--port`; port `0` is treated as unset. |
| `Run not found` | HTTP 404 from the API. | The `--id` or `--issue` filter matched nothing. |
| `Observability API unavailable` | HTTP 503. | The daemon is not serving the API yet; confirm the dashboard server started. |
| `Unexpected response status N` | Any other HTTP status. | Check that the URL points at a running Lorenz observability server. |

## Using lorenz doctor and lorenz-debug

`lorenz doctor [workflowPath]` validates a workflow and the local environment without starting the daemon. It runs a short-circuiting pipeline of checks with stable ids: `workflow_file`, `workflow_load`, `dispatch_config`, `dashboard_assets`, `log_path`, then `agent_bridge` / `agent_cli`. If `workflow_file` or `workflow_load` errors, doctor returns immediately. Exit status is `1` only when a check reports `error`; warnings keep exit `0`. Missing dashboard assets and an unwritable log path are warnings, not errors.

For a stuck or repeatedly-retrying run, use the `lorenz-debug` skill, which traces Lorenz and agent logs by issue and session id to explain why a run stalled, retried, or failed. Reach for it when the event stream alone does not explain the behavior. Session ids are composed as `<thread_id>-<turn_id>`, which is the key for correlating trace lines to a specific turn.

## See also

- [cli.md](cli.md) - the config wizard, daemon, `runs`, and `doctor` commands and flags.
- [dispatch.md](dispatch.md) - the eligibility and routing rules behind "nothing dispatches".
- [observability.md](observability.md) - the dashboards, the trace viewer, and the event stream.
- [reference/events.md](reference/events.md) - the full catalog of runtime event names.
- [reference/configuration.md](reference/configuration.md) - every config key, default, and alias.
