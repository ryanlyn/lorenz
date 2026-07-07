# Source map

Where things live in the Lorenz repo. This page is for contributors and extension authors who need to find the package that owns a behavior before reading code. It walks the directory tree layer by layer: the leaf/domain packages, the four extension SDKs, the engine, the in-tree extensions, the apps, and the vendored ACP bridges. For the central packages it names the two or three files you open first.

Lorenz is a TypeScript monorepo. Three top-level trees hold the code: `packages/` (the SDKs and engine), `extensions/` (in-tree backend implementations), and `apps/` (shipped binaries and the dashboard SPA). Builder-facing contracts live in `packages/`; backend implementations live in `extensions/`. A dependency-cruiser rule named `extensions-depend-on-sdk-layers-only` blocks extensions from reaching into engine packages, so the only path from an extension into the engine is through an SDK.

## Layering at a glance

Packages stack in dependency order. Each layer depends only on the ones above it.

| Layer | Packages | Owns |
| --- | --- | --- |
| Leaf / domain | `domain`, `issue`, `log-file` | Pure vocabulary, types, bounds, issue normalization |
| Extension SDKs | `tracker-sdk`, `tool-sdk`, `agent-sdk`, `worker-sdk` | The four builder-facing contracts plus registries |
| Engine | `config`, `workflow`, `prompt`, `dispatch`, `policies`, `retry-scheduler`, `orchestrator`, `runtime`, `runtime-events`, `projections`, `dispatch-coordinator`, `worker-pool`, `worker-host-pool`, `ssh`, `static-worker`, `agent-runner`, `acp`, `mcp`, `server`, `presenter`, `humanize`, `traceviz-emitter`, `traceviz-server`, `tui`, `cli-kit`, `workspace`, `test-utils` | The poll/dispatch loop, agent execution, MCP, observability |
| Extensions | `extensions/linear-tracker`, `extensions/jira-tracker`, `extensions/local-tracker`, `extensions/memory-tracker`, `extensions/slack-tracker`, `extensions/docker-worker` | Concrete trackers and one worker driver |
| Apps | `apps/cli`, `apps/web`, `apps/traceviz` | The `lorenz` binary, the React SPA, the standalone trace viewer |
| Vendored | `vendor/codex-acp`, `vendor/claude-agent-acp` | Patched ACP bridge subprocesses |

The composition root in `apps/cli/src/daemon.ts` (`registerBuiltinBackends`) is the one place backend identity is hardcoded. It registers every built-in tracker along with the tool packs each tracker owns, the ACP executor, and the worker drivers into the four default registries before any config is parsed. See [architecture](architecture.md) for how the layers run as one process and [extensions/index.md](extensions/index.md) for the build recipes.

## Leaf and domain packages

The bottom of the stack. Everything else imports them. `@lorenz/domain` is the true leaf: its only runtime dependency is `@agentclientprotocol/sdk`. `@lorenz/issue` depends on `@lorenz/domain`, and `@lorenz/log-file` pulls in `pino` and `pino-roll` for the rolling event log.

| Package | What it owns |
| --- | --- |
| `@lorenz/domain` | The cross-cutting vocabulary: `Issue`, `Settings` and every sub-settings interface, `AgentConfig`, `TrackerSettings`, the `AgentUpdate` union, `ClockPort`, bounds constants and validators. Also the executor runtime contracts `AgentExecutor` / `AgentSession` / `AgentUpdate`, which live here, not in `agent-sdk`. `TrackerKind` / `AgentKind` / `WorkerDriverKind` are open-ended `string` aliases, not closed unions. |
| `@lorenz/issue` | Issue normalization: `normalizeIssue`, `defaultStateType`, `ensembleSize`, `isTerminalState`. |
| `@lorenz/log-file` | `defaultLogFile(root)`, the optional JSON event-log path helper. |

## Extension SDKs

Four packages, one builder-facing contract each, plus a registry. Every registry follows the same shape: `register` / `get` / `require` / a `kinds`-style listing, a process-wide `default*Registry` singleton, idempotent re-registration, and a throw on a conflicting key. Adding a backend is one package plus one registration line in the composition root.

| Package | Contract | First files to open |
| --- | --- | --- |
| `@lorenz/tracker-sdk` | `TrackerProvider` + registry; `TrackerComment`; options helpers | `src/provider.ts`, `src/registry.ts` |
| `@lorenz/tool-sdk` | `ToolProvider` + `ToolRegistry`; mount-time fan-out; the read-only query/filter DSL | `src/provider.ts`, `src/registry.ts`, `src/filter.ts` |
| `@lorenz/agent-sdk` | `AgentExecutorProvider` + `AgentExecutorRegistry` (the `AgentExecutor` runtime type lives in `domain`) | `src/provider.ts` |
| `@lorenz/worker-sdk` | `WorkerDriver` + `WorkerDriverFactory` + registry; the out-of-tree handshake; the reference `FakeWorkerDriver`; the conformance suite | `src/types.ts`, `src/registry.ts`, `src/module.ts` |

