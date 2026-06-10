# Architecture

This workspace is organized as a small provider-agnostic core plus self-contained extension
packages. The measure of cohesion we hold it to: adding a new backend (a tracker, and over
time an agent executor) is one new package plus one registration line at the composition
root - never a sweep through domain, config, MCP, and CLI code.

## Layers

Dependencies point strictly downward. A package may import from its own layer or below,
never from above.

```
apps/cli, apps/traceviz                       composition roots / binaries
─────────────────────────────────────────────────────────────────────────
@symphony/trackers                            built-in extension bundle
@symphony/linear-tracker, local-tracker,      extensions (tracker providers)
@symphony/memory-tracker
─────────────────────────────────────────────────────────────────────────
@symphony/config, workflow, runtime,          engine (provider-agnostic)
orchestrator, dispatch, agent-runner, acp,
mcp, server, tui, presenter, projections, …
─────────────────────────────────────────────────────────────────────────
@symphony/tracker-sdk, @symphony/agent-sdk    extension SDKs (contracts + registries)
─────────────────────────────────────────────────────────────────────────
@symphony/domain, ports, issue, policies, …   pure types, constants, leaf logic
```

- **domain** holds pure types and leaf functions shared by everything. It carries no
  backend knowledge: `TrackerKind` is an open string and `TrackerSettings` contains only
  fields every tracker shares, plus an opaque `options` bag owned by the provider.
- **tracker-sdk** defines the `TrackerProvider` contract, the `TrackerRegistry`, the MCP
  `ToolSpec`/`ToolResult` shapes and result helpers, option parsing helpers, and the
  read-only query/filter DSL providers can reuse for query tools. **agent-sdk** defines the
  `AgentExecutorProvider` contract and `AgentExecutorRegistry` for runtime drivers behind
  `agents.<kind>.executor`.
- **extensions** implement `TrackerProvider`. Each provider package owns everything about
  its backend: its slice of the `tracker:` config section (aliases, validation, env
  fallbacks, defaults), the runtime client, the agent-facing MCP tools, and operator URLs.
- **engine** packages never import a provider. They resolve `tracker.kind` through a
  `TrackerRegistry` (the process-wide `defaultTrackerRegistry` unless one is injected).
- **composition roots** decide what the binary supports. `apps/cli` calls
  `registerBuiltinTrackerProviders()` from `@symphony/trackers`; a downstream embedder can
  register a different set against its own registry.

## The tracker extension point

`TrackerProvider` (in `@symphony/tracker-sdk`) is the single contract between the core and
a tracker backend:

| Hook | Called by | Purpose |
| --- | --- | --- |
| `kind` | registry | `tracker.kind` selector |
| `configAliases` | config | snake_case aliases for provider keys |
| `envFallbacks` | config | env vars backing `api_key` / `assignee` |
| `defaultEndpoint` | config | endpoint when `tracker.endpoint` unset |
| `parseOptions` | config | validate/normalize provider keys into `settings.tracker.options` |
| `validateDispatch` | CLI startup | reject undispatchable settings early |
| `createClient` | runtime | the `RuntimeTrackerClient` that feeds dispatch |
| `toolSpecs` / `executeTool` | MCP server | agent-facing tools for sessions |
| `projectUrl` | TUI/dashboard | operator-facing project link |

Provider-specific settings never appear as named fields on `TrackerSettings`. They live in
`settings.tracker.options`, validated once at parse time by `parseOptions` and read through
the provider package's typed accessor (e.g. `linearTrackerOptions(settings)`). Core code
must not read `options` keys directly.

Unknown `tracker.kind` values parse leniently (options pass through unvalidated) and are
rejected by `validateDispatchConfig` with the list of registered kinds. This keeps config
parsing usable in tests and tools that don't register providers, while the CLI still fails
fast at startup.

### Adding a tracker backend

1. Create `packages/<name>-tracker` depending on `@symphony/domain` and
   `@symphony/tracker-sdk` (plus `@symphony/issue` for `normalizeIssue`).
2. Implement a `RuntimeTrackerClient` and export a `TrackerProvider` that wires config
   parsing, validation, the client, and any agent tools.
3. Register it: add the provider to `builtinTrackerProviders` in `packages/trackers`.
4. Add the package to the workspace plumbing (`pnpm install`, `pnpm tsconfig:refs --write`).

`test/tracker-extension.test.ts` is the executable form of this recipe: it defines a fake
provider entirely from SDK surface and drives config parsing, dispatch validation, client
creation, and MCP tools through it. If a new backend needs more than the steps above, that
test - and this document - have regressed.

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
  `agents.<kind>.executor`), `validateAgent` for startup validation of records that select
  it, and `createExecutor` producing the `AgentExecutor` the agent-runner drives. The
  built-in `"acp"` executor lives in `@symphony/acp`; the CLI registers it at startup.
  `validateDispatchConfig` rejects records whose executor selector is unregistered, listing
  the known selectors.

The `AgentConfig` record shape is currently ACP-flavored (`bridgeCommand`,
`usageAccounting`, ...). Generalizing it into an executor-owned options bag - mirroring
`TrackerSettings.options` - is the designated next step if a second executor lands.

## Composition and the default registry

`defaultTrackerRegistry` and `defaultAgentExecutorRegistry` are process-wide registries
used as defaults by `parseConfig`, `validateDispatchConfig`, the MCP server's
`toolSpecs`/`executeTool`, and the CLI's executor factory. Library code only reads from
them; registration happens once at the composition root. Every entry point that needs
isolation (tests, embedders) can construct private registries and pass them explicitly -
all registry consumers accept them as parameters.

## Enforcement

The layering is checked mechanically, not just documented: `scripts/check-architecture.ts`
(run as `pnpm architecture:check`, part of `mise run check`) classifies every workspace
package into a layer from its name and validates the `package.json` dependency graph
against the rules above. An engine package that imports a tracker provider fails CI.

## Conventions that keep the boundary clean

- The engine never imports a tracker package; `scripts/check-architecture.ts` enforces it
  structurally.
- A provider package is self-contained: config knowledge, client, and tools live together,
  and its tests live with it.
- Secrets resolution (`$VAR`, `op://`, env fallbacks) is core config machinery; providers
  only declare *which* env vars back their credentials.
- `@symphony/trackers` exists so the built-in set is declared in exactly one place.
