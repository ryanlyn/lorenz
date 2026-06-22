# Lorenz docs

Lorenz is a control plane that turns tracker issues into coding-agent runs. It watches a tracker (Linear, Jira, a local board, Slack) for issues in active states, prepares an isolated workspace for each one, renders a prompt, and runs Codex or Claude over the Agent Client Protocol until the issue reaches a terminal state. Lorenz derives from [OpenAI's Symphony](https://github.com/openai/symphony). 

## Start here

Pick the path that matches what you came to do.

**Operators and users** running Lorenz against a tracker:

1. [Getting started](getting-started.md)
2. [How it works](how-it-works.md)
3. [Workflows](workflows.md)
4. [CLI](cli.md)
5. [Trackers](trackers/index.md)
6. [Observability](observability.md)
7. [Troubleshooting](troubleshooting.md)

**Extension authors** adding a tracker, tool pack, executor, or worker driver:

1. [Architecture](architecture.md)
2. [Source map](source-map.md)
3. [Extensions](extensions/index.md)
4. [Tracker provider](extensions/tracker-provider.md)
5. [Tool pack](extensions/tool-pack.md)
6. [Agent executor](extensions/agent-executor.md)
7. [Worker driver](extensions/worker-driver.md)

**Integrators and spec readers** who need exact contracts:

1. [Reference](reference/index.md)
2. [Configuration](reference/configuration.md)
3. [Workflow and prompt](reference/workflow-prompt.md)
4. [CLI reference](reference/cli.md)
5. [HTTP API](reference/http-api.md)
6. [Events](reference/events.md)
7. [Tracker tools](reference/tracker-tools.md)
8. [Spec](reference/spec.md)
9. [Glossary](reference/glossary.md)

**Evaluators** deciding whether Lorenz fits:

1. [How it works](how-it-works.md)
2. [Architecture](architecture.md)
3. [Security](security.md)
4. [Roadmap](roadmap/index.md)

## The docs tree

### Top level

- [Getting started](getting-started.md) - fresh checkout to first run
- [How it works](how-it-works.md) - concept-first end-to-end walkthrough
- [Architecture](architecture.md) - layered package graph and extension axes
- [Source map](source-map.md) - which package owns which file
- [CLI](cli.md) - the daemon, `runs`, and `doctor`
- [Workflows](workflows.md) - the `WORKFLOW.md` config and prompt
- [Dispatch](dispatch.md) - eligibility, ordering, routing, caps, retries
- [Workspace](workspace.md) - per-issue directories, hooks, and cleanup
- [Agent orchestrator](agent-orchestrator.md) - poll loop, state, reconciliation
- [Observability](observability.md) - the dashboards and run views
- [Security](security.md) - trust boundary and isolation posture
- [Troubleshooting](troubleshooting.md) - symptoms mapped to cause and fix

### Trackers

- [Overview](trackers/index.md) - what a tracker provides to dispatch
- [Linear](trackers/linear.md) - project selection, credentials, GraphQL tool
- [Jira](trackers/jira.md) - Jira Cloud over REST or MCP
- [Local board](trackers/local.md) - a directory of Markdown issues
- [Slack](trackers/slack.md) - mentions in channels as issues
- [Memory](trackers/memory.md) - in-process fixture from an env var

### Agents

- [Overview](agents/index.md) - the agent kind and executor axes
- [Codex](agents/codex.md) - running Codex as the coding agent
- [Claude](agents/claude.md) - running Claude Code as the coding agent
- [ACP bridges](agents/acp-bridges.md) - the subprocess that runs a turn
- [Skills](agents/skills.md) - reusable playbooks overlaid into the workspace

### Workers

- [Overview](workers/index.md) - host, SSH fleet, or warm pool
- [Static SSH](workers/static-ssh.md) - sharding runs across fixed hosts
- [Worker pool](workers/worker-pool.md) - provisioned, leased, reaped machines
- [Docker](workers/docker.md) - disposable local containers as workers

### Features

- [Overview](features/index.md) - capabilities you turn on in `WORKFLOW.md`
- [Context ensembles](features/context-ensembles.md) - parallel attempts at one issue
- [Dispatch routing](features/dispatch-routing.md) - sharding work with route labels
- [Run history](features/run-history.md) - the `lorenz runs` post-mortem record
- [Secret resolution](features/secret-resolution.md) - keeping credentials out of config
- [Workflow hot reload](features/workflow-hot-reload.md) - tuning config without a restart

### Extensions

- [Overview](extensions/index.md) - the four contracts and the registry pattern
- [Tracker provider](extensions/tracker-provider.md) - recipe for a new tracker backend
- [Tool pack](extensions/tool-pack.md) - recipe for agent-facing tools
- [Agent executor](extensions/agent-executor.md) - recipe for how an agent runs
- [Worker driver](extensions/worker-driver.md) - recipe for provisioning workers
- [Out of tree](extensions/out-of-tree.md) - loading a driver without forking

### Reference

- [Overview](reference/index.md) - the code-accurate contracts index
- [Configuration](reference/configuration.md) - every `WORKFLOW.md` front-matter key
- [Workflow and prompt](reference/workflow-prompt.md) - the Liquid prompt contract
- [CLI](reference/cli.md) - every command, flag, and exit code
- [HTTP API](reference/http-api.md) - routes, WebSocket, and MCP mount
- [Events](reference/events.md) - every event name and when it fires
- [Tracker tools](reference/tracker-tools.md) - the agent tool surface and query DSL
- [Spec](reference/spec.md) - implementation-neutral contract for the service
- [Glossary](reference/glossary.md) - the vocabulary defined once

### Roadmap

- [Roadmap](roadmap/index.md) - what is unwired, reserved, or future work

## Notes

Diagrams render as inline SVG embedded in each page; no external image service or rendering step is involved. The repository [README.md](../README.md) is a short overview; this section is the full documentation.