`extensions/jira-tracker`'s `src/tools.ts` holds the `jira` pack and the source of truth for the seven `jira_*` tool names: `jira_read_issue`, `jira_query`, `jira_update_status`, `jira_list_comments`, `jira_comment`, `jira_update_comment`, `jira_create_issue` (plus the `DEFAULT_SELECT` field set). `worker-sdk`'s `src/conformance.ts` lives under `src/` (not `test/`) so it compiles to `dist/` and each driver imports it via the `@lorenz/worker-sdk/conformance` subpath. `worker-sdk`'s `src/fake.ts` ships the `fake` driver in the SDK itself, not as an extension. None of the four SDKs has a README; the authoritative prose is this docs set plus each package's tests. See [extensions/tracker-provider.md](extensions/tracker-provider.md), [extensions/tool-pack.md](extensions/tool-pack.md), [extensions/agent-executor.md](extensions/agent-executor.md), and [extensions/worker-driver.md](extensions/worker-driver.md).

## Config and workflow

These turn a `WORKFLOW.md` file into typed `Settings` plus a renderable prompt.

| Package | What it owns | First files to open |
| --- | --- | --- |
| `@lorenz/config` | The whole config schema (Zod), snake_case-to-camelCase aliasing, secret resolution, `status_overrides`, dispatch validation | `src/parse.ts`, `src/defaults.ts`, `src/schemas.ts` |
| `@lorenz/workflow` | Front-matter/body split, file location (`LORENZ_WORKFLOW`), content stamping for change detection, `loadWorkflow` | `src/index.ts` |
| `@lorenz/prompt` | Liquid prompt rendering at dispatch time: `buildPrompt`, `continuationPrompt` | `src/index.ts` |

`config`'s `src/parse.ts` is the main entry (`parseConfig`, `settingsForIssueState`, `validateDispatchConfig`); `src/defaults.ts` holds every default value and `DEFAULT_CLAUDE_MODEL`. Hot-reload itself lives in `runtime`, not here. See [workflows.md](workflows.md) and [reference/configuration.md](reference/configuration.md).

## Dispatch decision packages

Pure, side-effect-free policy split across small packages. The orchestrator and runtime compose them into the loop.

| Package | What it owns | First files to open |
| --- | --- | --- |
| `@lorenz/dispatch` | Eligibility predicates, routing, concurrency-cap reasons, deterministic sort, ensemble slot selection | `src/index.ts` |
| `@lorenz/policies` | Retry backoff math, stop-reason classification, reconciliation reasons, monotonic usage merge, least-loaded host selection | `src/retry.ts`, `src/reconciliation.ts`, `src/workerHost.ts` |
| `@lorenz/retry-scheduler` | A per-issue timer firing `onDue` at a retry's monotonic deadline to nudge the poll | `src/index.ts` |

`dispatch`'s `src/index.ts` holds `shouldDispatchIssue`, `dispatchBlockReason`, `sortForDispatch`, and `firstUnclaimedSlot`. See [dispatch.md](dispatch.md) and [features/dispatch-routing.md](features/dispatch-routing.md).

## Orchestrator and runtime

The control-plane core. The default claim store is in-memory; explicit durable stores add crash
recovery and retry durability for operators that select them.

| Package | What it owns | First files to open |
| --- | --- | --- |
| `@lorenz/orchestrator` | The single authoritative in-memory scheduling state and the only mutator of it: eligibility, slot claiming, pool reservations, agent-update application, retries, reconciliation | `src/index.ts` |
| `@lorenz/runtime` | The recurring poll loop, per-run dispatch promises, reconciliation passes, transactional workflow reload, `RuntimeSnapshot` assembly | `src/index.ts` |
| `@lorenz/runtime-events` | The `RuntimeSnapshot` shape and the canonical `RUNTIME_EVENT_TYPES` / `RUNTIME_RUN_OUTCOMES` vocabularies | `src/index.ts` |
| `@lorenz/projections` | A bounded ring buffer: the last 20 events and last 50 run-history entries, merged into the snapshot | `src/index.ts` |

