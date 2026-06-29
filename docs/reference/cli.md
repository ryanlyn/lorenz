# CLI reference

The exact contract for the `lorenz` binary: every command, flag, argument, exit code, and environment variable it reads. This is the man-page for integrators and operators who need precise behavior. For a guided walkthrough, start at [cli.md](../cli.md).

The binary ships three commands:

| Command | Purpose |
| --- | --- |
| `lorenz [flags] [workflowPath]` | The default daemon: poll the tracker, dispatch agents, serve the dashboard and TUI. |
| `lorenz runs [flags]` | Query run history from the observability HTTP API. |
| `lorenz doctor [flags] [workflowPath]` | Validate a workflow and local prerequisites without dispatching. |

The `bin` shim at `apps/cli/bin/lorenz.js` imports the built `dist/bin/cli.js`. If the package has not been built, it prints `lorenz has not been built yet. Run pnpm build or mise run build first.` and exits 1.

## `lorenz` (daemon)

```sh
lorenz [--once] [--dry-run] [--no-tui] [--no-dashboard] [--port <port>] [--logs-root <path>] [workflowPath]
```

The default command. It loads the workflow, validates dispatch config, builds the dispatch coordinator and warm worker pool, constructs the runtime, starts the observability server and TUI, then polls until interrupted.

### Argument

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `workflowPath` | path | resolved (see below) | The `WORKFLOW.md` file to run. Excess arguments are rejected. |

When `workflowPath` is omitted, resolution falls to `LORENZ_WORKFLOW` (an absolute value is used as-is, a relative value is joined to the current working directory), and otherwise to `./WORKFLOW.md`.

### Flags

| Flag | Type | Default | Meaning |
| --- | --- | --- | --- |
| `--once` | boolean | `false` | Poll once and exit. Passed to `runtime.start({ once: true })`. |
| `--dry-run` | boolean | `false` | Evaluate dispatch candidates without dispatching agents. |
| `--no-tui` | boolean | TUI on | Disable the terminal dashboard. The option key is `tui`, default `true`; there is no positive `--tui`. |
| `--no-dashboard` | boolean | dashboard on | Disable the web dashboard and JSON API server. The option key is `dashboard`, default `true`; there is no positive `--dashboard`. |
| `--port <port>` | non-negative integer | unset | Override `server.port`. Parsed by `parseNonNegativeInteger`. |
| `--logs-root <path>` | path | unset | Write logs to `<path>/log/lorenz.log` (overrides `logging.log_file`). |

Both the web dashboard and the TUI are on by default. The TUI only renders when `process.stdout.isTTY` is true; without a TTY the runtime subscribes and writes pretty-printed JSON snapshots to stdout. Pass `--no-tui` to force the JSON-snapshot path even on a TTY.

### Override precedence

CLI overrides are applied to the loaded workflow on every load and reload:

- `--port` sets `workflow.settings.server.port`.
- `--logs-root` sets `logging.log_file` to `<resolve(logsRoot)>/log/lorenz.log`.

When the observability server binds, its actual port is written back into `server.port` and pinned, so subsequent workflow reloads keep the same port. The server prints `Observability API listening on <url>` to stderr.

### Startup sequence

Startup runs in order: register backends, load and validate the workflow, build the coordinator, gate co-residence, construct the runtime, start the server and TUI, then poll.

`registerBuiltinBackends()` runs first and wires every built-in tracker (`linear`, `local`, `memory`, `jira`, `slack`), the jira tool pack (tool kind `jira`), the ACP agent executor, and the built-in worker drivers (`fake`, `static-ssh`, `docker`) into the process-wide registries. It is idempotent.

