# Architecture

This page is for contributors extending Lorenz with a new backend. It covers the layered
package graph, how dependencies stay pointing down, and the four extension axes (tracker,
tool pack, agent executor, worker driver) that let you add a backend as one package plus one
registration line.

Lorenz is a provider-agnostic TypeScript core: a small set of contracts at the bottom, self-contained
extensions at the top, and a mechanical gate that keeps the two from tangling.

## Boundaries

Adding a backend is one new package that implements and registers its own contracts, plus one
line at the composition root that invokes that registration. It is never a sweep through `domain`,
`config`, `mcp`, and `cli`. A tracker, a tool pack, an agent executor, and a worker driver each
have a single contract and a single registry, and the only place the built-in set is named is
`registerBuiltinBackends()` in `apps/cli/src/daemon.ts`.

This holds because of three rules:

- Contracts live below the engine, so a backend depends only on SDK packages.
- Extensions register themselves; the engine reads them through a registry, never by import.
- A dependency-cruiser rule fails the build if an extension reaches into an engine package.

## Layers

Dependencies point strictly down. A package imports from its own layer or below, never above.

<p align="center"><img src="assets/diagrams/architecture-layers.svg" alt="architecture layers diagram" width="820" style="width:100%;max-width:820px;height:auto" /></p>
*The five layers, with imports flowing downward only and the engine reaching backends through registries.*

```
apps/cli                                      composition root / binary
─────────────────────────────────────────────────────────────────────────
extensions/{linear,local,memory,jira,         extensions: tracker providers,
  slack}-tracker, extensions/docker-worker    their tool packs, worker drivers
─────────────────────────────────────────────────────────────────────────
@lorenz/config, workflow, runtime,            engine (backend-agnostic)
  orchestrator, dispatch, mcp, worker-pool,
  agent-runner, acp, server, tui, …
─────────────────────────────────────────────────────────────────────────
@lorenz/tracker-sdk, tool-sdk, agent-sdk,     extension SDKs: contracts + registries
  worker-sdk
─────────────────────────────────────────────────────────────────────────
@lorenz/domain                                pure types, constants, leaf logic
```

**domain** (`packages/domain/src/index.ts`) is the dependency-free vocabulary, with no
backend knowledge. `TrackerKind`, `AgentKind`, and `WorkerDriverKind` are open `string` aliases,
not closed unions: the supported set is whatever the composition root registered. `TrackerSettings`
holds only the fields every tracker shares, plus an opaque `options` bag owned by the provider.
`domain` also owns the executor runtime contracts `AgentExecutor`, `AgentSession`, and the
`AgentUpdate` discriminated union, plus bounds constants and the `ClockPort`. Its only runtime
dependency is `@agentclientprotocol/sdk` types.

**The four SDK packages** each define exactly one builder-facing contract and one registry:

- `tracker-sdk` defines `TrackerProvider` and `TrackerRegistry`, the options-bag helpers, and the
  provider-neutral `tracker` tool pack (`createTrackerToolProvider`).
- `tool-sdk` defines `ToolProvider` and `ToolRegistry`, the mount and route helpers
  (`mountedToolSpecs`, `executeMountedTool`), the `ToolResult` builders, and a side-effect-free
  query/filter DSL.
- `agent-sdk` defines `AgentExecutorProvider` and `AgentExecutorRegistry`. The `AgentExecutor`
  runtime contract itself lives in `domain`, not here.
- `worker-sdk` defines `WorkerDriver`, `WorkerDriverFactory`, and `WorkerDriverRegistry`, the
  out-of-tree module handshake, the reference `FakeWorkerDriver`, and the shared conformance suite.

**engine** packages resolve a `tracker.kind` through a `TrackerRegistry`, tool packs through a
`ToolRegistry`, an executor through an `AgentExecutorRegistry`, and a worker driver through a
`WorkerDriverRegistry`, the process-wide defaults unless one is injected. They never import a
provider or pack.