`orchestrator`'s `src/index.ts` holds `Orchestrator`, `OrchestratorState`, and `createState`. `runtime`'s `src/index.ts` holds `LorenzRuntime` and `LorenzRuntimeOptions`, the dependency-injection bag the CLI binds. See [agent-orchestrator.md](agent-orchestrator.md) and [reference/events.md](reference/events.md).

## Dispatch coordinator and worker pool

These produce the SSH-addressable host each run executes on. The warm pool (`worker.worker_pool`) is the single dispatch path; the legacy `worker.ssh_hosts` list folds into a `static-ssh` pool over a fixed set of hosts with no provisioning.

| Package | What it owns | First files to open |
| --- | --- | --- |
| `@lorenz/dispatch-coordinator` | The runtime-facing capacity authority: wraps the pool plus a per-run MCP endpoint manager, mints `RunSlot`s, and gates multi-slot machines on per-run claim enforcement | `src/coordinator.ts`, `src/types.ts`, `src/gate.ts` |
| `@lorenz/worker-pool` | The warm-pool lifecycle: leasing, FIFO waiters, reaper, spend caps, the write-ahead ledger, crash recovery via hydrate | `src/pool.ts`, `src/reaper.ts`, `src/ledger.ts` |
| `@lorenz/worker-host-pool` | Per-run reverse SSH (MCP) tunnels. A separate concern from the worker pool despite the similar name | `src/index.ts` |
| `@lorenz/ssh` | SSH execution and reverse tunnels via execa; honors `LORENZ_SSH_CONFIG` | `src/index.ts` |
| `@lorenz/static-worker` | The `static-ssh` driver (fixed host list); ships under `packages/`, not `extensions/` | `src/index.ts` |

The two similarly named pools are distinct: `worker-pool` is the warm machine pool, `worker-host-pool` manages reverse MCP tunnels. See [workers/index.md](workers/index.md), [workers/worker-pool.md](workers/worker-pool.md), and [workers/static-ssh.md](workers/static-ssh.md).

## Agent execution

How one coding-agent turn actually runs.

| Package | What it owns | First files to open |
| --- | --- | --- |
| `@lorenz/agent-runner` | The run loop: workspace creation, before/after hooks, session open, the `runTurn` loop up to `agent.max_turns` | `src/index.ts` |
| `@lorenz/acp` | The single built-in executor (`executor: "acp"`): spawns the bridge subprocess, drives the Agent Client Protocol, enforces turn and stall timeouts, accounts usage | `src/index.ts`, `src/options.ts` |
| `@lorenz/workspace` | Per-issue workspace creation, skill overlay, hook execution, cleanup (`createWorkspaceForIssue`, `runHook`, `removeIssueWorkspaces`) | `src/index.ts` |

See [agents/index.md](agents/index.md), [agents/acp-bridges.md](agents/acp-bridges.md), and [workspace.md](workspace.md).

## MCP and tools

The layer that exposes agent-callable tools over the MCP JSON-RPC endpoint.

| Package | What it owns | First files to open |
| --- | --- | --- |
| `@lorenz/mcp` | The Hono MCP server at `POST /mcp`: pack mounting, `tools/list` and `tools/call`, bearer-token auth, per-agent endpoint leasing | `src/server.ts`, `src/tools.ts`, `src/auth.ts` |

The tool and tracker contracts themselves live in `tool-sdk` and `tracker-sdk` (above); `mcp`'s `src/agentEndpoint.ts` leases the endpoint (local, remote tunnel, or per-run tunnel) consumed by sessions. See [reference/jira-tools.md](reference/jira-tools.md) and [reference/http-api.md](reference/http-api.md).

## Observability

Turning the runtime snapshot into operator-facing views.

| Package | What it owns | First files to open |
| --- | --- | --- |
| `@lorenz/server` | The Hono HTTP server (`startObservabilityServer`): SPA serving, `/api/v1/*` REST, the `/ws` WebSocket push, trace routes, the `/mcp` mount, the SQLite `IssueStore` | `src/index.ts`, `src/ws.ts`, `src/trace-routes.ts` |
| `@lorenz/presenter` | Pure functions mapping the camelCase snapshot to snake_case JSON for the HTTP API and WebSocket | `src/index.ts` |
| `@lorenz/humanize` | Raw Codex/Claude/ACP event JSON into short one-line summaries | `src/index.ts` |
| `@lorenz/tui` | The Ink terminal dashboard (`RuntimeApp`, `formatDashboard`) | `src/index.tsx` |
| `@lorenz/traceviz-emitter` | `TraceEmitter`: appends one JSON line per `AgentUpdate` to `<traceDir>/<issueId>/trace.jsonl` | `src/index.ts` |
| `@lorenz/traceviz-server` | The framework-free trace library: `TraceWatcher`, `parseTraceLines`, `computeStats` | `src/watcher.ts`, `src/parser.ts` |
| `@lorenz/cli-kit` | Shared Commander helpers (arg parsers, help/error normalization) | `src/index.ts` |

