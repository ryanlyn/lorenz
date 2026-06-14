# Architecture

This workspace is organized as a small provider-agnostic core plus self-contained extension
packages. The measure of cohesion we hold it to: adding a new backend (a tracker, a tool
pack, and over time an agent executor) is one new package that implements and registers its
own contracts, plus one line at the composition root invoking that registration - never a
sweep through domain, config, MCP, and CLI code.

## Layers

Dependencies point strictly downward. A package may import from its own layer or below,
never from above.

```
apps/cli, apps/traceviz                       composition roots / binaries
─────────────────────────────────────────────────────────────────────────
extensions/{linear,local,memory,jira,slack}-tracker  extensions (tracker providers,
extensions/{docker,fly,e2b,modal}-worker             their tool packs, and worker
packages/static-worker                               drivers)
─────────────────────────────────────────────────────────────────────────
@symphony/config, workflow, runtime,          engine (backend-agnostic)
orchestrator, dispatch, agent-runner, acp,
mcp, worker-pool, server, tui, …
─────────────────────────────────────────────────────────────────────────
@symphony/tracker-sdk, tool-sdk, agent-sdk,   extension SDKs (contracts + registries)
worker-sdk
─────────────────────────────────────────────────────────────────────────
@symphony/domain, issue, policies, …          pure types, constants, leaf logic
```

- **domain** holds pure types and leaf functions shared by everything. It carries no
  backend knowledge: `TrackerKind` is an open string and `TrackerSettings` contains only
  fields every tracker shares, plus an opaque `options` bag owned by the provider.
- **tracker-sdk** defines the `TrackerProvider` contract (dispatch client, config
  ownership, normalized `TrackerToolOps`), the `TrackerRegistry`, option parsing helpers,
  and the provider-neutral `tracker` pack (`createTrackerToolProvider`), which serves the
  `tracker_*` tools for whichever provider drives dispatch. **tool-sdk** defines the `ToolProvider` contract for agent-facing tool packs,
  the `ToolRegistry`, mount/routing helpers, `ToolSpec`/`ToolResult` shapes and result
  helpers, and the read-only query/filter DSL tool implementations reuse. **agent-sdk**
  defines the `AgentExecutorProvider` contract and `AgentExecutorRegistry` for runtime
  drivers behind `agents.<kind>.executor`.
- **extensions** implement those contracts. Each tracker package owns everything about its
  backend: its slice of the selected `trackers.<name>:` config bag (aliases, validation,
  env fallbacks, defaults), the runtime client, its default tool packs and
  `TrackerToolOps`, operator URLs, and its own registration
  (`registerLinearTracker(...)` etc.) - there is no central bundle.
  Static SSH workers live in `packages/static-worker` because that built-in uses the core SSH
  path rather than an external provider boundary.
- **engine** packages never import a provider or pack. They resolve `tracker.kind` through
  a `TrackerRegistry` and tool packs through a `ToolRegistry` (the process-wide defaults
  unless one is injected).
- **composition roots** decide what the binary supports. `apps/cli`'s
  `registerBuiltinBackends()` invokes each built-in extension's registration inside the
  entrypoints; a downstream embedder invokes a different set against its own registries.

## The tracker extension point

`TrackerProvider` (in `@symphony/tracker-sdk`) is the single contract between the core and
a tracker backend:

| Hook | Called by | Purpose |
| --- | --- | --- |
| `kind` | registry | provider selector, matched by `trackers.<name>.provider` or legacy `tracker.kind` |
| `configAliases` | config | snake_case aliases for provider keys |
| `envFallbacks` | config | env vars backing shared fields, keyed by field name |
| `defaultEndpoint` | config | endpoint when `tracker.endpoint` unset |
| `parseOptions` | config | validate/normalize provider keys into `settings.tracker.options` |
| `validateDispatch` | CLI startup | reject undispatchable settings early |
| `createClient` | runtime | the `RuntimeTrackerClient` that feeds dispatch |
| `createToolOps` | neutral tool pack | normalized issue operations behind `tracker_*` tools |
| `defaultToolPacks` | MCP mount | provider-specific packs mounted by default for this tracker |
| `projectUrl` | TUI/dashboard | operator-facing project link |

Provider-specific settings never appear as named fields on `TrackerSettings`. They live in
`settings.tracker.options`, validated once at parse time by `parseOptions` and read through
the provider package's typed accessor (e.g. `linearTrackerOptions(settings)`,
`jiraTrackerOptions(settings)`). Core code must not read `options` keys directly.

Workflow config names the selected tracker bundle with `tracker.kind`; the selected
`trackers.<name>.provider` chooses the registered tracker implementation. The legacy flat
`tracker.kind: <provider>` form remains parseable when no `trackers` map is present. See
the workspace README for user-facing YAML examples.

## The tool extension point

Agent-facing MCP tools are a separate axis from dispatch. `ToolProvider` (in
`@symphony/tool-sdk`) is a named pack of tools: `toolSpecs(settings)` advertises them and
`executeTool` runs one. Packs are registered in a `ToolRegistry` and mounted from the active
tracker plus explicit workflow requests:

