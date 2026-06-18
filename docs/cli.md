# CLI

The `lorenz` binary is the main entrypoint. This page is the operator's task guide to its four commands: the interactive config wizard, the default daemon, `lorenz runs`, and `lorenz doctor`. The package also exposes the wizard directly as `lorenz-config`. For the flag-by-flag table, see [reference/cli.md](reference/cli.md).

## The commands

```sh
lorenz config [-f] [WORKFLOW.md] # interactive onboarding wizard
lorenz [flags] [WORKFLOW.md]   # default: the daemon
lorenz runs [filters]          # query run history from the observability API
lorenz doctor [WORKFLOW.md]    # validate a workflow and local prerequisites
lorenz-config [-f] [WORKFLOW.md] # same wizard as `lorenz config`
```

`config`, `runs`, and `doctor` are subcommands. Anything else runs the daemon. If the binary prints `lorenz has not been built yet`, run `pnpm build` first; the npm shim imports the built `dist` output.

## Create a workflow

`lorenz config [workflowPath]` launches the interactive onboarding wizard. The separately installed
`lorenz-config [workflowPath]` binary calls the same implementation.

```sh
lorenz config                    # use LORENZ_WORKFLOW, then ./WORKFLOW.md
lorenz config path/to/FLOW.md    # choose the target
lorenz config -f FLOW.md         # replace without an overwrite prompt
```

The initial choices default to Jira and Claude. Explicit choices are written into the workflow and
therefore override parser defaults. The tracker choices are Jira, Linear, a local Markdown board,
and Slack. Credential prompts default to environment references and the wizard writes them without
resolving them. API secret prompts accept environment references only, so literal tokens are not
written to `WORKFLOW.md`.

The wizard requires an interactive TTY and validates the generated config before writing it. When
the target already exists, it refuses to replace it. `-f` / `--force` intentionally replaces it.

## Run the daemon

With no flags, `lorenz` loads a workflow, validates it, starts the observability server and the terminal dashboard, then polls until you stop it.

```sh
lorenz                 # poll forever, TUI + web dashboard on
lorenz WORKFLOW.md     # same, with an explicit workflow path
```

### Where the daemon finds your workflow

The workflow path resolves in this order:

1. The positional `[WORKFLOW.md]` argument, if given.
2. The `LORENZ_WORKFLOW` environment variable. An absolute value is used as-is; a relative value is joined to the current directory.
3. `./WORKFLOW.md` in the current directory.

A missing file fails fast with `missing_workflow_file`. The directory holding the workflow anchors relative paths inside it, including `./` worker-driver module specifiers.

### Daemon flags

| Flag | Effect | Reach for it when |
| --- | --- | --- |
| `--once` | Poll one tick, act on what is eligible, then exit. | Cron-style scheduling, or a one-shot sweep instead of a long-lived process. |
| `--dry-run` | Evaluate dispatch candidates and report what would run, without launching any agent. | Checking routing and eligibility against live tracker state before committing. |
| `--no-tui` | Disable the Ink terminal dashboard. | Logs, CI, or a non-interactive shell where the TUI is noise. |
| `--no-dashboard` | Disable the web dashboard and its HTTP API server. | You want no listening port at all. |
| `--port <port>` | Set the observability API port. Overrides `server.port` from the workflow. | Pinning a known port, or avoiding a clash. `0` binds an ephemeral port. |
| `--logs-root <path>` | Write logs to `<path>/log/lorenz.log` instead of the configured `logging.log_file`. | Redirecting logs to a writable scratch directory. |

`--no-tui` and `--no-dashboard` are the only forms; there is no positive `--tui` or `--dashboard` flag. Both surfaces are on by default. The TUI renders only when stdout is a TTY; without a TTY the runtime writes JSON snapshots to stdout on each update instead.

### What startup does

`runDaemon` runs a fixed sequence:

1. Register the built-in trackers, tool pack, agent executor, and worker drivers (idempotent).
2. Load and parse the workflow, apply `--port` and `--logs-root` overrides, and run [`validateDispatchConfig`](reference/configuration.md).
3. Build the [dispatch coordinator](dispatch.md) and [warm worker pool](workers/worker-pool.md), but only when `worker.worker_pool.enabled` is set. Otherwise both are skipped.
4. Run the `slots_per_machine` blast-radius gate (see below).
5. Construct the runtime, start the observability server, then render the TUI or subscribe for JSON snapshots.

The runtime re-reads the workflow before every poll, so editing `WORKFLOW.md` while the daemon runs reloads it without a restart. A reload that fails to parse keeps the last good settings and records `workflow_reload_failed`. See [workflow hot-reload](features/workflow-hot-reload.md).

When the server binds, the bound port is written back into `server.port` so reloads keep the same port, and stderr prints `Observability API listening on <url>`.

### Stopping it

A first `Ctrl+C` (`SIGINT`) or `SIGTERM` starts a graceful stop: the runtime finishes draining, the worker pool drains, the server stops, and the issue store closes. A second `Ctrl+C` while shutting down forces an exit with code `130`.

### The slots-per-machine gate

`worker.worker_pool.slots_per_machine > 1` packs more than one run onto a single worker machine. The default `1` always passes. Above `1`, the daemon refuses to start unless the coordinator advertises per-run MCP endpoints and you have set `worker.worker_pool.co_residence`. The opt-in is required because one poisoned worker fails every co-resident run when it recycles. `max_in_flight` is the legacy alias for `slots_per_machine`.

