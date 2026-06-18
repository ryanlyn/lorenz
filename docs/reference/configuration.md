# Configuration reference

The complete front-matter contract for `WORKFLOW.md`. This page is for integrators who want every key, its type, its verified default, and its meaning in one place. It supersedes the configuration section of the README; where the two disagree, this page and the code win.

Lorenz reads a single file per repository: `WORKFLOW.md`. The file has two parts. The YAML front matter (between the first `---` and the next `---`) is the config covered here. The Markdown body below it is the agent prompt template, documented in [workflow-prompt.md](workflow-prompt.md). The runtime reloads this file before each poll, so config changes apply without a restart. See [workflow-hot-reload](../features/workflow-hot-reload.md) for the reload semantics.

Run `lorenz config [workflowPath]` (or `lorenz-config [workflowPath]`) to generate this file
interactively. The wizard and parser defaults are Jira and Claude. Explicit front-matter values
always win.

```yaml
---
tracker:
  kind: jira            # parser default, written explicitly by the wizard
trackers:
  jira:
    provider: jira      # names the implementation
    base_url: $JIRA_BASE_URL
    email: $JIRA_EMAIL
    api_key: $JIRA_API_KEY
    project_keys: [ENG]
polling:
  interval_ms: 30000
agent:
  kind: claude
  max_concurrent_agents: 4
---
You are working on {{ issue.identifier }}: {{ issue.title }}.
```

