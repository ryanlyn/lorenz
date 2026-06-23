# How Lorenz works

This page is a concept-first walkthrough for anyone deciding whether to run or evaluate Lorenz. It
covers the end-to-end loop, what a `WORKFLOW.md` is, how agents run inside per-issue workspaces, and
how restart recovery works. For the mechanics behind each step, follow the links to
[agent-orchestrator.md](agent-orchestrator.md) and [dispatch.md](dispatch.md).

## The core loop

Lorenz turns tracker issues into agent runs. It watches a tracker (Linear, Jira, a local board,
Slack) for issues in active states, and for each eligible issue it prepares a workspace, renders a
prompt, and runs a coding agent inside that workspace. It keeps doing this on a fixed cadence until
the issue reaches a terminal state.

There is one control-plane process. It holds a single authoritative in-memory view of everything in
flight (which issues are running, reserved, retrying, or blocked) and feeds that same view to every
dashboard. Each issue gets its own filesystem workspace. Each agent run is one ACP session driving
either Codex or Claude.

<p align="center"><img src="assets/diagrams/system-overview.svg" alt="system overview diagram" width="960" style="width:100%;max-width:960px;height:auto" /></p>
*The control plane polls the tracker, dispatches eligible issues into per-issue workspaces, and runs Codex or Claude over ACP while streaming one snapshot to the dashboards.*

The loop runs at `polling.interval_ms` (default 30000). On each tick the runtime reloads the
workflow, reconciles what is already in flight against the tracker, fetches candidate issues,
computes which are eligible, and dispatches them. Each dispatched issue runs as its own detached
promise, so a slow agent run never stalls the poll loop. The next section walks one tick in order.

## One poll tick

A tick, driven by `LorenzRuntime.pollOnce`, reloads the workflow, validates dispatch config,
reconciles what is already in flight against the tracker, fetches candidate issues, filters to the
eligible set, then dispatches. The exact ordered steps - including the once-only terminal-workspace
cleanup and the stalled-run pass - are spelled out in [agent-orchestrator.md](agent-orchestrator.md).

<p align="center"><img src="assets/diagrams/poll-tick.svg" alt="poll tick diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*One poll tick: reload, validate, reconcile what is in flight, fetch candidates, filter to the eligible set, then dispatch.*

Eligibility is a pure decision. An issue dispatches when its state is active and not terminal, it is
routed to this worker, it has no open blockers (checked only for `unstarted` issues), and a
concurrency cap does not block it. Caps apply in order: the global `agent.max_concurrent_agents`
(default 10), then a per-state cap from `status_overrides`, then worker-host capacity. The dispatch
order is total and deterministic: priority ascending, then `createdAt` ascending, then identifier by
locale compare. The full decision tree lives in [dispatch.md](dispatch.md).

## WORKFLOW.md is config plus prompt

One file defines both how Lorenz is configured and what it tells the agent. `WORKFLOW.md` has YAML
front matter (the orchestrator config: tracker, agents, workspace, polling, workers) and a Markdown
body (the agent session prompt). The body is a Liquid template rendered with the issue's fields, so
the prompt the agent receives is specific to the issue it is working on.

Editing `WORKFLOW.md` while Lorenz runs reloads the config on the next tick. No restart. The reload
is transactional: side effects that can fail run first, and the live config swaps in only if they all
succeed, so a typo never takes down a running deployment. See
[workflows.md](workflows.md) and the
[workflow + prompt reference](reference/workflow-prompt.md) for the full schema.

## Per-issue workspaces

Every issue runs in its own directory under `workspace.root` (default
`<tmpdir>/lorenz_workspaces`), named after a sanitized form of the issue identifier. The workspace is
created on first dispatch and removed when the issue goes terminal.

Four lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`) run around the
work, each via `bash -lc`; see [workspace.md](workspace.md) for what each one does and how failures
are handled. Workspaces are containment-checked against the realpath of `workspace.root`, so a
symlink cannot point an agent's working directory outside the root. Skills are overlaid into
`.lorenz/skills/` with a `.gitignore` of `*` so they are never committed. Workspaces can live locally
or over SSH on a worker host.

## Agents run over ACP

A run is one agent session. Lorenz drives an external bridge subprocess (`codex-acp` or
`claude-agent-acp`) over the Agent Client Protocol. The only built-in executor is `acp`, selected per
agent kind via `agents.<kind>.executor`.

The agent runner builds the workspace, runs `before_run`, opens a session, then loops `runTurn` up to
`agent.max_turns` (default 20). Turn 0 sends the rendered prompt; later turns send a continuation
prompt. Two timers guard each turn: a hard turn timeout (`turn_timeout_ms`, default 3600000) and a
stall timeout (`stall_timeout_ms`, default 300000) reset on every agent event. Either firing cancels
the turn.

Codex and Claude differ only in how Lorenz feeds them provider config and reads token usage; both
ride the same ACP path. The bridge contract, including how Lorenz normalizes each bridge's counts
into session-cumulative token totals, is in [agents/acp-bridges.md](agents/acp-bridges.md), with
per-agent specifics in [agents/codex.md](agents/codex.md) and [agents/claude.md](agents/claude.md).

## Reconciliation keeps the world honest

Lorenz never trusts its in-memory state as the source of truth about issues. Every tick it re-fetches
the issues it thinks are in flight and reconciles them against the tracker: a still-active, routed,
unblocked issue keeps its run, while terminal, unrouted, blocked, or inactive issues get stopped and
cleaned up. A failed re-fetch keeps everything running so a transient tracker outage does not kill
live runs, and a separate stall pass finishes runs that have gone quiet. The per-outcome
classifications and the stall machinery live in [agent-orchestrator.md](agent-orchestrator.md).

## Restart Recovery

With the default in-memory claim store, `OrchestratorState` (running, reserved, claimed, retrying,
completed, usage totals, rate limits, blocked dispatches) is rebuilt from scratch on every boot.
Recovery after a restart is two-sided: the tracker says what still needs doing, so eligible issues
re-dispatch, and the filesystem is reconciled against the tracker so terminal workspaces are swept.
With an explicit durable claim store, retry state and claim ownership hydrate from the store before
the next poll. The exact restart-recovery passes are in [agent-orchestrator.md](agent-orchestrator.md).

The default in-memory mode persists no scheduling state beyond the JSON event log, which is on by default at
`logging.log_file` and writes only when that key is set. This is by design; the tracker plus the
filesystem are enough to recover a clean view of the world.

## Where it all surfaces

Every dashboard reads the same object. The runtime assembles a single `RuntimeSnapshot` and
broadcasts it to all subscribers - the Ink terminal dashboard (TUI), the web dashboard, and the HTTP
API. One snapshot, many views. See [observability.md](observability.md) for what the snapshot carries
(including the bounded recent-events and run-history rings) and [reference/events.md](reference/events.md)
for the event vocabulary.

## See also
- [getting-started.md](getting-started.md) - install Lorenz and run your first workflow
- [agent-orchestrator.md](agent-orchestrator.md) - the poll loop, state machine, and reconciliation in depth
- [dispatch.md](dispatch.md) - eligibility, routing, caps, retries, and the two-phase pool path
- [workspace.md](workspace.md) - workspace layout, hooks, skills, and containment
- [architecture.md](architecture.md) - the package layout and extension points
