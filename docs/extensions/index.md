# Extensions

Lorenz extends through four contracts, one per backend kind: a tracker, a tool pack, an agent executor, or a worker driver. This page is the map for an extension author. It names the four extension points, the registry pattern they share, the single line that wires a builtin in, and the directory rule that keeps your code off the engine. Each builder page that follows is the step-by-step recipe for one contract.

The thesis the codebase enforces: a new backend is one package plus one registration line. No engine package changes, no switch statement to edit. You implement an interface, register it at the composition root, and the core resolves it through a registry.

## The four extension points

Each contract lives in its own SDK package under `packages/`. You implement one interface and, for some kinds, a small registry-registration helper.

| Extension point | SDK package | Interface | Selected by config key |
| --- | --- | --- | --- |
| Tracker | `@lorenz/tracker-sdk` | `TrackerProvider` | `tracker.kind` / `trackers.<name>.provider` |
| Tool pack | `@lorenz/tool-sdk` | `ToolProvider` | `tools.<pack>` |
| Agent executor | `@lorenz/agent-sdk` | `AgentExecutorProvider` | `agents.<kind>.executor` |
| Worker driver | `@lorenz/worker-sdk` | `WorkerDriverFactory` | `worker.worker_pool.driver` |

All four sit on top of `@lorenz/domain`, the dependency-free vocabulary. Domain owns the pure types every layer shares: `Issue`, `Settings`, `AgentConfig`, `TrackerSettings`, the `ClockPort`, the bounds constants and validators, and the executor runtime contracts `AgentExecutor`, `AgentSession`, and `AgentUpdate`. The selector aliases `TrackerKind`, `AgentKind`, and `WorkerDriverKind` are plain `string` types, not closed unions. The supported set is whatever the composition root registered, decided at runtime, not at the type level.

<p align="center"><img src="../assets/diagrams/extension-points.svg" alt="extension points diagram" width="920" style="width:100%;max-width:920px;height:auto" /></p>
*The vocabulary in `@lorenz/domain` flows up through the four SDKs, which extensions implement; the composition root registers them and the engine reads only through the registries, with a dependency-cruiser barrier blocking extensions from reaching into engine packages.*

### TrackerProvider

A `TrackerProvider` (`packages/tracker-sdk/src/provider.ts`) connects Lorenz to an issue tracker. The only mandatory members are `kind` (the string selector) and `createClient(settings, ctx)`. The optional hooks cover the rest of the lifecycle: `configAliases`, `envFallbacks`, and `defaultEndpoint` shape config parsing; `parseOptions(options, ctx)` validates the provider-specific `tracker.options.*`; `validateDispatch(settings)` runs once at startup; `createToolOps(settings, ctx)` and `defaultToolPacks(settings)` wire the tracker into the MCP tool surface; `projectUrl(settings)` feeds the UI.

The tracker tools your provider can back are normalized through `TrackerToolOps`, an all-optional interface: `readIssue`, `queryIssues`, `queryRows`, `updateStatus`, `listComments`, `addComment`, `updateComment`, `createIssue`. A missing member makes the corresponding tracker tool report itself unavailable rather than fail mid-call. See [tracker-provider.md](tracker-provider.md).

### ToolProvider

A `ToolProvider` (`packages/tool-sdk/src/provider.ts`) adds a named pack of MCP tools an agent can call. The required members are `name` (a string), `toolSpecs(settings)` returning the advertised `ToolSpec[]`, and `executeTool(name, input, context)` returning a `ToolResult`. Optional members are `skills` (absolute skill directories overlaid into the workspace when the pack is mounted) and `validateOptions(options)`. The `ToolContext` passed to `executeTool` is exactly `{ settings, fetchImpl }`.

Build results with `toolSuccess`, `toolFailure`, and `unsupportedToolFailure` from `packages/tool-sdk/src/result.ts`. The side-effect-free query and filter DSL in `packages/tool-sdk/src/filter.ts` gives you `parseFilter`, `applyQuery`, `parseQuerySpec`, `parseSelect`, and `pickFields` for in-memory projection. See [tool-pack.md](tool-pack.md).

