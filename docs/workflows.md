# Workflows

A `WORKFLOW.md` file is the single contract that defines a Lorenz orchestrator: it names the tracker to poll, the agent to run, the workspace and worker to run it in, and the prompt the agent receives for each issue. This page is for operators writing or editing that file. It covers the anatomy, the major config sections, the prompt body, hot reload, and the checked-in example fixtures.

## What a workflow file is

One file does two jobs. The YAML front matter configures the runtime; the Markdown body is the agent prompt. Lorenz reads the file, parses the front matter into a typed `Settings` object with every default applied, and parses the body into a Liquid template that renders per issue at dispatch time.

The runtime locates the file in this order:

1. `LORENZ_WORKFLOW` (absolute path used as-is, relative path joined to the working directory).
2. `<cwd>/WORKFLOW.md`.

The file structure is fixed:

```md
---
# YAML front matter: the config
tracker:
  kind: linear
agent:
  kind: codex
---
# Markdown body: the Liquid prompt template
You are working on `{{ issue.identifier }}`.
```

The front matter must open with a literal `---` on the first line and close with a matching `---`. Everything between is parsed as YAML; everything after the closing fence is the prompt body, trimmed. A file with no front matter yields an empty config and treats the whole file as the prompt body. Front matter that parses to anything other than a map throws `workflow_front_matter_not_a_map`; malformed YAML throws `workflow_parse_error`; a missing file throws `missing_workflow_file`.

Config keys are written in `snake_case`. Lorenz normalizes them to its internal `camelCase` before validation, so `route_label_prefix` and `routeLabelPrefix` both parse, but the examples and reference use `snake_case`. Unsupported keys are rejected at parse time with operator-readable messages (for example `tracker.active_states must be a list of strings`).

## Front matter at a glance

Each top-level section configures one subsystem. The table lists the section, its job, and the most load-bearing keys. The full key/default/meaning tables live in [reference/configuration.md](reference/configuration.md).

| Section | Configures | Key keys |
| --- | --- | --- |
| `tracker` / `trackers` | The issue source to poll and how to dispatch | `tracker.kind` (required), `trackers.<bundle>.provider` (required), `active_states`, `terminal_states`, `dispatch.*` |
| `agent` / `agents` | Which coding agent runs and its limits | `agent.kind`, `agent.max_turns`, `agent.max_concurrent_agents`, `agents.<kind>.bridge_command` |
| `workspace` | The per-issue filesystem root and isolation | `workspace.root`, `workspace.isolation` |
| `hooks` | Shell hooks around the workspace lifecycle | `after_create`, `before_run`, `after_run`, `before_remove`, `timeout_ms` |
| `worker` | Where agents run: local, SSH hosts, or a pool | `worker.kind`, `worker.ssh_hosts`, `worker.worker_pool.*` |
| `polling` | Dispatch loop cadence | `polling.interval_ms` |
| `observability` | Dashboard and refresh rates | `observability.dashboard_enabled`, `observability.refresh_ms` |
| `server` | HTTP API host, port, trace directory | `server.host`, `server.port`, `server.trace_dir` |
| `logging` | Log file path | `logging.log_file` |
| `tools` | Per-pack tool options (credentials, endpoints) | `tools.<pack>.*` |
| `status_overrides` | Per-issue-state config overrides | `status_overrides.<state>.{agent,agents}` |

A few defaults to know, all from the code:

- `polling.interval_ms` defaults to `30000`.
- `workspace.root` defaults to `<tmpdir>/lorenz_workspaces`; `workspace.isolation` defaults to `per-agent`.
- `agent.kind` defaults to `codex`; `agent.max_turns` defaults to `20`; `agent.max_concurrent_agents` defaults to `10`; `agent.ensemble_size` defaults to `1`.
- `agents.turn_timeout_ms` defaults to `3600000`; `agents.stall_timeout_ms` defaults to `300000`. These apply to every agent record unless a per-kind value overrides them.
- `hooks.timeout_ms` defaults to `60000`.
- `server.host` defaults to `127.0.0.1`; `server.port` defaults to `4040`; `server.trace_dir` defaults to `~/.lorenz/issues`.
- `logging.log_file` defaults to `~/.lorenz/log/lorenz.log`.

There is no default tracker. `tracker.kind` is unset until you set it, and pre-poll validation throws `tracker.kind is required` when it is missing. Treat it as mandatory.

### Tracker selection