**The composition root** (`apps/cli`) decides what the binary supports. `registerBuiltinBackends()`
wires each built-in extension into the four default registries. A downstream embedder calls a
different set against its own registries.

Two naming facts matter for contributors. Extensions live under top-level `extensions/`, not under
`packages/`. The exception is `static-worker`: the static-ssh driver lives at
`packages/static-worker` because it uses the core SSH path rather than an external provider
boundary. The `fake` driver is not an extension at all; it ships inside `@lorenz/worker-sdk`.

## Enforcement

The layering is checked mechanically. `.dependency-cruiser.cjs` (run as `pnpm architecture:check`,
part of `mise run check`) validates the real import graph against the layer rules, plus the
file-level rules no other gate covers: no circular imports, cross-package imports only through a
package's published `exports` surface, and no package importing an app.

The rule that holds the extension boundary is `extensions-depend-on-sdk-layers-only`: a package
under `extensions/` that imports an engine package fails CI. Extension membership is by directory,
so the rule applies by construction. The engine, all of `packages/`, may never import from
`extensions/`.

Two neighbouring gates close the remaining gaps. pnpm's strict `node_modules` plus
`scripts/sync-tsconfig-refs.ts` keep undeclared `package.json` dependencies unbuildable, and knip
flags dependencies that are declared but unused. `pnpm architecture:graph` renders the same graph
as Mermaid for inspection.

## The four extension points at a glance

<p align="center"><img src="assets/diagrams/extension-points.svg" alt="extension points diagram" width="920" style="width:100%;max-width:920px;height:auto" /></p>
*The four extension axes: each is one contract, one registry, and one registration call at the composition root.*

| Axis | Contract | Defined in | Registry | Selected by |
| --- | --- | --- | --- | --- |
| Tracker | `TrackerProvider` | `@lorenz/tracker-sdk` | `defaultTrackerRegistry` | `trackers.<name>.provider` (or legacy `tracker.kind`) |
| Tool pack | `ToolProvider` | `@lorenz/tool-sdk` | `defaultToolRegistry` | `tools.<pack>` map key + tracker `defaultToolPacks` |
| Agent executor | `AgentExecutorProvider` | `@lorenz/agent-sdk` | `defaultAgentExecutorRegistry` | `agents.<kind>.executor` |
| Worker driver | `WorkerDriverFactory` | `@lorenz/worker-sdk` | `defaultWorkerDriverRegistry` | `worker.worker_pool.driver` |

Each axis has a build recipe page under `extensions/`. The rest of this section is the contract at
a glance; follow the link for the recipe.

### Tracker provider

`TrackerProvider` is the single contract between the core and a tracker backend. Only `kind` and
`createClient` are mandatory; every other hook is optional.

| Hook | Called by | Purpose |
| --- | --- | --- |
| `kind` | registry | provider selector |
| `configAliases` | config | snake_case aliases for provider keys |
| `envFallbacks` | config | env vars backing shared fields |
| `defaultEndpoint` | config | endpoint when `tracker.endpoint` is unset |
| `parseOptions` | config | validate provider keys into `settings.tracker.options` |
| `validateDispatch` | CLI startup | reject undispatchable settings early |
| `createClient` | runtime | the client that feeds dispatch |
| `createToolOps` | neutral tool pack | normalized issue ops behind `tracker_*` tools |
| `defaultToolPacks` | MCP mount | provider-specific packs mounted by default |
| `projectUrl` | TUI / dashboard | operator-facing project link |

Provider-specific settings never appear as named fields on `TrackerSettings`. They live in
`settings.tracker.options`, validated once at parse time by `parseOptions` and read through the
provider's typed accessor (`linearTrackerOptions(settings)`, `jiraTrackerOptions(settings)`). Core
code must not read `options` keys directly. The full recipe is in
[extensions/tracker-provider.md](extensions/tracker-provider.md).