See [observability.md](observability.md) and [reference/http-api.md](reference/http-api.md).

## Extensions

Concrete backend implementations live under top-level `extensions/`, never under `packages/`. Each is registered by `registerBuiltinBackends`.

| Extension | What it owns |
| --- | --- |
| `extensions/linear-tracker` | The `linear` tracker provider plus its `linear` tool pack (`linear_graphql`). |
| `extensions/jira-tracker` | The `jira` and `jira-mcp` tracker providers; owns and mounts the `jira` pack (the seven `jira_*` tools) defined in its own `src/tools.ts`. |
| `extensions/local-tracker` | The `local` file-board tracker plus its `local` tool pack. |
| `extensions/memory-tracker` | The in-memory fixture tracker for tests and dry runs; declares no `defaultToolPacks`, so it advertises zero tools. |
| `extensions/slack-tracker` | The `slack` tracker provider plus its `slack` tool pack. |
| `extensions/docker-worker` | The `docker` worker driver (disposable containers); ephemeral, uses the ledger. |

See [trackers/index.md](trackers/index.md), [trackers/memory.md](trackers/memory.md), and [workers/docker.md](workers/docker.md).

## Apps

| App | What it owns |
| --- | --- |
| `apps/cli` | The shipped `lorenz` binary and the composition root. Defines the daemon, run-history, daemon-control, and doctor commands; wires every adapter into `LorenzRuntime`; and loads out-of-tree worker drivers. First files: `src/main.ts`, `src/daemon.ts`, `src/workerDriverLoader.ts`. |
| `apps/web` | The React/Vite SPA (package `@lorenz/dashboard`): the ops Overview and the trace viewer, behind a `#/` and `#/trace/:id` hash router. First files: `src/App.tsx`, `src/features/ops/`. |
| `apps/traceviz` | A standalone read-only viewer that serves one `trace.jsonl` file (`pnpm traceviz <file>`). First files: `app.ts`, `serve.ts`. |

The CLI `bin` shim is `apps/cli/bin/lorenz.js`, which imports the built `dist/bin/cli.js`. See [cli.md](cli.md) and [getting-started.md](getting-started.md).

## Vendored bridges

`vendor/` holds Lorenz-patched copies of the two ACP bridge subprocesses the `acp` executor spawns.

| Directory | What it owns |
| --- | --- |
| `vendor/codex-acp` | The Codex bridge; consumes per-session `_meta["symphony/config"]` (config.toml shape), emits `symphony/callUsage` and `symphony/totalUsage`. |
| `vendor/claude-agent-acp` | The Claude bridge; consumes `_meta["symphony/settings"]` (settings.json shape) and rewrites `/mcp:` slash commands. |

Patched lines are tagged with `symphony-patch` comments; `grep -rn symphony-patch vendor/*/dist` finds every divergence from upstream. Both resolve locally only as pnpm workspace packages; remote hosts run the configured bridge command verbatim. See [agents/acp-bridges.md](agents/acp-bridges.md).

## Tests and sandbox

Two test surfaces sit outside the per-package `test/` directories.

- `test/` (repo root) holds cross-package integration and policy tests: architecture boundary checks (`architecture-boundaries.test.ts`), tracker and tool-pack mix tests, worker-pool end-to-end and multitenant tests, live SSH and live Claude tests, and the sandbox-driven scenario suites (`sandbox-*.test.ts`). Each engine package also carries its own `test/` directory next to `src/`.
- `sandbox/` is the deterministic simulation harness: a fake clock, a fake runner, seed scripts, and YAML scenarios (`scenarios.yaml`) that drive the orchestrator and runtime without real agents. `sandbox/INVARIANTS.md` records the properties the scenario tests assert. `@lorenz/test-utils` (`packages/test-utils`) supplies the shared arbitraries, builders, and assertion helpers those tests import.

See [troubleshooting.md](troubleshooting.md) for reproducing failures and [reference/spec.md](reference/spec.md) for the behaviors the invariants pin.

## See also
- [architecture.md](architecture.md) - how these layers compose into one running daemon
- [extensions/index.md](extensions/index.md) - build recipes for new trackers, tool packs, executors, and drivers
- [reference/configuration.md](reference/configuration.md) - every config key the packages above read
- [reference/glossary.md](reference/glossary.md) - the vocabulary these packages share
