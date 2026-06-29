# Reference

The code-accurate contracts for Lorenz: every config key, every CLI flag, every HTTP
route, every event name, every agent tool, the `WORKFLOW.md` file format, and the vocabulary the
rest of the docs use. This section is for integrators and spec readers who need the precise surface,
not a tour. The operator and extension-author pages explain *why* and *when*; the reference pages
state *what*, in flat tables you can scan.

These pages are the source of truth. Defaults are read from the implementation, not the README, and
where the two disagree the code wins. Names are verbatim: a key shown in backticks here is the exact
string you write or the exact identifier the engine emits. If a page names a default, that default
was verified against the parser or schema that applies it.

## The pages

- [configuration.md](configuration.md) - every `WORKFLOW.md` front-matter key, its snake_case
  spelling, default, and meaning. The full schema across `tracker`, `trackers`, `polling`,
  `workspace`, `worker`, `agent`, `agents`, `hooks`, `tools`, `observability`, `server`, `logging`,
  and `status_overrides`, plus secret resolution (`$VAR`, `op://`, env fallbacks) and the recognized
  environment variables.
- [workflow-prompt.md](workflow-prompt.md) - the `WORKFLOW.md` file format: the `---`-delimited YAML
  front matter, the Liquid prompt body, the issue/attempt/ensemble variables a template can read
  (snake_case, for example `state_type`, `branch_name`, `assigned_to_worker`), the built-in default
  template, and the continuation-turn prompt.
- [cli.md](cli.md) - the `lorenz` command surface: subcommands, flags, exit codes, and the
  environment variables that change behavior.
- [http-api.md](http-api.md) - the dashboard and trace server: every REST route, its method and
  shape, the WebSocket `events` and `events_append` messages, and the `server.host` / `server.port`
  binding.
- [events.md](events.md) - the named events the runtime records to a run's trace, including
  `workflow_reloaded`, `workflow_reload_failed`, `workflow_parse_error`, and
  `missing_workflow_file`. Each entry lists when it fires and what payload it carries.
- [tracker-tools.md](tracker-tools.md) - the agent-facing tool catalog (for example `jira_query`
  and the tracker write tools), their input schemas, and which tracker capabilities each one
  requires.
- [spec.md](spec.md) - the formal data shapes: the parsed `Settings` object, the `WorkflowDefinition`
  it comes from, and the cross-cutting types that the CLI, HTTP API, and events all share.
- [glossary.md](glossary.md) - one definition per term: issue, route, slot, ensemble, worker, agent,
  executor, bridge, tracker, tool pack, and the rest of the vocabulary used across these docs.

## How to read a reference page

Each page is a flat enumeration, not a narrative. Scan it like a man page.

- Config examples use the snake_case keys you write in `WORKFLOW.md` front matter, not the camelCase
  field names the engine normalizes them to internally. `polling.interval_ms`, not `intervalMs`.
- A default in a table is the value applied when you omit the key. `polling.interval_ms` defaults to
  `30000`; `server.port` defaults to `4040`; `agent.max_concurrent_agents` defaults to `10`.
- A few keys have no default and are required at validation time. `tracker.kind` is the notable one:
  there is no default tracker, and dispatch validation rejects a config that leaves it unset.
- Where a behavior depends on order (secret resolution, tracker selection, per-state overrides), the
  page states the order explicitly and ties it to the module that enforces it.

If a name you see elsewhere in the docs is not in these pages, treat the other page as the looser
description and the reference as the contract.

## See also
- [../how-it-works.md](../how-it-works.md) - the run loop these contracts plug into, for the reader who wants the model before the tables.
- [../workflows.md](../workflows.md) - the operator guide to writing `WORKFLOW.md`, paired with [configuration.md](configuration.md) and [workflow-prompt.md](workflow-prompt.md).
- [../architecture.md](../architecture.md) - how the config, workflow, and prompt packages fit the larger engine.
- [../source-map.md](../source-map.md) - where each package and type named here lives in the tree.
- [../troubleshooting.md](../troubleshooting.md) - the errors and events from these pages, mapped to fixes.