## Inspect runs

`lorenz runs` queries the daemon's observability API and prints run history. The daemon (or at least its dashboard server) must be running for this to return data.

```sh
lorenz runs                    # recent run history
lorenz runs --failed           # only failed and stalled runs
lorenz runs --issue ENG-42     # runs for one issue
lorenz runs --id <runId>       # one run plus its related attempts
lorenz runs --cost             # token and cost summary by agent
lorenz runs --retries          # retry summary by issue
lorenz runs --limit 50         # cap the number of runs returned
lorenz runs --json             # raw JSON instead of tables
```

The filters map directly to query parameters on `GET /api/v1/runs` and select which view the server returns:

| Flag | View | Shows |
| --- | --- | --- |
| (none) | `runs` | Run history table plus totals by outcome. |
| `--failed` | `runs` | Runs whose outcome is `failed` or `stalled`. |
| `--issue <id>` | `runs` | Runs matching an issue identifier or id. |
| `--id <runId>` | `run` | One run with session, worker, workspace, last event, failure reason, and related attempts. |
| `--cost` | `cost` | Per-agent token totals and a top-runs table. |
| `--retries` | `retries` | Attempts, latest outcome, and tokens per issue. |
| `--limit <n>` | (any) | Caps returned runs. The server defaults to 20 and clamps to 200. |
| `--json` | (any) | Prints the raw response body, skipping the table renderer. |

Dollar cost is not computed: those fields render as `n/a`, and the `--cost` view reports token totals.

### Which server it talks to

The base URL resolves by precedence:

1. `--url <url>` if given. A trailing slash is trimmed. This wins even if `--port` is also passed.
2. `--port <port>` with the workflow's `server.host`, when the port is greater than `0`.
3. `server.port` from the workflow, with `server.host`, when it is greater than `0`.

Port `0` counts as no explicit port. If none of these yield a port, the command fails with `No observability server port configured. Pass --port/--url or set server.port in WORKFLOW.md.`

The command maps HTTP status codes to messages: `404` prints `Run not found`, `503` prints `Observability API unavailable`, and anything else prints `Unexpected response status <N>`.

## Validate with doctor

`lorenz doctor` loads a workflow and checks your local setup without dispatching anything. It exits `1` only when a check errors; warnings keep the exit code at `0`.

```sh
lorenz doctor                  # validate ./WORKFLOW.md and prerequisites
lorenz doctor WORKFLOW.md      # explicit path
lorenz doctor --no-dashboard   # skip the static-asset check
```

Doctor uses the same path resolution as the daemon. It runs these checks in order and short-circuits on the first hard error:

| Check id | Meaning | Failure mode |
| --- | --- | --- |
| `workflow_file` | The workflow path exists, is a file, and is readable. | `error` (stops here). |
| `workflow_load` | The workflow parses into valid settings. | `error` (stops here). |
| `dispatch_config` | `validateDispatchConfig` passes against the built-in tracker, executor, and tool registries. | `error`. |
| `dashboard_assets` | The built dashboard SPA (`server.staticDir`, else the default `dist`) is present. | `warning`. |
| `log_path` | The nearest existing ancestor of `logging.log_file` exists and is writable. | `warning`. |
| `agent_bridge_*` | The ACP bridge command for each active and per-state agent is parseable and on `PATH`. | `warning`. |
| `agent_cli_*` | The underlying agent CLI behind each bridge is discoverable. | `warning`. |

The overall status is `error` if any check errors, otherwise `warning` if any warns, otherwise `ok`.

Bridge checks run only for the `acp` executor. They inspect the active config and every `status_overrides` state. With remote workers (`worker.ssh_hosts` set), doctor skips bridge probing and emits a warning instead of reaching over SSH. The CLI check resolves `claude` for Claude-compatible bridges (overridable with `CLAUDE_CODE_EXECUTABLE`) and `codex` for `codex-acp` bridges (overridable with `CODEX_PATH`).

## Environment variables

| Variable | Effect |
| --- | --- |
| `LORENZ_WORKFLOW` | Workflow file path. Absolute is used as-is; relative joins the current directory. |
| `LORENZ_WORKSPACE_ROOT` | Overrides `workspace.root`. |
| `LORENZ_SSH_CONFIG` | Path passed to `ssh -F` for [remote workers](workers/static-ssh.md). |
| `CLAUDE_CODE_EXECUTABLE` | Overrides the `claude` binary path used by doctor and the ACP bridge. |
| `CODEX_PATH` | Overrides the `codex` binary path used by doctor and the ACP bridge. |

Tracker credentials resolve through the workflow config, not generic CLI flags. See [secret resolution](features/secret-resolution.md).

## See also
- [reference/cli.md](reference/cli.md) - the exhaustive flag, argument, and exit-code reference
- [getting-started.md](getting-started.md) - wizard, first workflow, and first run end to end
- [workflows.md](workflows.md) - what goes in `WORKFLOW.md` and how it is parsed
- [observability.md](observability.md) - the dashboard, HTTP API, and TUI the daemon serves
- [features/run-history.md](features/run-history.md) - what `lorenz runs` is querying
- [troubleshooting.md](troubleshooting.md) - when a run stalls, fails, or will not start
