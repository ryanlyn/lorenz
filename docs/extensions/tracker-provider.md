# Tracker provider

This page is the build recipe for a new tracker backend. It is for an extension author wiring Lorenz
to an issue source the engine does not yet speak to. A tracker backend is one package that implements
the `TrackerProvider` contract from `@lorenz/tracker-sdk` and one line that registers it. The core
(config parsing, the dispatch loop, the MCP server, the CLI) is provider-agnostic and reaches every
backend through a registry, so a new tracker needs no core changes.

The [linear](../trackers/linear.md) and [jira](../trackers/jira.md) trackers are the worked examples;
`extensions/linear-tracker/` is the most complete reference. `test/tracker-extension.test.ts` is the
executable form of this recipe: it builds a fake `notion` provider from SDK surface alone and drives
config parsing, dispatch validation, and client creation through it. If a new backend
needs more than the steps below to keep that test green, the provider boundary has regressed.

## The `TrackerProvider` hook table

`TrackerProvider` lives in `packages/tracker-sdk/src/provider.ts`. Only `kind` and `createClient` are
mandatory; every other hook is optional and the core degrades cleanly when it is absent.

| Hook | Called by | Purpose |
| --- | --- | --- |
| `kind` | `TrackerRegistry` | the provider selector matched against `tracker.kind` (e.g. `"linear"`, `"jira"`); the registry key |
| `configAliases` | config parse | snake_case to camelCase alias map for this provider's option keys (e.g. `{ project_slug: "projectSlug" }`); applied before `parseOptions` |
| `envFallbacks` | config parse | env vars consulted for shared `tracker:` fields left unset, keyed by field name (e.g. `{ apiKey: "LINEAR_API_KEY" }`) |
| `defaultEndpoint` | config parse | endpoint used when `tracker.endpoint` is unset (e.g. `https://api.linear.app/graphql`) |
| `parseOptions(options, context)` | config parse | validate and normalize the provider's keys (aliases already applied); the returned record becomes `settings.tracker.options`; throw `tracker.<key> ...` on bad input |
| `validateDispatch(settings)` | CLI startup (`validateDispatchConfig`) | throw when parsed settings cannot drive dispatch (missing credentials or required options) |
| `createClient(settings, context)` | runtime | build the `RuntimeTrackerClient` that feeds candidate issues into the dispatch loop |
| `defaultToolPacks(settings)` | MCP mount | names of the registered `ToolProvider` packs this tracker owns and mounts by default when it drives dispatch; omit it and a registered pack whose name equals `tracker.kind` is mounted as a fallback |
| `projectUrl(settings)` | TUI / dashboard | operator-facing URL of the tracked project |

`TrackerContext` (`parseOptions`, `createClient`) carries `env: NodeJS.ProcessEnv` and, at parse time
only, `resolveSecret(value, fallbackEnvVar?)` for `$VAR` and `op://` references.

The hooks fire in distinct phases. At config-parse time, `configAliases` and `envFallbacks` rewrite
the raw bundle, then `parseOptions` validates it into `settings.tracker.options`. At startup,
`validateDispatch` runs once to reject undispatchable settings before the loop starts. At runtime,
`createClient` produces the polling client. When the MCP server mounts tools, `defaultToolPacks`
decides the agent-facing surface. `projectUrl` is read by the dashboards.

## The `RuntimeTrackerClient` contract

`createClient` returns a `RuntimeTrackerClient`, defined in `packages/domain/src/index.ts`. This is
the minimum the dispatch loop needs from any backend, small enough that the in-process memory tracker
can stand in for a real one.

```ts
interface RuntimeTrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByIds(ids: string[]): Promise<Issue[]>;
  fetchIssuesByStates?(states: string[]): Promise<Issue[]>;
}
```

- `fetchCandidateIssues()` returns issues currently eligible for dispatch: those whose state is in
  `tracker.active_states`, filtered by the configured assignee where the backend supports it. The
  runtime applies routing labels, blockers, and concurrency caps afterward; the client does not.