### Tool pack

Agent-facing MCP tools are a separate axis from dispatch. `ToolProvider` is a named pack:
`toolSpecs(settings)` advertises tools and `executeTool(name, input, context)` runs one. The
mounting endpoint resolves packs in order: the neutral `tracker` pack, then the dispatch tracker's
`defaultToolPacks`, then every key of the workflow `tools:` map, de-duplicated by first-seen name.

A mount is one flat namespace. `mountedToolSpecs` throws at mount time on a tool-name collision
across two different packs. A pack that throws during execution surfaces as a failed `ToolResult`
(JSON-RPC `isError`), never as a transport error.

The neutral pack is named the literal string `"tracker"`. It serves seven provider-neutral tools
against `TrackerToolOps`: `tracker_read_issue`, `tracker_query`, `tracker_update_status`,
`tracker_list_comments`, `tracker_comment`, `tracker_update_comment`, and `tracker_create_issue`.
Any tracker whose provider implements `createToolOps` gets all seven without writing a pack; a tool
whose backing op is missing reports itself unavailable rather than failing mid-call.
Provider-specific packs (`linear`, `local`, `slack`) live in their tracker packages and carry the
tools only that backend can offer. The recipe is in
[extensions/tool-pack.md](extensions/tool-pack.md).

### Agent executor

Agents extend along two independent axes. **Agent kinds** are pure configuration: `Settings.agents`
is an open record, so adding a kind is a new `agents.<name>` entry in workflow YAML with no code.
**Executors** are how an agent record runs. `AgentExecutorProvider` is the contract: an `executor`
selector matched against `agents.<kind>.executor`, optional `configAliases` and `parseOptions` for
the executor's slice of an `agents.<kind>` record, optional `validateAgent` for startup checks, and
`createExecutor(kind, settings)` producing the `AgentExecutor` the agent-runner drives.
`createExecutor` may be synchronous or return a `Promise<AgentExecutor>`.

The built-in `"acp"` executor lives in `@lorenz/acp`; the CLI registers it at startup.
`AgentConfig` mirrors `TrackerSettings`: only shared fields (`executor`, turn and stall timeouts)
live on the record, and everything else sits in an executor-owned `options` bag.
`validateDispatchConfig` rejects records whose executor selector is unregistered, listing the known
selectors. The recipe is in [extensions/agent-executor.md](extensions/agent-executor.md).

### Worker driver

The warm worker pool (`@lorenz/worker-pool`, an engine package) leases SSH-addressable machines per
run. The machines come from a **worker driver**: the adapter that provisions, probes, destroys, and
lists workers for one infrastructure. "Driver" is deliberate; "provider" stays reserved for tracker and
executor providers.

| Hook | Called by | Purpose |
| --- | --- | --- |
| `kind` | registry | `worker.worker_pool.driver` selector |
| `create(options, deps)` | pool construction / driver swap | build the driver from `workers.<name>` options, fail-loud |
| `provision` | pool grow / warm top-up | create or re-adopt one worker (idempotent on `workerId`) |
| `probe` | readiness gate, reaper health pass | cheap reachability check |
| `destroy` | reaper / recycle / drain | tear one worker down (idempotent, tolerant of already-gone) |
| `list` | hydrate re-adoption, reaper reconcile | the backend's authoritative inventory |
| `capabilities` | pool | `sshAddressable` / `ephemeral` / `usesLedger` gates |

The pool calls only the four ops `provision`, `probe`, `destroy`, and `list`, and owns every
lifecycle decision itself: leasing, the FIFO waiter queue, warm top-up, the reaper, spend caps, the
write-ahead ledger, and crash recovery. Drivers never see pool state and never import engine
packages: SSH arrives through `DriverDeps.runSsh`, injected by the pool. Options arrive verbatim
from the selected `workers.<name>` profile minus its `driver` key.