### AgentExecutorProvider

An `AgentExecutorProvider` (`packages/agent-sdk/src/provider.ts`) owns one way of running agents behind a value of `agents.<kind>.executor`. The required member is `createExecutor(kind, settings)`, which may return an `AgentExecutor` synchronously or as a `Promise<AgentExecutor>`. The optional members are `configAliases`, `parseOptions(options, { env, resolveSecret })`, and `validateAgent(kind, config, settings)`.

The runtime contract the executor satisfies, `AgentExecutor` with `startSession` and `runTurn`, lives in `@lorenz/domain`, not in `agent-sdk`. The SDK package owns only the build-time provider and registry. See [agent-executor.md](agent-executor.md).

### WorkerDriverFactory

A `WorkerDriverFactory` (`packages/worker-sdk/src/types.ts`) produces a `WorkerDriver` that the warm worker pool uses to place agents on remote machines. The factory has `kind` and `create(options, deps)`. The driver it returns implements four operations the pool calls and nothing else: `provision(req)`, `probe(worker, opts)`, `destroy(worker, opts)`, and `list()`, plus a `capabilities` record `{ sshAddressable, ephemeral, usesLedger }`.

Worker drivers can ship inside the repo or load from an out-of-tree module. The out-of-tree path uses a version handshake (`WORKER_DRIVER_SDK_VERSION`, currently `1`) checked by `assertWorkerDriverModule` before the module reaches the registry. See [worker-driver.md](worker-driver.md) and [out-of-tree.md](out-of-tree.md).

## The registry pattern

Every extension point resolves through a registry with the same shape. Each registry exposes `register`, `get`, `require`, and an accessor for the registered keys (`kinds()` for trackers and worker drivers, `names()` for tool packs, `executors()` for agent executors), and each ships a process-wide default singleton: `defaultTrackerRegistry`, `defaultToolRegistry`, `defaultAgentExecutorRegistry`, `defaultWorkerDriverRegistry`.

The contract these registries hold:

- `register(x)` is idempotent for the same instance. Registering the same provider twice is a no-op.
- `register(x)` throws when a different instance claims a key already taken, for example `tracker provider already registered for kind: <kind>`.
- A blank key throws, with the message naming that registry's selector: `tracker provider kind must not be blank`, `worker driver kind must not be blank`, `tool provider name must not be blank`, or `agent executor selector must not be blank`.
- `require(key)` throws a config-style error naming the known keys when the key is missing or unregistered, for example `tracker.kind is required` or `unsupported tracker.kind: <k> (known kinds: ...)`. The worker registry uses `worker_pool_driver_unavailable: <kind>` instead.
- The key accessor returns a sorted array.

Library code, the config parser, the MCP server, the agent runner, and the pool only read from these registries. They never hardcode a backend. A call site that needs isolation constructs its own registry and passes it explicitly, which is how the tests stay independent.

## The one wiring point

Builtins are registered in exactly one function: `registerBuiltinBackends()` in `apps/cli/src/daemon.ts`. This is the composition root, the only place backend identity is hardcoded.

```ts
export function registerBuiltinBackends(registries: BackendRegistries = {}): void {
  const trackers = registries.trackers ?? defaultTrackerRegistry;
  const tools = registries.tools ?? defaultToolRegistry;
  const executors = registries.executors ?? defaultAgentExecutorRegistry;

  registerLinearTracker({ trackers, tools });
  registerLocalTracker({ trackers, tools });
  registerMemoryTracker({ trackers });
  registerJiraTrackers({ trackers });
  registerSlackTracker({ trackers, tools });
  if (tools.get("tracker") === undefined) {
    tools.register(createTrackerToolProvider(trackers));
  }
  if (executors.get(acpExecutorProvider.executor) === undefined) {
    executors.register(acpExecutorProvider);
  }

  const workerDrivers = registries.workerDrivers ?? defaultWorkerDriverRegistry;
  registerFakeWorkerDriver({ workerDrivers });
  registerStaticSshWorkerDriver({ workerDrivers });
  registerDockerWorkerDriver({ workerDrivers });
}
```

