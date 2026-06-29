# Tool packs

A tool pack is a named bundle of agent-facing tools that Lorenz mounts onto the MCP endpoint an
agent session calls. This page is for extension authors building one: the `ToolProvider` contract,
the `ToolSpec`/`ToolResult` shapes, the failure-as-data rule, how packs are selected and flattened,
and the read-only query DSL the SDK ships for read tools.

A tool pack is distinct from a tracker provider. A `ToolProvider` (in `@lorenz/tool-sdk`) declares
tools an agent can call. A `TrackerProvider` (in `@lorenz/tracker-sdk`) is the dispatch backend.
A tracker extension package usually ships both and wires them together with `defaultToolPacks`.
For the tracker side, see [tracker-provider.md](tracker-provider.md).

## The ToolProvider contract

A pack implements one interface, `ToolProvider`, defined in
`packages/tool-sdk/src/provider.ts`:

```ts
interface ToolProvider {
  readonly name: string;
  readonly skills?: readonly string[];
  validateOptions?(options: Record<string, unknown>): void;
  toolSpecs(settings: Settings): ToolSpec[];
  executeTool(name: string, input: unknown, context: ToolContext): Promise<ToolResult>;
}
```

| Member | Required | Meaning |
| --- | --- | --- |
| `name` | yes | The pack's mount name. Tracker providers name it in `defaultToolPacks`, and a workflow names it as a key under `tools:`. Registering blank throws `tool provider name must not be blank`. |
| `skills` | no | Absolute skill directories this pack bundles. When the pack mounts, the composition root overlays them into the workspace's skills directory alongside `agent.skills`, so enabling a tool ships the skill that documents it. |
| `validateOptions` | no | Validate this pack's per-pack config slice. Called once at startup by `validateDispatchConfig`. Throw with a `tools.<pack>.<key> ...` message on unknown keys or bad values. |
| `toolSpecs` | yes | The tools this pack advertises for the given settings. May return `[]`. |
| `executeTool` | yes | Run one tool the pack declared. Returns a `Promise<ToolResult>`. |

`executeTool` receives a `ToolContext` of two fields:

```ts
interface ToolContext {
  settings: Settings;
  fetchImpl: typeof fetch;
}
```

Use `context.fetchImpl` for any HTTP call rather than the global `fetch`. There is no `env` field on
`ToolContext`; read environment-derived configuration from `context.settings`.

## ToolSpec and ToolResult

`toolSpecs` returns `ToolSpec` declarations. Each is a JSON-Schema-shaped tool the agent sees in a
`tools/list` response:

```ts
interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
```

`executeTool` returns a `ToolResult`:

```ts
interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}
```

`result` reaches the agent verbatim. `error` is a human-readable summary, set when `success` is
`false`. Build results with the helpers in `packages/tool-sdk/src/result.ts` instead of
constructing the object by hand:

| Helper | Produces |
| --- | --- |
| `toolSuccess(result)` | `{ success: true, result }`. |
| `toolFailure(message, details?)` | `{ success: false, error: message, result: { error: { message, ...details } } }`. |
| `unsupportedToolFailure(name, supportedTools)` | A `toolFailure` with message `Unsupported tool: "<name>".` and a `supportedTools` array in the details. |

## Failure is data, never an exception

A tool failure is a value, not a thrown error. Return `toolFailure(...)` (or any `ToolResult` with
`success: false`); do not throw across the MCP seam. The MCP server maps `success: false` to a
JSON-RPC `isError: true` result, which is still an HTTP 200 response, not a transport error. The
agent reads the failure as a normal tool output and can react to it.

The router gives you a safety net, but do not lean on it. `executeMountedTool` wraps your
`executeTool` in a `try`/`catch`; a throw becomes `toolFailure(errorMessage(error))` with
`success: false`. Returning a structured `ToolResult` yourself produces a clearer `result` payload
than a bare caught message. The shipped packs follow this. The `local` pack validates arguments with
a `requireStr` helper that throws `'<key>' is required`, catches it at the top of
`executeLocalTool`, and returns `toolFailure(errorMessage(error))`.

## How packs mount

Packs live in a `ToolRegistry` keyed by pack name. The composition root in
`apps/cli/src/daemon.ts` (`registerBuiltinBackends`) registers the builtins into the process-wide
`defaultToolRegistry`; `register()` rejects a blank name and throws
`tool provider already registered for name: <name>` if a different instance claims a name already
taken.

For a given workflow's settings, `mountedPackNames` in `packages/mcp/src/tools.ts` selects which
packs mount, in this order, de-duplicated by a `Set` (first-seen wins):

1. The dispatch tracker's `defaultToolPacks(settings)`, if the active `TrackerProvider` defines it.
   When it is undefined, a fallback mounts a pack whose name equals `tracker.kind`, if such a pack
   is registered.
2. Every key of the workflow's `tools:` map (parsed into `settings.toolOptions`).

<p align="center"><img src="../assets/diagrams/mcp-tool-mounting.svg" alt="mcp tool mounting diagram" width="880" style="width:100%;max-width:880px;height:auto" /></p>
*Pack selection: the dispatch tracker's default packs and the workflow `tools:` keys are unioned, then flattened into one tool namespace with a collision check.*

The shipping trackers all declare `defaultToolPacks`, so the kind-name fallback rarely fires:
`jira` and `jira-mcp` mount `['jira']`, `linear` mounts `['linear']`, `local` mounts `['local']`,
`slack` mounts `['slack']`.

### Flat namespace, collisions fail loud

The mounted packs flatten into one tool namespace. `mountedToolSpecs` walks the packs and throws at
mount time if two different packs declare the same tool name:

```text
tool name collision: <name> is declared by both the "<a>" and "<b>" packs
```