- The endpoint mounts the provider-neutral `tracker` pack when it is registered.
- The endpoint also mounts the packs returned by the dispatch tracker's
  `defaultToolPacks` hook. These tracker-owned packs are implicit: a Linear tracker mounts
  Linear tools without requiring a `tools.linear` entry.
- The endpoint mounts any additional packs named in the workflow's `tools:` map.
- A workflow does not mount unrelated registered packs by accident. For example, a Jira
  workflow does not mount Linear or local-board tools unless the workflow explicitly asks
  for those packs.

A mount is one flat tool namespace: name collisions across mounted packs fail loudly at
mount time. A pack that throws surfaces as a failed `ToolResult` (JSON-RPC `isError`),
never as a transport-level error.

A mounted pack can carry its own settings via the top-level `tools:` map, keyed by pack
name and validated by the pack's optional `validateOptions` hook. Explicit cross-mounts
are allowed when the workflow asks for them.

The `tracker` pack (`createTrackerToolProvider` in `@symphony/tracker-sdk`) implements the
five provider-neutral `tracker_*` tools purely against `TrackerToolOps`, so any tracker
whose provider implements `createToolOps` gets read/query/status/comment/create tools
without writing a pack. Provider-specific packs (`linear`, `local`, `slack`) live in their
tracker packages and carry the tools only that backend can offer.

### Adding a tracker backend

1. Create `extensions/<name>-tracker` depending on `@symphony/domain` and
   `@symphony/tracker-sdk` (plus `@symphony/issue` for `normalizeIssue`, and
   `@symphony/tool-sdk` if it ships a tool pack).
2. Implement a `RuntimeTrackerClient` and export a `TrackerProvider` that wires config
   parsing, validation, the client, and `createToolOps` for the neutral tools.
3. Export a `register<Name>Tracker(registries?)` function that registers the provider (and
   any pack) idempotently, and invoke it from `registerBuiltinBackends()` in `apps/cli`.
4. Add the package to the workspace plumbing (`pnpm install`, `pnpm tsconfig:refs --write`).

`test/tracker-extension.test.ts` is the executable form of this recipe: it defines a fake
provider entirely from SDK surface and drives config parsing, dispatch validation, client
creation, and MCP tools through it. If a new backend needs more than the steps above, that
test - and this document - have regressed.

The `extensions-depend-on-sdk-layers-only` dependency-cruiser rule holds the other side of
the bargain: a provider package that reaches into engine packages fails the build.

## The agent extension points

Agents extend along two independent axes:

- **Agent kinds** are pure configuration. `Settings.agents` is an open record; adding a
  backend like a custom bridge is a new `agents.<name>` entry in workflow YAML, no code.
  The legacy top-level `codex:` / `claude:` sections (and the `codex:` / `claude:` blocks
  inside `status_overrides`) are parse-time sugar that merges into the matching `agents`
  records - they do not exist on `Settings` at runtime, and per-state overrides use
  `PartialRuntimeSettings.agents`.
- **Executors** are how an agent record actually runs. `AgentExecutorProvider` (in
  `@symphony/agent-sdk`) is the contract: an `executor` selector (matched against
  `agents.<kind>.executor`), `configAliases` and `parseOptions` for the executor's slice of
  an `agents.<kind>` config record, `validateAgent` for startup validation of records that
  select it, and `createExecutor` producing the `AgentExecutor` the agent-runner drives.
  The built-in `"acp"` executor lives in `@symphony/acp`; the CLI registers it at startup.
  `validateDispatchConfig` rejects records whose executor selector is unregistered, listing
  the known selectors.

`AgentConfig` mirrors `TrackerSettings`: only the fields every executor shares live on the
record (`executor`, the turn/stall timeouts), and everything else sits in an executor-owned
`options` bag, validated at parse time by the provider's `parseOptions` and read through
the executor package's typed accessor (the ACP keys - `bridge_command`, `usage_accounting`,
`provider_config`, `strict_mcp_config` - via `acpAgentOptions(config)`). Core code must not
read `options` keys directly. Records selecting an unregistered executor parse leniently
(options pass through unvalidated) and are rejected at startup, exactly like unknown
`tracker.kind` values.

## The worker driver extension point

The warm worker pool (`@symphony/worker-pool`, an engine package) leases
SSH-addressable machines per run. The machines themselves come from a **worker driver**:
the backend adapter that provisions, probes, destroys, and lists workers for one
infrastructure (a cloud API, a container runtime, a fixed host list). "Driver" is
deliberate - "provider" is reserved for tracker/executor providers and reads as a
model/agent provider.

`WorkerDriver` and `WorkerDriverFactory` (in `@symphony/worker-sdk`) are the contract:

| Hook | Called by | Purpose |
| --- | --- | --- |
| `kind` | registry | `workers.<name>.driver` selector |
| `create(options, deps)` | pool construction / driver swap | build the driver from selected `workers.<name>` options, validating options fail-loud |
| `provision` | pool grow / warm top-up | create (or re-adopt, idempotent on `workerId`) one worker |
| `probe` | pool readiness gate, reaper health pass | cheap reachability check |
| `destroy` | reaper / recycle / drain | tear one worker down (idempotent, tolerant of already-gone) |
| `list` | hydrate re-adoption, reaper reconcile | the backend's authoritative inventory |
| `capabilities` | pool | `sshAddressable` / `ephemeral` / `usesLedger` gates |