Your new backend follows the same pattern: one `register*` call here. That is the "one registration line" half of the thesis. The function is idempotent, so calling it more than once is safe.

The neutral `tracker` tool pack is registered here through `createTrackerToolProvider(trackers)`. It advertises the seven provider-neutral tools `tracker_read_issue`, `tracker_query`, `tracker_update_status`, `tracker_list_comments`, `tracker_comment`, `tracker_update_comment`, and `tracker_create_issue`, over whatever `TrackerToolOps` the active tracker exposes. When the active tracker has no `createToolOps`, the pack advertises no tools.

## The directory rule

Extensions live under the top-level `extensions/` directory: `linear-tracker`, `jira-tracker`, `local-tracker`, `memory-tracker`, `slack-tracker`, and `docker-worker`. The SDKs and engine live under `packages/`. The one exception worth knowing: the static-SSH driver ships as `static-worker` under `packages/`, not `extensions/`.

A dependency-cruiser rule, `extensions-depend-on-sdk-layers-only` in `.dependency-cruiser.cjs`, blocks any module under `extensions/` from importing an engine package. The comment states the intent: a provider or tool pack must be implementable from the SDK surface alone, so the extension never couples to the core it extends. A companion rule, `engine-must-not-import-extensions`, keeps the dependency arrow pointing one way. If your extension needs something only the engine has, that is a sign the SDK contract should grow, not that you should reach past the barrier.

## Conformance kits and reference fakes

The worker SDK ships a shared conformance suite and a reference driver, so a new driver proves its contract with a few lines of test wiring.

- `runDriverConformanceSuite(options)` (`packages/worker-sdk/src/conformance.ts`) is a vitest suite that pins the four-rule worker contract: `provision` is idempotent on `workerId`; `destroy` is idempotent and tolerant of an already-gone worker; `list()` reflects provisioned minus destroyed; and `probe` of a created-but-unreachable worker returns `{ ok: false, reason }`. Ephemeral drivers must surface `POOL_OWNED_LABEL` (`lorenz.pool=worker-pool`) on every `list()` descriptor. It is exported from the `@lorenz/worker-sdk/conformance` subpath. The file lives under `src/` deliberately, so it compiles to `dist/` and each driver's own test can import it.
- `FakeWorkerDriver` (`packages/worker-sdk/src/fake.ts`) is the reference in-memory driver, `kind` `"fake"`, with all capabilities false and per-worker failure-injection hooks. It ships in the SDK, registered via `registerFakeWorkerDriver`, and is the template to read before writing a real driver.

The other SDKs document their contracts through package tests, for example `packages/tracker-sdk/test/registry.test.ts` and `packages/tracker-sdk/test/tool-pack.test.ts`. Read those alongside the builder page for the kind you are adding.

## Pick a builder page

Each page is the complete recipe for one extension point: the interface members, the hook lifecycle, the registration helper, and a worked example.

- [tracker-provider.md](tracker-provider.md) - connect a new issue tracker.
- [tool-pack.md](tool-pack.md) - add a named pack of MCP tools.
- [agent-executor.md](agent-executor.md) - add a new way to run agents.
- [worker-driver.md](worker-driver.md) - place agents on a new kind of machine.
- [out-of-tree.md](out-of-tree.md) - ship a worker driver as a standalone module with the version handshake.

## See also
- [../architecture.md](../architecture.md) - how the SDK, engine, and extension layers fit together.
- [../source-map.md](../source-map.md) - where each package and extension lives in the tree.
- [../reference/configuration.md](../reference/configuration.md) - the config keys that select each backend.
- [../workers/index.md](../workers/index.md) - the worker pool that drives `WorkerDriver`.
- [../trackers/index.md](../trackers/index.md) - the trackers built on `TrackerProvider`.