The nested bundle form above is the recommended shape: `tracker.kind` selects the bundle and the matching `trackers.<bundle>.provider` names the implementation. The flat form (provider options directly under `tracker`) is a terser shorthand for the same config; see [Bundle and flat shapes](#bundle-and-flat-shapes).

## How keys are named

Front-matter keys are **snake_case**. The parser normalizes them to camelCase internally, but that is an implementation detail; write the snake_case form shown in every table below. Each section is validated against a strict schema: unknown keys inside a known section raise an operator-readable error (`<section>.<key> is not supported`). Two sections are deliberately open: `trackers.<name>` and `agents.<kind>` pass provider-specific and executor-specific keys straight through to the provider, which validates them.

Error messages are emitted in snake_case (for example `tracker.active_states must be a list of strings`), except provider passthrough keys that surface their camelCase spelling (for example `tracker.baseUrl must be a string`).

## Secret syntax

Any string value can be a secret reference. Resolution runs at parse time.

| Form | Behavior |
| --- | --- |
| `$VAR` | Whole-value match only (`^\$[A-Za-z_][A-Za-z0-9_]*$`). Replaced by `env[VAR]`, or the empty string when unset. Does not interpolate substrings. |
| `op://vault/item/field` | Read through the 1Password CLI (`op read <ref>`). Requires the `op` binary on `PATH`. |
| (unset) | Falls back to the provider's env fallback (for example `LINEAR_API_KEY`) when one exists. |

Order: an inline `$VAR` that resolves non-empty wins; otherwise the provider env fallback applies; then any `op://` value is read. A bare `op://` fallback resolves even when no inline value is set. A missing `op` binary throws `1Password CLI (op) is required ... cannot be managed by mise.`; a failed read throws `Failed to resolve 1Password reference: <ref>`. See [secret-resolution](../features/secret-resolution.md).

The config wizard's credential prompts default to these references and write them without
resolution. API-secret prompts require an environment reference and reject literal credentials so
tokens are not stored in `WORKFLOW.md`.

*Diagram placeholder: secret resolution decision tree (inline `$VAR` then provider env fallback then `op://` 1Password read), with the empty-string and bare-`op://` edge cases. Caption: how a single string value becomes a resolved secret.*

## Environment variables

These are read directly, outside the front matter.

| Variable | Effect |
| --- | --- |
| `LORENZ_WORKFLOW` | Path to the workflow file. Absolute kept as-is; relative joined to the current directory. Defaults to `<cwd>/WORKFLOW.md`. |
| `LORENZ_WORKSPACE_ROOT` | Overrides `workspace.root`. |
| `LORENZ_SSH_CONFIG` | Passed to `ssh` as `-F <path>` for all SSH execution and tunnels. |
| `LINEAR_API_KEY` | Env fallback for `tracker.api_key` when `kind: linear`. |
| `LINEAR_ASSIGNEE` | Env fallback for `tracker.assignee` when `kind: linear`. |
| `JIRA_API_KEY` | Env fallback for `tracker.api_key` when `kind: jira`. |
| `JIRA_BASE_URL` | Default reference resolved for `tracker.base_url` (jira and jira-mcp). |
| `JIRA_EMAIL` | Fallback for `tracker.email` (jira). |
| `SLACK_BOT_TOKEN` | Env fallback for `tracker.api_key` when `kind: slack`. |
| `SLACK_BOT_USER_ID` | Env fallback for `tracker.bot_user_id` (slack). An empty string does not satisfy it. |
| `LORENZ_MEMORY_TRACKER_ISSUES_JSON` | JSON array of issue records for `kind: memory` (fallback `LORENZ_MEMORY_TRACKER_ISSUES`). |
| `CLAUDE_CODE_EXECUTABLE` | Path to the `claude` binary; auto-resolved from a login shell if unset, explicit value wins. |
| `CODEX_PATH` | Path to the `codex` binary; auto-resolved from a login shell if unset, explicit value wins. |

## `tracker`

The core tracker bundle. `tracker.kind` selects the provider and defaults to `jira`. Jira still
requires its provider essentials before dispatch; use the wizard or configure them explicitly. See
[trackers](../trackers/index.md).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `tracker.kind` | string | `jira` | Selects the provider: `linear`, `jira`, `jira-mcp`, `local`, `slack`, `memory`, or `dispatch`. An explicit value wins. |
| `tracker.provider` | string | (none) | Provider name when `kind` names a bundle rather than a provider directly. |
| `tracker.endpoint` | string | provider default | API base URL. Falls back to the provider's `defaultEndpoint`. |
| `tracker.api_key` | string (secret) | (none) | API credential. Resolves `$VAR` / `op://` / provider env fallback. |
| `tracker.assignee` | string | (none) | Restricts dispatch to issues assigned to this value. Per-provider semantics below. |
| `tracker.active_states` | string[] | Jira: `[To Do, In Progress]`; others: `[Todo, In Progress]` | States that make an issue a dispatch candidate. |
| `tracker.terminal_states` | string[] | `[Closed, Cancelled, Canceled, Duplicate, Done]` | Finished states that trigger workspace cleanup. |
| `tracker.dispatch.accept_unrouted` | boolean | `true` | Dispatch issues that carry no route label. |
| `tracker.dispatch.only_routes` | string[] \| null | `null` | Restrict dispatch to these routes; `null` means no restriction. |
| `tracker.dispatch.route_label_prefix` | string | `Lorenz:` | Label prefix that marks a route (for example `Lorenz:Backend` to route `backend`). |

`active_states`, `terminal_states`, and the `dispatch.*` keys are core fields shared by every provider, not provider-specific. See [dispatch](../dispatch.md) and [dispatch-routing](../features/dispatch-routing.md).

### Bundle and flat shapes

The recommended nested bundle shape names the implementation explicitly: `tracker.kind` selects the bundle and the matching `trackers.<bundle>.provider` names the provider (it does not default to the bundle name). The selector options under `tracker` merge into that bundle. If `tracker.kind` is omitted, the selector is `jira`; any explicit selector replaces that default.

The flat shape (`tracker.kind: <provider>` with provider options directly under `tracker`) is a terser shorthand that works when no matching `trackers.<name>` bundle is present. Unregistered kinds parse generically (options pass through unvalidated) and are rejected at dispatch validation.

*Diagram placeholder: tracker selection, flat `tracker.kind` versus a `trackers.<name>.provider` bundle, and option passthrough to `provider.parseOptions`. Caption: how the parser picks a provider and hands it its option slice.*

## `trackers.<name>`

Named tracker bundles, used with the `dispatch` kind or to define multiple trackers. Keys beyond `provider` pass through to the named provider.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `trackers.<name>.provider` | string | (required) | The provider this bundle uses. Required when the bundle is present. |
| `trackers.<name>.*` | provider keys | (passthrough) | Any provider-specific keys (for example `api_key`, `project_slugs`, `active_states`). |

## Per-provider tracker options

The keys below live under `tracker` (flat shape) or `trackers.<name>` (bundle shape).

### `linear`

See [trackers/linear.md](../trackers/linear.md). Requires `api_key` and exactly one of `project_slugs`, `project_labels`, or the deprecated singular `project_slug`.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `project_slug` | string | (none) | Single project slug. Deprecated; prefer `project_slugs`. Only this powers the operator project URL. |
| `project_slugs` | string[] | (none) | Explicit list of project slugs. |
| `project_labels` | string[] | (none) | Discover projects dynamically by project label. |
| `endpoint` | string | `https://api.linear.app/graphql` | GraphQL endpoint. |
| `api_key` | string (secret) | env `LINEAR_API_KEY` | Linear API key. Required. |
| `assignee` | string | env `LINEAR_ASSIGNEE` | Literal `me` resolves to the viewer id; blank means no filter. |

### `jira`

Direct Jira Cloud REST v3. See [trackers/jira.md](../trackers/jira.md). Requires `base_url`, `email`, `api_key`, and at least one of `jql` or `project_keys`. Issues must be labeled `agent` and assigned to the worker, or Lorenz never dispatches them; that gate is not configurable.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `base_url` | string (secret) | ref `$JIRA_BASE_URL` | Jira Cloud base URL. Required. |
| `email` | string (secret) | fallback `JIRA_EMAIL` | Account email for HTTP Basic auth. Required. |
| `api_key` | string (secret) | env `JIRA_API_KEY` | API token. Required. |
| `project_keys` | string[] | (none) | Project keys for the candidate scope. |
| `jql` | string | (none) | Provider-native scope, wrapped and AND-ed with the active-states and agent gating. |
| `issue_type` | string | `Task` | Issue type used by `tracker_create_issue`. |
| `assignee` | string | (none) | Unset or `me` resolves to `currentUser()`; otherwise verbatim. |

### `jira-mcp`

Jira operations proxied as JSON-RPC `tools/call` requests to an external MCP server. Requires `mcp.url` (and at least one of `jql` or `project_keys`); has no env fallback for credentials. The `agent` label gate still applies.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `base_url` | string (secret) | ref `$JIRA_BASE_URL` | Optional; only used to build issue URLs when MCP payloads omit them. |
| `mcp.url` | string (secret) | (none) | MCP server URL. Required. |
| `mcp.token` | string (secret) | (none) | Sent as Bearer auth. |
| `mcp.headers` | map | (none) | Extra request headers. |
| `mcp.tools.search` | string | `jira_search` | Tool name override. |
| `mcp.tools.read_issue` | string | `jira_get_issue` | Tool name override (alias `readIssue`). |
| `mcp.tools.update_status` | string | `jira_transition_issue` | Tool name override (alias `updateStatus`). |
| `mcp.tools.list_comments` | string | `jira_get_comments` | Tool name override (alias `listComments`). |
| `mcp.tools.comment` | string | `jira_add_comment` | Tool name override. |
| `mcp.tools.update_comment` | string | `jira_update_comment` | Tool name override (alias `updateComment`). |
| `mcp.tools.create_issue` | string | `jira_create_issue` | Tool name override (alias `createIssue`). |

`project_keys`, `jql`, `issue_type`, and `assignee` carry the same meaning as the `jira` kind. The `mcp.tools.*` keys accept both snake_case and camelCase; `search` and `comment` have no snake_case alias.

### `local`

Filesystem board: one Markdown file per issue. See [trackers/local.md](../trackers/local.md). `path` is optional and defaults to `.lorenz/local`; an explicitly empty `path` is rejected.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `path` | string | `.lorenz/local` | Board directory. Expands `~` and `$VAR`/`${VAR}`; relative paths resolve against the current directory. |
| `id_prefix` | string | `BOARD-` | Issue-id prefix. Must match `^[A-Za-z0-9][A-Za-z0-9_-]*$`. Changing it on an existing board orphans the old files. |

### `slack`

Slack as a tracker: an @-mention of the bot becomes an issue. See [trackers/slack.md](../trackers/slack.md). Requires `channels` and `bot_user_id`. `assignee` is rejected for this kind.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `channels` | string[] | (required) | Channel ids (`C...`). Supports `$VAR` refs; an unresolved ref is dropped. |
| `bot_user_id` | string | env `SLACK_BOT_USER_ID` | The bot's `U...` id. Required; the production transport fails closed without it. |
| `api_key` | string (secret) | env `SLACK_BOT_TOKEN` | The `xoxb-` bot token. |
| `endpoint` | string | `https://slack.com/api` | Slack Web API base URL. |
| `emoji_states` | map | `{eyes: In Progress, white_check_mark: Done, x: Cancelled}` | Reaction-name to state-name map, merged over the defaults. |
| `marker_emoji` | string | `robot_face` | The bot's ownership-marker reaction. |
| `reply_lookback_days` | number | `2` | How far back to discover new reply-mention threads. |

The shipped Slack workflow uses `polling.interval_ms: 60000` and `dispatch.route_label_prefix: route-`, because `conversations.history` can be throttled to roughly one request per minute.

### `memory`

In-process tracker for tests and dry runs. See [trackers/memory.md](../trackers/memory.md). Takes no options; issues come from `LORENZ_MEMORY_TRACKER_ISSUES_JSON` (fallback `LORENZ_MEMORY_TRACKER_ISSUES`). Exposes no agent tools.

## `tools.<pack>`

Per-tool-pack options. String values are secret-resolved. Tool packs mount automatically for the dispatch tracker (for example Linear mounts the `linear` pack); these keys override credentials or mount a pack standalone. See [tracker-tools.md](tracker-tools.md).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `tools.linear.api_key` | string (secret) | (none) | Credential for the `linear_graphql` tool. Takes precedence over the dispatch tracker. Alias `apiKey`. |
| `tools.linear.endpoint` | string | `https://api.linear.app/graphql` | Endpoint for the `linear` pack. |
| `tools.local.path` | string | (board default) | Board directory for the `local` pack. |
| `tools.local.id_prefix` | string | `BOARD-` | Id prefix for the `local` pack. Alias `idPrefix`. |

The `tools.linear` slice accepts only `api_key`/`apiKey` and `endpoint`; any other key throws `tools.linear.<key> is not supported`. The `tools.local` slice accepts only `path` and `idPrefix`/`id_prefix`.

## `polling`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `polling.interval_ms` | integer (positive) | `30000` | Milliseconds between dispatch polls. |

## `workspace`

Where agent runs check out. See [workspace](../workspace.md).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `workspace.root` | string | `<tmpdir>/lorenz_workspaces` | Root for per-issue workspaces. `LORENZ_WORKSPACE_ROOT` overrides it. Expands `~`/`~/` against `HOME`/`USERPROFILE`. |
| `workspace.isolation` | `per-agent` \| `none` | `per-agent` | `per-agent` gives each agent its own workspace; `none` shares one. `none` forbids workspace hooks. |

## `worker`

Where agent runs execute. The legacy static path (`ssh_hosts`) and the warm pool (`worker_pool`) are mutually exclusive: `worker.ssh_hosts` cannot combine with `worker_pool.enabled` or `worker.kind`. See [workers](../workers/index.md).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `worker.kind` | string | (none) | Selects a `workers.<name>` profile. Cannot combine with `worker_pool.driver` or `ssh_hosts`. |
| `worker.ssh_hosts` | string[] | `[]` | Legacy static SSH destinations runs are sharded across. No provisioning or lifecycle. |
| `worker.ssh_timeout_ms` | integer (positive) | `60000` | SSH command timeout. |
| `worker.max_concurrent_agents_per_host` | integer | (none) | Per-host run cap for the static path. |

### `worker.worker_pool`

The embedded warm pool. See [worker-pool](../workers/worker-pool.md).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `worker_pool.enabled` | boolean | `true` when present | Turns the pool on. |
| `worker_pool.driver` | string | `fake` | Driver kind (`fake`, `static-ssh`, `docker`) or an out-of-tree module specifier. |
| `worker_pool.min` | integer | `0` | Minimum machines kept alive. |
| `worker_pool.max` | integer | `1` | Maximum machines. Must be `>= min`. |
| `worker_pool.warm` | integer | `1` | Pre-warmed idle machines. Must be `<= max`. |
| `worker_pool.max_in_flight` | integer | `1` | Slots per machine. (The internal field is `slotsPerMachine`; `max_in_flight` is the config spelling.) Co-residence above 1 needs `co_residence: true`. |
| `worker_pool.ttl_ms` | integer | `3600000` | Machine lifetime before reap. |
| `worker_pool.idle_reap_ms` | integer | `300000` | Idle time before a machine above `min` is reaped. |
| `worker_pool.acquire_timeout_ms` | integer | `30000` | How long an acquire waits for capacity. |
| `worker_pool.reap_interval_ms` | integer | `15000` | Reaper cadence. |
| `worker_pool.stale_heartbeat_ms` | integer | `600000` | Heartbeat staleness threshold. |
| `worker_pool.drain_deadline_ms` | integer | `30000` | Time to await in-flight leases before force-destroy on drain. |
| `worker_pool.max_workers_per_issue` | integer | (none) | Per-issue fairness cap on machines. |
| `worker_pool.co_residence` | boolean | (none) | Opt-in required for more than one slot per machine. |
| `worker_pool.max_concurrent_tunnels` | integer | (none) | Cap on concurrent reverse tunnels. |
| `worker_pool.spend.max_concurrent_workers` | integer | (none) | Blocks growth past this many live machines. |
| `worker_pool.spend.max_worker_seconds` | integer | (none) | Lifetime worker-seconds cap. |
| `worker_pool.spend.daily_worker_seconds` | integer | (none) | Per-UTC-day worker-seconds cap, persisted to `spend.json`. |

### `workers.<name>`

Driver profiles referenced by `worker.kind` or `worker_pool.driver`. The `driver` key selects the backend; all other keys pass through verbatim to that driver. See [docker](../workers/docker.md) and [static-ssh](../workers/static-ssh.md).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `workers.<name>.driver` | string | (required) | The worker driver kind. |
| `workers.<name>.ssh_hosts` | string[] | (none) | `static-ssh` driver: fixed host list (alias `sshHosts`). Required for that driver. |
| `workers.<name>.image` | string | (none) | `docker` driver: container image. Required for that driver. |
| `workers.<name>.user` | string | `root` | `docker` driver: SSH user (aliases `sshUser`, `ssh_user`). |

## `hooks`

Lifecycle shell hooks. See [workspace](../workspace.md). Each runs at a workspace lifecycle point. `workspace.isolation: none` forbids them.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `hooks.after_create` | string | `null` | Runs after a workspace is created. |
| `hooks.before_run` | string | `null` | Runs before the agent starts. |
| `hooks.after_run` | string | `null` | Runs after the agent finishes (best-effort). |
| `hooks.before_remove` | string | `null` | Runs before a workspace is removed. |
| `hooks.timeout_ms` | integer (positive) | `60000` | Per-hook timeout. |

## `agent`

Run-loop and concurrency settings, independent of which executor runs. See [agent-orchestrator](../agent-orchestrator.md).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `agent.kind` | string | `claude` | Which `agents.<kind>` record runs. An explicit value wins. |
| `agent.max_concurrent_agents` | integer | `10` | Global cap on concurrent agent runs. |
| `agent.max_turns` | integer | `20` | Maximum turns per run. |
| `agent.max_retry_backoff_ms` | integer | `300000` | Ceiling on retry backoff. |
| `agent.ensemble_size` | integer | `1` | Parallel attempts per issue. Above 1 enables ensemble mode. See [context-ensembles](../features/context-ensembles.md). |
| `agent.skills` | string[] | `[]` | Agent skills mounted for every run. See [skills](../agents/skills.md). |

## `agents`

Executor records keyed by kind, plus shared timeout defaults. The `agents` block is the single runtime source of truth for executors. See [agents](../agents/index.md) and [acp-bridges](../agents/acp-bridges.md).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `agents.turn_timeout_ms` | integer (positive) | `3600000` | Shared turn-timeout default applied to every record. |
| `agents.stall_timeout_ms` | integer (>= 0) | `300000` | Shared stall-timeout default. The one timeout that may be `0`, which disables stall detection. |
| `agents.<kind>.executor` | string | `acp` | Executor selector. The only built-in value is `acp`. Cannot be overridden per state. |
| `agents.<kind>.turn_timeout_ms` | integer (positive) | `3600000` | Hard turn cancel. Overrides the shared default. |
| `agents.<kind>.stall_timeout_ms` | integer (>= 0) | `300000` | Inactivity cancel, reset on every update. `<= 0` disables it. |
| `agents.<kind>.bridge_command` | string | `codex-acp` / `claude-agent-acp` | The ACP bridge command (non-blank). Bare names resolve to vendored packages locally. |
| `agents.<kind>.usage_accounting` | `per-turn` \| `cumulative` | `per-turn` | How per-turn token usage is accounted. Inferred when unset; built-in records set `per-turn`. |
| `agents.<kind>.provider_config` | record | (none) | Per-session config overlay. Claude receives a `settings.json` shape; everything else a `config.toml` shape. |
| `agents.<kind>.strict_mcp_config` | boolean | `true` | Parsed and validated but not consumed at runtime today. |

The built-in `codex` record uses `bridge_command: codex-acp`. The default `claude` record uses `bridge_command: claude-agent-acp` and a `provider_config` of `{model: claude-opus-4-6[1m], permissions: {defaultMode: dontAsk}}`. That model pin is `DEFAULT_CLAUDE_MODEL` (currently `claude-opus-4-6[1m]`; the authoritative value lives in `packages/config/src/defaults.ts`). The `bridge_command` is a single shell command string split on whitespace; there is no `bridge_args` key. See [codex](../agents/codex.md) and [claude](../agents/claude.md).

### Legacy agent sugar

Top-level `codex:` and `claude:` sections map into `agents.<kind>` records. `command` maps to `bridge_command` (the canonical key wins when both are set). `claude.model` pins `provider_config.model` unless `provider_config` already sets it. These spellings are being phased out; prefer the `agents` block.

| Legacy key | Maps to |
| --- | --- |
| `codex.command` / `claude.command` | `agents.<kind>.bridge_command` |
| `codex.turn_timeout_ms` / `claude.turn_timeout_ms` | `agents.<kind>.turn_timeout_ms` |
| `codex.stall_timeout_ms` / `claude.stall_timeout_ms` | `agents.<kind>.stall_timeout_ms` |
| `claude.model` | `agents.claude.provider_config.model` |
| `claude.strict_mcp_config` | `agents.claude.strict_mcp_config` |
| `claude.provider_config` | `agents.claude.provider_config` |

## `status_overrides`

Per-state setting overrides, keyed by issue state name (normalized with trim and lowercase). Each entry can override `agent` fields and per-kind `agents` fragments, merged into the effective settings for an issue in that state. A per-state fragment cannot retarget `skills` or switch `executor`; both keys are rejected.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `status_overrides.<state>.agent` | record | (none) | `agent`-level overrides for issues in this state. |
| `status_overrides.<state>.agents` | record | (none) | Per-kind `agents` fragments (no `executor`, no `skills`). |
| `status_overrides.<state>.codex` | record | (none) | Legacy sugar mapped into `agents.codex`. |
| `status_overrides.<state>.claude` | record | (none) | Legacy sugar mapped into `agents.claude`. |

*Diagram placeholder: `status_overrides` merge into the effective per-issue-state settings (`settingsForIssueState`). Caption: how a state name selects an override fragment that is merged onto a cloned base.*

## `observability`

TUI dashboard settings. See [observability](../observability.md).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `observability.dashboard_enabled` | boolean | `true` | Whether the TUI dashboard renders. |
| `observability.refresh_ms` | integer | `1000` | Intended TUI refresh interval. |
| `observability.render_interval_ms` | integer | `16` | Intended frame interval. |

## `server`

The HTTP observability server and trace store. See [http-api.md](http-api.md).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `server.host` | string | `127.0.0.1` | Bind host. |
| `server.port` | integer (valid port) | `4040` | Bind port. `0` binds an ephemeral port. The `--port` flag overrides this. |
| `server.trace_dir` | string | `~/.lorenz/issues` | JSONL trace directory; enables trace routes when paired with the issue store. |
| `server.static_dir` | string | (built SPA dir) | Override for the built dashboard assets. |

The config default for `server.port` is `4040`, not disabled. Whether the web server actually starts is gated separately by the `--no-dashboard` CLI flag, not by this default.

## `logging`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `logging.log_file` | string | `~/.lorenz/log/lorenz.log` | Log file path, surfaced in the dashboard log hints. |

## See also
- [workflows.md](../workflows.md) - writing and structuring `WORKFLOW.md`
- [workflow-prompt.md](workflow-prompt.md) - the Markdown prompt template and its variables
- [trackers/index.md](../trackers/index.md) - choosing and configuring a tracker
- [secret-resolution](../features/secret-resolution.md) - how `$VAR` and `op://` references resolve
- [workflow-hot-reload](../features/workflow-hot-reload.md) - reload semantics and last-good fallback