Drivers never see the pool's lifecycle state and never import engine packages: SSH
access arrives through `DriverDeps.runSsh` (injected by the pool, which owns the real
`@symphony/ssh` dependency), and options arrive verbatim from the selected
top-level `workers.<name>` profile, excluding its `driver`. The pool owns leasing, reaping, spend caps, the
write-ahead ledger, and crash recovery; every driver gets them for free.

The `fake` driver ships inside `@symphony/worker-sdk` as the reference implementation and
the test double the engine suites lease against. The conformance kit
(`@symphony/worker-sdk/conformance`, `runDriverConformanceSuite`) pins the contract every
driver must satisfy: provision idempotency, destroy tolerance, list-as-truth,
pool-owned label round-trip, and probe gating.

### Adding a worker driver

1. Create `extensions/<name>-worker` depending on `@symphony/worker-sdk` (plus
   `@symphony/domain` if it needs domain types).
2. Implement `WorkerDriver` and export a `WorkerDriverFactory` whose `create` validates
   the selected `workers.<name>` options and throws an actionable error when they are unusable.
3. Export a `register<Name>WorkerDriver(registries?)` function that registers the factory
   idempotently, and invoke it from `registerBuiltinBackends()` in `apps/cli`. A driver
   needing an injected transport the binary does not ship (e.g. a cloud SDK client)
   registers a fail-loud factory by default and accepts the transport as a second
   argument for configured deployments.
4. Run `runDriverConformanceSuite` from `@symphony/worker-sdk/conformance` in the
   extension's test suite.
5. Add the package to the workspace plumbing (`pnpm install`, `pnpm tsconfig:refs --write`).

A driver can also ship **out of tree**, without forking the repo:
`workers.<name>.driver` accepts a module specifier (an npm package name,
`@scope/name`, a `./relative` or `/absolute` path, with an optional
`#exportName` suffix) that the daemon dynamic-imports at startup - and on a
reload that changes the specifier - and registers into the worker-driver registry.
The module exports `defineWorkerDriver({ kind, sdkVersion, create })` from
`@symphony/worker-sdk`; the loader shape-checks it and rejects an `sdkVersion`
other than `WORKER_DRIVER_SDK_VERSION` before it can reach the pool. Trust: a
dynamic import runs arbitrary code in the daemon process - the same trust
boundary as workspace hooks, which already execute arbitrary shell from the
workflow file. Loads happen only at startup and reload, never on the acquire
path, and a `worker_pool_driver_loaded` audit event records exactly which module
went live from where. Module code is pinned for the daemon lifetime (Node
never unloads modules): changing driver code requires a daemon restart, while
changing the config to a different specifier hot-loads the new module, and a
reload that re-encounters a loaded specifier emits
`worker_pool_driver_module_pinned`.

## Composition and the default registries

`defaultTrackerRegistry`, `defaultToolRegistry`, and `defaultAgentExecutorRegistry` are
process-wide registries used as defaults by `parseConfig`, `validateDispatchConfig`, the
MCP server, and the CLI's executor factory. Library code only reads from them, and no
package registers into them as an import side effect: the CLI entrypoints call
`registerBuiltinBackends()` at the top of their function bodies, before any config is
parsed, so behavior never depends on module import order. Every entry point that needs
isolation (tests, embedders) constructs private registries and passes them explicitly -
all registry consumers accept them as parameters (`loadWorkflow` forwards a registry to
`parseConfig` via its `trackers` option).

## Enforcement

The layering is checked mechanically, not just documented. `.dependency-cruiser.cjs`
(run as `pnpm architecture:check`, part of `mise run check`) validates the real import
graph of every source file against the layer rules above, plus the file-level rules no
other gate covers: no circular imports, cross-package imports only through a package's
published surface (its `exports` map), and no package importing an app. An engine package
that imports a tracker provider fails CI. Extension membership is by directory: anything
under `extensions/` gets the extension rules by construction, and the engine (all of
`packages/`) may never import from it.

`pnpm architecture:graph` renders the same graph as Mermaid for inspection.

Two neighbouring gates close the remaining gaps: pnpm's strict `node_modules` plus
`scripts/sync-tsconfig-refs.ts` keep undeclared package.json dependencies unbuildable,
and knip flags dependencies that are declared but unused.

## Conventions that keep the boundary clean

- The engine never imports a tracker package or tool pack; `pnpm architecture:check`
  enforces it structurally.
- A provider package is self-contained: config knowledge, client, tool pack, and ops live
  together, and its tests live with it.
- Secrets resolution (`$VAR`, `op://`, env fallbacks) is core config machinery; providers
  only declare *which* env vars back their credentials.
- Tool failures are data (`ToolResult` with `isError`), never thrown across the MCP seam.
- The built-in set is declared in exactly one place: the composition root's
  `registerBuiltinBackends()`.