A pack re-declaring its own tool name is allowed; the owner check is by `pack.name`. Name your
tools with a pack-specific prefix (the shipped packs use `local_*`, `linear_*`, `slack_*`,
`jira_*`) so two enabled packs never clash.

At call time, `executeMountedTool` routes a `tools/call` to the first pack whose `toolSpecs`
contains the name. An unknown name returns `unsupportedToolFailure(name, ...)` listing every
mounted tool name.

### Per-pack settings via `tools.<pack>`

A workflow turns on an extra pack and configures it through the `tools:` map in `WORKFLOW.md`. Each
key is a registered pack name, and its value is that pack's option slice:

```yaml
tools:
  local:
    path: ./board
```

`tools: { local: { path } }` mounts the `local` pack and hands `{ path }` to its
`validateOptions`. At startup `validateDispatchConfig` iterates `settings.toolOptions`: for each
pack it requires the pack is registered (an unknown pack throws
`unsupported tool pack: <name>`), then calls the pack's `validateOptions`. If a pack has no
`validateOptions` but you gave it non-empty options, it throws
`tools.<pack> is not supported by the "<pack>" pack`. An empty or absent `tools:` map leaves
`settings.toolOptions` undefined.

## The read-only query DSL

`@lorenz/tool-sdk` ships a side-effect-free query DSL (`packages/tool-sdk/src/filter.ts`) for read
tools that filter, project, sort, and page in-memory records. It is the composable analog of a
read-only GraphQL query: a query never mutates the backend, so it carries no trust-boundary or
atomicity risk. The DSL is total. No regex, no `eval`, no JSONPath.

| Function | Purpose |
| --- | --- |
| `parseFilter(input)` | Validate untrusted agent input into a typed `Filter`, rebuilding each node so stray properties cannot survive. |
| `matchesFilter(record, filter)` | Evaluate a validated `Filter` against one record. |
| `parseQuerySpec(args)` | Parse the shared `where` / `order_by` / `limit` / `offset` envelope into a `QuerySpec`. |
| `applyQuery(records, spec)` | Filter, stably sort, then page; returns `{ rows, total }` where `total` is the pre-page count. |
| `parseSelect(input)` | Validate an optional `select` projection: an array of field-name strings, or `undefined`. |
| `pickFields(record, fields)` | Project a record to the named fields, dropping any the record lacks. |

A `Filter` is a predicate or a combinator:

```text
Filter = Predicate | { and: Filter[] } | { or: Filter[] } | { not: Filter }
```

Predicate ops: `eq`, `ne`, `lt`, `lte`, `gt`, `gte` (scalar); `in`, `nin` (scalar array);
`contains` (string, optional `ci` for case-insensitive); `exists` (boolean). An absent field makes
every predicate false except `exists: false`. `compare` orders only number-vs-number and
string-vs-string; mixed types are incomparable.

The DSL is bounded so a hostile or runaway filter cannot exhaust the process:

| Constant | Value |
| --- | --- |
| `MAX_FILTER_DEPTH` | 12 |
| `MAX_FILTER_NODES` | 200 |
| `DEFAULT_LIMIT` | 100 |
| `MAX_LIMIT` | 1000 (the requested `limit` is clamped to this) |

`parseSelect` only chooses fields; the calling tool decides the default projection when `select` is
omitted. The `local` pack uses `["id", "title", "state", "stateType", "labels"]`. The jira
extension's `jira` pack defines `DEFAULT_SELECT` in `extensions/jira-tracker/src/tools.ts`, and
its `jira_query` uses `["id", "identifier", "title", "state", "stateType", "labels", "url"]`.

## A minimal pack

A pack is one object plus `toolSpecs` and `executeTool`. This `echo` pack declares one tool and
echoes its argument back:

```ts
import {
  toolFailure,
  toolSuccess,
  type ToolProvider,
  type ToolResult,
  type ToolSpec,
} from "@lorenz/tool-sdk";
import { isRecord } from "@lorenz/domain";

function echoSpecs(): ToolSpec[] {
  return [
    {
      name: "echo_say",
      description: "Return the given message unchanged. Args: message.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
  ];
}

export const echoToolProvider: ToolProvider = {
  name: "echo",
  toolSpecs: () => echoSpecs(),
  async executeTool(name, input, _context): Promise<ToolResult> {
    if (name !== "echo_say") return toolFailure(`unknown tool: ${name}`);
    const args = isRecord(input) ? input : {};
    if (typeof args.message !== "string") return toolFailure("'message' is required");
    return toolSuccess({ message: args.message });
  },
};
```

Register it at the composition root next to the builtin packs:

```ts
defaultToolRegistry.register(echoToolProvider);
```

A workflow then enables it through the `tools:` map:

```yaml
tools:
  echo: {}
```

`echo` declares no `validateOptions`, so passing it non-empty options throws
`tools.echo is not supported by the "echo" pack` at startup. Add `validateOptions` once the pack
takes configuration.

For the seven `jira_*` tools the jira extension's `jira` pack ships
(`extensions/jira-tracker/src/tools.ts`) and their argument shapes, see
[reference/tracker-tools.md](../reference/tracker-tools.md).

## See also

- [tracker-provider.md](tracker-provider.md) - the dispatch-backend contract a tool pack usually ships alongside
- [reference/tracker-tools.md](../reference/tracker-tools.md) - the seven `jira_*` tools the jira `jira` pack ships and their inputs
- [extensions/index.md](index.md) - the four extension contracts and where they register
- [reference/http-api.md](../reference/http-api.md) - the `POST /mcp` JSON-RPC endpoint that serves mounted tools
- [agents/claude.md](../agents/claude.md) - how Claude sessions consume the mounted tool surface