- `fetchIssuesByIds(ids)` re-fetches specific issues by tracker id and preserves the requested order.
  The runtime calls this to refresh an issue it already knows.
- `fetchIssuesByStates(states)` is optional. It backs best-effort flows, notably terminal-state
  workspace cleanup at startup. A backend that cannot answer state queries cheaply omits it, and the
  caller skips those flows.

Each client returns the domain `Issue` shape, not the backend's raw payload. `Issue` requires
`stateType: IssueStateType` (one of `backlog`, `unstarted`, `started`, `completed`, `canceled`,
`triage`); normalizing the backend's status into that field is the provider's job. The Linear client maps Linear states, the
Jira client maps Jira `statusCategory.key`. Keep the raw payload on the issue for the agent to read.

## The options-bag pattern

Like every extension axis, a tracker keeps provider-specific config out of the shared
`TrackerSettings` type and behind an opaque `settings.tracker.options` bag that `parseOptions`
validates once and a typed accessor reads back; see [architecture.md](../architecture.md#registries-and-the-options-bag-pattern)
for the general pattern. The tracker-specific helpers `parseOptions` draws on live in
`packages/tracker-sdk/src/options.ts`:

- `rejectUnknownOptions(options, known, kind)` throws on a typo'd key.
- `stringOption(options, key)` reads one string.
- `stringListOption(options, key)` reads a list; an empty list collapses to `undefined`.
- `resolveEnvReference("$VAR", env)` resolves an env reference.

`stringOption` and `stringListOption` shape their error as `tracker.<key> must be ...`, so an operator
sees the exact failing key. `rejectUnknownOptions` reports the typo'd keys together as `unsupported
tracker option(s) for kind "<kind>": <keys>`. The Linear provider's `parseOptions` and its accessor
pair up like this:

```ts
parseOptions(options, _context) {
  rejectUnknownOptions(options, ["projectSlug", "projectSlugs", "projectLabels"], "linear");
  return {
    projectSlug: stringOption(options, "projectSlug"),
    projectSlugs: stringListOption(options, "projectSlugs"),
    projectLabels: stringListOption(options, "projectLabels"),
  };
}

// extensions/linear-tracker/src/options.ts
export function linearTrackerOptions(settings: Settings): LinearTrackerOptions {
  const options = settings.tracker.options;
  return {
    projectSlug: stringOption(options, "projectSlug") || undefined,
    projectSlugs: stringListOption(options, "projectSlugs"),
    projectLabels: stringListOption(options, "projectLabels"),
  };
}
```

Every other hook reads its config through `linearTrackerOptions(settings)`, never through raw
`settings.tracker.options` keys. `extensions/jira-tracker/src/options.ts` does the same with
`jiraTrackerOptions(settings)`. Unknown kinds parse leniently (the options pass through verbatim) and
only fail at `validateDispatchConfig`, which throws `unsupported tracker.kind: <k> (known kinds: ...)`.

## The agent-facing tools

A tracker exposes agent tools by implementing `defaultToolPacks(settings)`, which returns the names of
the registered `ToolProvider` packs (each a separate provider in `@lorenz/tool-sdk`) that mount by
default when this tracker drives dispatch. The tracker owns and registers those packs; mounting is by
name. A tracker that declares no `defaultToolPacks` ships no tools, unless a registered pack happens to
share its `tracker.kind`, which the MCP mount falls back to.

Each built-in tracker owns its own pack:

- Jira owns the pack named the literal string `"jira"`, defined in
  `extensions/jira-tracker/src/tools.ts`. It serves `jira_read_issue`, `jira_query`,
  `jira_update_status`, `jira_list_comments`, `jira_comment`, `jira_update_comment`, and
  `jira_create_issue` over `JiraClient` or `JiraMcpClient`, selected by `settings.tracker.kind`. The
  `jira` and `jira-mcp` providers both declare `defaultToolPacks() => ["jira"]`.
- Linear declares `defaultToolPacks() => ["linear"]`, mounting the `linear` pack that exposes the
  single `linear_graphql` tool and bundles the `lorenz-linear` skill.
- The `local` tracker mounts its `local` pack: `local_update_status`, `local_comment`,
  `local_create_issue`, `local_read_issue`, and `local_query`.
- The `slack` tracker mounts its `slack` pack: `slack_update_status`, `slack_comment`,
  `slack_read_thread`, `slack_query`, `slack_user_info`, and `slack_channel_context`.
- The `memory` tracker declares no `defaultToolPacks`, so it advertises no tools.

The select/filter projection for `jira_query` lives alongside the pack in
`extensions/jira-tracker/src/tools.ts`, where the seven tool-name definitions and
`DEFAULT_SELECT = [id, identifier, title, state, stateType, labels, url]` are declared. Tool packs are
their own recipe; see [tool-pack.md](tool-pack.md). The `jira_*` surface is detailed in
[reference/tracker-tools.md](../reference/tracker-tools.md).

## The recipe

Adding a tracker is a new package plus one registration call.

1. **Create the package.** Add `extensions/<name>-tracker/` with `package.json` named
   `@lorenz/<name>-tracker`. Depend on `@lorenz/domain` and `@lorenz/tracker-sdk` (and
   `@lorenz/tool-sdk` if you ship a tool pack), each as `workspace:*`. The dependency-cruiser rule
   `extensions-depend-on-sdk-layers-only` blocks any import of an engine package; your code may reach
   only `domain` and the SDKs.

2. **Implement and export the provider.** Write the `TrackerProvider` in `src/provider.ts`: set
   `kind`, implement `createClient`, and add the optional hooks you need. Keep provider config in
   `settings.tracker.options` behind a typed accessor in `src/options.ts`. Normalize backend payloads
   into the domain `Issue` shape in `src/client.ts`.

3. **Export an idempotent register function.** Add `src/register.ts` exporting
   `register<Name>Tracker(registries?)`. Default to the process-wide registries and skip a kind that
   is already present, so calling it twice is safe:

   ```ts
   export function registerNotionTracker(
     registries: { trackers?: TrackerRegistry; tools?: ToolRegistry } = {},
   ): void {
     const trackers = registries.trackers ?? defaultTrackerRegistry;
     if (trackers.get(notionTrackerProvider.kind) === undefined) {
       trackers.register(notionTrackerProvider);
     }
   }
   ```

4. **Wire it into the composition root.** `registerBuiltinBackends()` in `apps/cli/src/daemon.ts` is
   the single place backend identity is hardcoded. Import your register function and add one call
   inside it, alongside `registerLinearTracker`, `registerJiraTrackers`, `registerLocalTracker`,
   `registerMemoryTracker`, and `registerSlackTracker`. That is the one registration line.

5. **Install and reference the package.** Run `pnpm install` to link the new workspace package, then
   add a `references` entry pointing at `../../extensions/<name>-tracker` to `apps/cli/tsconfig.json`
   so the project build picks it up.

After this, `tracker.kind: <name>` in a workflow selects your backend. No core package is touched.

## See also
- [trackers/linear.md](../trackers/linear.md) - the most complete worked example of this contract.
- [trackers/jira.md](../trackers/jira.md) - a second backend with REST and MCP-proxied variants.
- [extensions/tool-pack.md](tool-pack.md) - the separate axis for agent-facing tools your tracker can ship.
- [reference/tracker-tools.md](../reference/tracker-tools.md) - the seven `jira_*` tools the Jira `jira` pack serves.
- [architecture.md](../architecture.md) - how the four extension points and the composition root fit together.
- [reference/configuration.md](../reference/configuration.md) - every `tracker.*` config key the registry selects on.