The coordinator anchors at `baseDir = dirname(workflow.path)`, the directory of the workflow file. `assertSlotsPerMachineGate` then runs as a post-construction check (see [Co-residence gate](#co-residence-gate)). `validateDispatchConfig` runs at startup and again as the runtime's per-reload `validateDispatch` hook, so a bad edit to `WORKFLOW.md` is caught on the next poll rather than at dispatch time.

The worker pool and dispatch coordinator are always constructed - the pool is the single dispatch path. With no `worker.worker_pool` block the pool defaults to the `local` driver at `max: 1`, whose empty worker host keeps runs on the daemon's own in-process endpoint (byte-identical to the pre-pool local path). An internally disabled pool (the drained shape a reload produces) still resolves both to `undefined`.

### Shutdown and exit codes

`SIGINT` and `SIGTERM` are handled by persistent (`process.on`, not `process.once`) listeners. The first signal sets a `shuttingDown` flag and calls `runtime.stop()`. A second `Ctrl+C` while shutting down unmounts Ink and calls `process.exit(130)`. The `finally` block unmounts the TUI, drains the worker pool (`drainWorkerPool`), stops the server, closes the `IssueStore`, then detaches the handlers.

| Exit code | When |
| --- | --- |
| `0` | The daemon ran and stopped cleanly (including `--once` completion). |
| `1` | A startup or runtime error was caught; the message is written to stderr. |
| `130` | A second `Ctrl+C` arrived while the daemon was already shutting down. |

### Environment variables

| Variable | Read by | Effect |
| --- | --- | --- |
| `LORENZ_WORKFLOW` | `packages/workflow` | Default workflow path when `workflowPath` is omitted. Absolute used as-is, relative joined to cwd. |
| `LORENZ_WORKSPACE_ROOT` | `packages/config` | Overrides `workspace.root`. |
| `LORENZ_SSH_CONFIG` | `packages/ssh` | Path passed to `ssh -F` for remote workers. |
| `CLAUDE_CODE_EXECUTABLE` | ACP bridges, `doctor` | Override path to the `claude` CLI. |
| `CODEX_PATH` | ACP bridges, `doctor` | Override path to the `codex` CLI. |

These are the specific env overrides the CLI consults. There is no generic `LORENZ_<KEY>` settings-override mechanism beyond them.

## `lorenz runs`

```sh
lorenz runs [--issue <id>] [--id <runId>] [--failed] [--cost] [--retries] [--limit <limit>] [--url <url>] [--port <port>] [--json]
```

Fetches `GET {base}/api/v1/runs` from a running daemon's observability API and renders a table or raw JSON. The daemon must be running with its dashboard server enabled (the default) for this command to reach an endpoint.

### Flags

| Flag | Type | Default | Meaning |
| --- | --- | --- | --- |
| `--issue <id>` | string | unset | Filter by issue identifier (`issue` query param). |
| `--id <runId>` | string | unset | Show one run and its related attempts (`id` query param, `run` view). |
| `--failed` | boolean | `false` | Show failed runs (`failed=true`). |
| `--cost` | boolean | `false` | Show the token and cost summary (`cost` view). |
| `--retries` | boolean | `false` | Show the retry summary by issue (`retries` view). |
| `--limit <limit>` | positive integer | unset | Limit returned runs. Parsed by `parsePositiveInteger`. |
| `--url <url>` | URL | unset | Observability API base URL. Trailing slashes are trimmed. |
| `--port <port>` | non-negative integer | unset | Observability API localhost port. `0` is treated as unset. |
| `--json` | boolean | `false` | Print the raw JSON response instead of a rendered table. |

### Base-URL precedence

The base URL is resolved in this order:

1. `--url <url>` if supplied. The value is trimmed and trailing slashes are removed. It wins outright; there is no mutual-exclusion check against `--port`.
2. `--port <port>` if greater than `0`. The host comes from the workflow's `server.host`. Port `0` is treated as no explicit port.
3. The workflow's `server.port` if greater than `0`, with `server.host`.
4. Otherwise the command throws `No observability server port configured. Pass --port/--url or set server.port in WORKFLOW.md.`

When precedence falls through to the workflow, the command loads `WORKFLOW.md` to read `server.host` and `server.port`.

### Response handling

| HTTP status | Result |
| --- | --- |
| `200` | Render the `run`, `cost`, `retries`, or `runs` view (or raw JSON with `--json`). |
| `404` | Throw `Run not found` (or the API's error message). |
| `503` | Throw `Observability API unavailable` (or the API's error message). |
| other | Throw `Unexpected response status <N>`. |

Views and their columns:

| View | Trigger | Columns |
| --- | --- | --- |
| `runs` | no view flag | `ID`, `ISSUE`, `AGENT`, `OUTCOME`, `ATTEMPT`, `TURNS`, `TOKENS`, `DURATION`, `SESSION` |
| `run` | `--id` | single-run detail plus a `Related runs` table |
| `cost` | `--cost` | `AGENT`, `RUNS`, `DONE`, `INPUT`, `OUTPUT`, `TOTAL`, `AVG/RUN`, `USD` plus `Top Runs` |
| `retries` | `--retries` | `ISSUE`, `ATTEMPTS`, `LATEST`, `TOKENS`, `RUN ID`, `FAILURE` |

The query string carries `issue`, `failed`, `cost`, `retries`, `id`, and `limit`; the server decides which view to return. See [run-history.md](../features/run-history.md) for what each view means and [http-api.md](http-api.md) for the endpoint contract.

## `lorenz doctor`

```sh
lorenz doctor [--no-dashboard] [--logs-root <path>] [workflowPath]
```

Validates a workflow and the local runtime prerequisites, then prints a report. It never polls or dispatches.

### Argument and flags

| Argument / flag | Type | Default | Meaning |
| --- | --- | --- | --- |
| `workflowPath` | path | resolved like the daemon | The workflow to validate. |
| `--no-dashboard` | boolean | dashboard on | Skip the dashboard static-asset check. |
| `--logs-root <path>` | path | unset | Resolve the `log_path` check against `<path>/log/lorenz.log`. |

### Check pipeline

`doctor` runs checks in order. A `workflow_file` or `workflow_load` error short-circuits the report before later checks run.

| Check id | What it verifies | Failure status |
| --- | --- | --- |
| `workflow_file` | The workflow path exists, is a file, and is readable. | `error` (short-circuits) |
| `workflow_load` | The workflow loads and parses. | `error` (short-circuits) |
| `config_deprecations` / `config_deprecation_<key>` | No deprecated config keys are in use; one warning check per deprecated key (legacy top-level `codex:`/`claude:` sections, flat-shape `tracker` provider options) names its replacement. | `warning` |
| `dispatch_config` | `validateDispatchConfig` passes with the built-in registries. | `error` |
| `dashboard_assets` | `index.html` and `assets/` exist under `server.static_dir` (or the default). | `warning` |
| `log_path` | The nearest existing parent of `logging.log_file` is a writable directory. | `warning` |
| `agent_bridge` / `agent_bridge_<kind>` | The ACP bridge command (and `env`/`exec` wrapper) is on `PATH`, and a node bridge target is readable. | `warning` |
| `agent_cli_claude` / `agent_cli_codex` | The underlying agent CLI is discoverable. | `warning` |

`dashboard_assets` resolves the static dir from `server.static_dir`, falling back to the dashboard `dist` directory bundled with the CLI. Missing assets are a warning, not an error.

The agent-bridge checks run only when an active agent has `executor: acp`. They inspect the active config and every state in `status_overrides`. When `worker.ssh_hosts` is non-empty, the bridge presence is not probed over SSH; the check returns a warning instead. For `claude`-compatible bridges, `doctor` looks for the `claude` CLI (honoring `CLAUDE_CODE_EXECUTABLE`); for `codex-acp` bridges, it looks for `codex` (honoring `CODEX_PATH`). Bridge commands are tokenized by a hand-rolled parser that understands env-var prefixes, `exec`, and `env`-wrapper invocations.

### Report status and exit code

The overall status is `error` if any check errors, otherwise `warning` if any check warns, otherwise `ok`. The command exits `1` only when the overall status is `error`. Warnings keep the exit code at `0`.

## Worker driver loading

The daemon resolves `worker.worker_pool.driver` against the worker-driver registry. An exact registered kind (`fake`, `static-ssh`, `docker`, or an extension) always wins, because `registry.get(driver)` is checked before the string is parsed as a module. A published npm package named `docker` cannot shadow the built-in.

On a miss, the string is parsed as a module reference and dynamic-imported.

The specifier grammar is an npm name, `@scope/name`, `./relative`, `../relative`, `/absolute`, or a `file:` URL, with an optional `#exportName` suffix. Relative and absolute specifiers resolve against `baseDir = dirname(workflow.path)`. A `#exportName` selects a named export; without it the default export is used. Empty specifiers and cache-busting query strings (`?`) are rejected with `worker_pool_driver_invalid_specifier`.

The module registers under the exact configured driver string, not the module's self-declared `kind`. Module code is pinned for the daemon lifetime by Node's ESM cache: changing driver code needs a daemon restart, while changing config to a new specifier hot-loads on reload. On reload the injected `driverLoader` awaits `ensureWorkerDriverLoaded` before `pool.reconcile`, so reconcile stays synchronous and transactional.

The loader emits these structured events:

| Event | When |
| --- | --- |
| `worker_pool_driver_loaded` | A new module specifier is imported and registered. |
| `worker_pool_driver_module_pinned` | A reload re-encounters an already-loaded specifier. |
| `worker_pool_driver_unavailable` | The specifier could not be resolved as a kind or a module. |
| `worker_pool_driver_invalid_specifier` | The specifier is empty or carries a query string. |
| `worker_pool_driver_module_invalid` | The module has no usable default or named export. |
| `worker_pool_driver_sdk_mismatch` | The module's SDK version is incompatible. |

See [worker-driver.md](../extensions/worker-driver.md) and [out-of-tree.md](../extensions/out-of-tree.md) for authoring and shipping a driver.

## Co-residence gate

`worker.worker_pool.slots_per_machine` (legacy key `max_in_flight`) defaults to `1`. The default always passes the gate, keeping the single-tenant path byte-identical. Setting it above `1` triggers `assertSlotsPerMachineGate`, which throws unless both conditions hold:

1. The coordinator advertises `capabilities.perRunEndpoint === true` (each run slot owns its own MCP endpoint).
2. `worker.worker_pool.co_residence` is explicitly opted in.

The gate is a post-construction check, because the per-run-endpoint capability exists only once the coordinator is built. The same rule is enforced on reload via the shared `checkSlotsPerMachineGate` predicate. See [security.md](../security.md) for the blast-radius rationale.

## See also
- [cli.md](../cli.md) - the tutorial these commands back
- [configuration.md](configuration.md) - every workflow setting `lorenz` reads
- [run-history.md](../features/run-history.md) - what the `runs` views report
- [http-api.md](http-api.md) - the `/api/v1/runs` endpoint contract
- [events.md](events.md) - the structured events emitted by driver loading
- [troubleshooting.md](../troubleshooting.md) - what to do when `doctor` warns