Two shapes select a tracker. The canonical form is the nested bundle: `tracker.kind` selects a bundle declared under `trackers.<bundle>`, and that bundle's required `provider` names the implementation (it does not default to the bundle name):

```yaml
tracker:
  kind: linear
trackers:
  linear:
    provider: linear
    api_key: $LINEAR_API_KEY
    project_slugs:
      - "lorenz-414bf2e49ff2"
```

The flat form puts options directly under `tracker:` as terse shorthand and works only when no matching `trackers` bundle is present. Provider-specific keys (Linear's `project_slugs`, Slack's `channels`, the local board's `path`) pass through to the selected provider, which validates them. See [trackers/index.md](trackers/index.md) for the provider list.

### Agent selection

`agent.kind` chooses which `agents.<kind>` record runs. The two built-in records are `codex` and `claude`, both using `executor: acp` over a bridge subprocess (`codex-acp`, `claude-agent-acp`). Per-kind config lives under `agents.<kind>`:

```yaml
agent:
  kind: codex
agents:
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
  codex:
    bridge_command: codex-acp
    provider_config:
      model: gpt-5.4
      model_reasoning_effort: high
```

`provider_config` is delivered to the bridge by family: the Claude bridge receives a `settings.json`-shaped overlay, every other bridge receives a `config.toml`-shaped one. See [agents/index.md](agents/index.md) and [agents/acp-bridges.md](agents/acp-bridges.md).

### Secrets in config

Any string value can reference a secret. Three forms resolve, in this order:

- `$VAR` substitutes the whole value from the environment (`api_key: $LINEAR_API_KEY`). It is whole-value only; it does not interpolate substrings.
- A provider env fallback fills the value when the `$VAR` form is unset or empty (Linear reads `LINEAR_API_KEY`; Jira reads `JIRA_API_KEY`).
- `op://...` reads from 1Password via the `op` CLI on `PATH`, applied last to whatever value survived.

Details and the resolution order are in [features/secret-resolution.md](features/secret-resolution.md).

### Per-state overrides

`status_overrides.<state>` swaps in different agent config when an issue sits in a given tracker state. State keys are matched after trimming and lowercasing, so `In Progress` and `in progress` are the same key.

```yaml
status_overrides:
  rework:
    agent:
      max_turns: 40
    agents:
      codex:
        provider_config:
          model_reasoning_effort: xhigh
```

Overrides patch agent fields and per-kind `agents` fragments. They cannot retarget `skills` and cannot switch a kind's `executor` (both keys are rejected in the override). The effective per-issue settings are computed by cloning the base and applying the matching override, so a clone never mutates the base.

## The prompt body

Everything after the closing `---` is a Liquid template rendered once per dispatch. The render context is three variables:

- `issue` - the current issue, with `snake_case` fields: `id`, `identifier`, `title`, `description`, `priority`, `state`, `state_type`, `branch_name`, `url`, `assignee_id`, `labels`, `blocked_by`, `assigned_to_worker`, `created_at`, `updated_at`. Note the fields are `snake_case` in templates even though config keys are `camelCase` internally.
- `attempt` - the retry attempt number, or `null` on the first attempt.
- `ensemble` - `{ enabled, slot_index, size }` for context ensembles (`enabled` is true only when `size > 1`).

A minimal body uses `issue` directly:

```md
You are working on `{{ issue.identifier }}`: {{ issue.title }}.

{% if issue.description %}{{ issue.description }}{% else %}No description provided.{% endif %}
```

The template engine runs with `strictVariables` and `strictFilters`, so a reference to an undefined variable raises an error rather than rendering empty. The full variable reference, with `blocked_by` sub-fields and the `ensemble` shape, is in [reference/workflow-prompt.md](reference/workflow-prompt.md).

A blank body is never actually blank: an empty or whitespace-only Markdown section falls back to a built-in default template that renders the issue identifier, title, and description. To control the prompt, write one.

Continuation turns inject a separate static guidance string after the first turn of an active issue, telling the agent to resume from the existing workspace and workpad instead of restarting. You do not author this; the runtime adds it. The `{% if attempt %}` block in the example fixtures is the place to add your own continuation context.

## Hot reload

Lorenz re-reads `WORKFLOW.md` before each poll. Edit the file while the daemon runs and the next tick picks up the change without a restart. The runtime computes a content stamp (`mtimeMs`, `size`, and a SHA-256 hash); if the stamp is unchanged it skips the reload entirely.

A reload is transactional. The runtime re-runs its startup gates and reconciliation first, and swaps the live settings only after all of them succeed. On any failure it keeps the last-good settings (no partial apply) and emits `workflow_reload_failed`; a successful swap emits `workflow_reloaded`. One gate worth knowing: the reload re-runs the per-machine slot co-residence check that startup runs once, so a live daemon cannot widen its blast radius by raising `max_in_flight` past it. See [features/workflow-hot-reload.md](features/workflow-hot-reload.md).

## A minimal workflow

The smallest workflow that dispatches: a tracker, an agent, and a one-line prompt.

```md
---
tracker:
  kind: local
trackers:
  local:
    provider: local
    path: .lorenz/local
agent:
  kind: codex
---
You are working on `{{ issue.identifier }}`: {{ issue.title }}.

{% if issue.description %}{{ issue.description }}{% else %}No description provided.{% endif %}
```

The local board needs no credentials, which makes it the quickest tracker to start with. `path` defaults to `.lorenz/local`, `id_prefix` to `BOARD-`, and the active/terminal state lists default too, so the bundle can be even shorter. See [trackers/local.md](trackers/local.md), [getting-started.md](getting-started.md), and [reference/configuration.md](reference/configuration.md) for the default state lists.

## A fuller workflow

A Linear-backed workflow with secrets, a clone hook, explicit timeouts, and per-kind agent config:

```yaml
tracker:
  kind: linear
trackers:
  linear:
    provider: linear
    api_key: $LINEAR_API_KEY
    project_slugs:
      - "lorenz-414bf2e49ff2"
    active_states:
      - Todo
      - In Progress
      - Rework
    terminal_states:
      - Closed
      - Cancelled
      - Done
    dispatch:
      accept_unrouted: true
      only_routes: null
      route_label_prefix: "Lorenz:"
polling:
  interval_ms: 5000
workspace:
  root: ~/dev/lorenz-workspaces
hooks:
  after_create: |
    set -euo pipefail
    git clone --depth 1 https://github.com/ryanlyn/lorenz .
    mise trust && mise exec -- pnpm install --frozen-lockfile
agent:
  kind: codex
  max_concurrent_agents: 10
  max_turns: 20
agents:
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
  codex:
    bridge_command: codex-acp
    provider_config:
      model: gpt-5.4
      model_reasoning_effort: high
```

The `after_create` hook runs once when the per-issue workspace is created; `git clone` populates it before the agent starts. Hook commands run through `bash -lc` with the workspace as the working directory, and `after_create` or `before_run` failures abort the run. See [workspace.md](workspace.md) for the hook lifecycle and [reference/configuration.md](reference/configuration.md) for every key.

## The checked-in examples

The repository root ships three example workflows. Each is a complete, runnable file you can copy and adapt.

| File | Tracker | Demonstrates |
| --- | --- | --- |
| `WORKFLOW.md` | Linear | The reference Linear flow: `project_slug`, an `Agent Review` state with an autonomous review protocol, both `codex` and `claude` configured (`claude` with `bypassPermissions`), and a full multi-step prompt with a `## Codex Workpad` comment protocol and a `lorenz-land` handoff |
| `WORKFLOW.local.md` | Local board | No credentials and no Linear: `tracker.kind: local` with `id_prefix`, the `local_*` tools, and a prompt that reads state through `local_read_issue` |
| `WORKFLOW.slack.md` | Slack | Issues from bot @-mentions: `channels`, `bot_user_id`, `emoji_states`, hashtag routing with `route_label_prefix: "route-"`, and the `slack_*` tools |

The two non-Linear examples show how the prompt body changes with the tracker: each documents its own tool surface (`local_read_issue` / `slack_read_thread`) and tells the agent not to call Linear. See [trackers/index.md](trackers/index.md) for the matching provider pages.

## See also

- [reference/configuration.md](reference/configuration.md) - every front-matter key, default, and meaning
- [reference/workflow-prompt.md](reference/workflow-prompt.md) - the full `issue` / `attempt` / `ensemble` variable reference
- [features/workflow-hot-reload.md](features/workflow-hot-reload.md) - reload semantics and the `workflow_reloaded` / `workflow_reload_failed` events
- [features/secret-resolution.md](features/secret-resolution.md) - `$VAR`, `op://`, and env-fallback resolution order
- [trackers/index.md](trackers/index.md) - the tracker providers a `tracker.kind` can select
- [getting-started.md](getting-started.md) - writing your first workflow and running the daemon