Built-in drivers are `fake` (in-memory, in the SDK), `static-ssh` (`@lorenz/static-worker`), and
`docker` (`extensions/docker-worker`). A driver can also load **out of tree** by module specifier
with an `sdkVersion` handshake: `worker.worker_pool.driver` accepts an npm name, `@scope/name`, a
`./relative` or `/absolute` path, or a `file:` URL with an optional `#exportName` suffix. The loader
validates the module via `assertWorkerDriverModule` and rejects any `sdkVersion` other than
`WORKER_DRIVER_SDK_VERSION` (`1`) before it reaches the registry. The conformance kit
(`@lorenz/worker-sdk/conformance`, `runDriverConformanceSuite`) pins the contract every driver must
satisfy. Recipes: [extensions/worker-driver.md](extensions/worker-driver.md) and
[extensions/out-of-tree.md](extensions/out-of-tree.md).

## Registries and the options-bag pattern

Every registry follows the same shape: `register` / `get` / `require` and a kind-listing method
(`kinds`, `names`, or `executors`), backed by a process-wide `default*Registry` singleton.
`register` is idempotent for the same instance and throws `<thing> already registered for
kind/name/selector: <k>` when a different instance claims the same key; a blank key throws. The
listing methods return sorted arrays. `require` throws a backend-specific message that lists the
known keys, for example `unsupported tracker.kind: <k> (known kinds: ...)` or
`worker_pool_driver_unavailable: <kind>`.

`parseConfig`, `validateDispatchConfig`, the MCP server, and the CLI executor factory use these four
registries as defaults. Library code only reads from them, and no package registers
into them as an import side effect. The CLI entrypoints call `registerBuiltinBackends()` at the top
of their function bodies, before any config is parsed, so behavior never depends on module import
order. A consumer that needs isolation (tests, embedders) constructs private registries and passes
them explicitly; every registry consumer accepts them as parameters.

The **options-bag pattern** keeps backend-specific config out of the shared types.
`TrackerSettings`, `AgentConfig`, and a worker profile each expose only the fields every backend on
that axis shares; everything else is an opaque `options` record the provider validates at parse time
and reads through its own typed accessor. The tracker SDK ships the helpers for this:
`rejectUnknownOptions(options, known, kind)`, `stringOption`, `stringListOption` (an empty list
collapses to `undefined`), and `resolveEnvReference("$VAR", env)`. Their errors are shaped
`tracker.<key> must be...`, so an operator sees the exact failing key.

## The composition root

`registerBuiltinBackends()` in `apps/cli/src/daemon.ts` is the single place backend identity is
hardcoded. It registers the `linear`, `local`, `memory`, `jira`, and `slack` trackers, the neutral
`tracker` tool pack, the `acp` executor provider, and the `fake`, `static-ssh`, and `docker` worker
drivers into the four default registries. It is idempotent, so calling it more than once is safe.

To add a backend, implement the contract in a new package under `extensions/`, export a
`register<Name>...(registries?)` function that registers your provider or factory idempotently, and
add one call to it inside `registerBuiltinBackends()`. That is the one registration line. The
dependency-cruiser rule holds the other side: your package may depend on `domain` and its SDK, and
nothing in the engine.

`test/tracker-extension.test.ts` is the executable form of the tracker recipe. It builds a fake
provider entirely from SDK surface and drives config parsing, dispatch validation, client creation,
and MCP tools through it. If a new backend needs more than the steps above, that test and this
page have regressed.

## See also
- [source-map.md](source-map.md) - which package owns which file, for the same contributor persona.
- [extensions/index.md](extensions/index.md) - the four extension recipes and where to start.
- [how-it-works.md](how-it-works.md) - the end-to-end run path the layers serve.
- [reference/configuration.md](reference/configuration.md) - every config key the registries select on.
- [reference/glossary.md](reference/glossary.md) - exact terms for tracker, pack, executor, and driver.
