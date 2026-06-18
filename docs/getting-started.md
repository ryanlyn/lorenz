# Getting started

This page takes you from nothing installed to your first Lorenz run. It is for operators: you install the CLI, generate a small `WORKFLOW.md`, and watch Lorenz poll a tracker and dispatch an agent. The onboarding wizard defaults to Jira and Claude; choose the local tracker when you want a credential-free first run.

## What you need

- **Node 24 or newer.** The published package declares `engines.node` as `>=24`.
- **Tracker access.** The default is Jira. The local filesystem board (`kind: local`) needs no credentials; external providers need their documented environment or secret references.
- A coding agent on `PATH` for real runs. Claude is the default; set `agent.kind: codex` to use Codex. You can skip the agent for a `--dry-run`, which evaluates candidates without dispatching.

## Install

Lorenz publishes to npm as the unscoped `lorenz` package. You do not clone the repository or build from source. Run the latest published version straight from npm:

```sh
npx lorenz config WORKFLOW.md
```

Or install it globally and call either wizard entrypoint:

```sh
npm install -g lorenz
lorenz config WORKFLOW.md
# Equivalent:
lorenz-config WORKFLOW.md
```

Pin a version with `npx lorenz@<version> config WORKFLOW.md`. Every GitHub release also attaches a runnable tarball. The package bundles the web dashboard and ACP bridges, so one install gives you the wizard, daemon, both dashboards, and the tracker and agent integrations.

The examples below use `npx lorenz`. If you installed globally, drop the `npx` and call `lorenz` directly.

## Generate a workflow

Run the interactive wizard:

```sh
npx lorenz config WORKFLOW.md
```

With no path, it uses `LORENZ_WORKFLOW` and then `./WORKFLOW.md`, matching the daemon. Pressing Enter
on the provider choices selects Jira and Claude. The wizard then asks only for the selected
provider's required setup. Credential prompts default to environment references such as
`$JIRA_API_KEY`; those references are written without being resolved, and API secret prompts reject
literal values.

An existing target is left untouched unless you pass `--force`. Use it only when you intentionally
want to replace the file:

```sh
npx lorenz config --force WORKFLOW.md
```

The standalone `lorenz-config [workflowPath]` binary launches the same wizard with the same
behavior. Both commands require an interactive terminal.

Parser defaults match the wizard: omitted `tracker.kind` selects `jira`, and omitted `agent.kind`
selects `claude`. Explicit values in `WORKFLOW.md` always win.

The wizard configures the tracker and agent. Configure `workspace.root` and lifecycle hooks
separately when agents should work in a cloned or otherwise prepared repository.

## Default path: Jira and Claude

Accept the Jira and Claude choices, enter one or more Jira project keys, and accept or edit the
credential-reference prompts. Then export the referenced values in the shell that will run Lorenz.
A typical environment uses
`JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_KEY`; the generated workflow keeps references such as
`$JIRA_API_KEY`, not the token itself.

Jira issues must be assigned to the active owner and carry the `agent` label before they dispatch.
Run a preflight before starting:

```sh
npx lorenz doctor WORKFLOW.md
npx lorenz --once --dry-run --no-tui WORKFLOW.md
```

See [the Jira tracker](trackers/jira.md) for project/JQL scope and dispatch gating, and
[Claude](agents/claude.md) for the default agent requirements.

## Credential-free path: the local board

The local tracker stores each issue as a single Markdown file named `<prefix><n>.md` (default prefix `BOARD-`) under a board directory (default `.lorenz/local`). No network, no credentials.

### 1. Select the local tracker

Run `npx lorenz config WORKFLOW.md`, choose `local`, and accept Claude or select Codex. The wizard's
explicit selections override the Jira/Claude parser defaults.

### 2. Create a board issue

Make the board directory and a first issue. The format is YAML front matter (at minimum a `status`) followed by a `# Title` and a description:

```md
<!-- .lorenz/local/BOARD-1.md -->
---
status: Todo
---

# Add a healthcheck endpoint

Add a GET /healthz route that returns 200 and the build SHA.
```

`status: Todo` is an active state, so Lorenz picks the issue up; `Done` and `Cancelled` are terminal. The file stem (`BOARD-1`) is the issue identifier.

### 3. Check the generated WORKFLOW.md

A `WORKFLOW.md` has two parts: YAML front matter (config, between two `---` lines) and a Markdown body (the agent prompt, rendered as Liquid). A compact local/Claude workflow looks like this:

```md
---
tracker:
  kind: local
trackers:
  local:
    provider: local
    path: .lorenz/local
agent:
  kind: claude
---
Fix the issue below.

Title: {{ issue.title }}
Description: {{ issue.description }}
```

Prompt variables are snake_case: `issue.title`, `issue.description`, `issue.identifier`, `issue.state`, `issue.branch_name`, and more. Leave the body blank and Lorenz falls back to a built-in default prompt, so a blank prompt is never truly empty.

### 4. Do a safe first run

Before dispatching a real agent, poll once and inspect what Lorenz would pick up:

```sh
npx lorenz --once --dry-run --no-tui WORKFLOW.md
```

- `--once` polls a single time and exits instead of looping.
- `--dry-run` evaluates candidate issues without dispatching an agent.
- `--no-tui` disables the terminal dashboard and prints JSON snapshots to stdout, the form you want for a non-interactive shell or a log.

When the output looks right, run for real:

```sh
npx lorenz WORKFLOW.md
```

Lorenz polls the board, dispatches the agent on each active issue, and writes status and comments back into the `BOARD-<n>.md` files through the `local_*` tools. The board directory the runtime polls and the directory the agent writes to are the same, so keep `trackers.local.path` pointing at the directory that holds your issue files. See [the local board](trackers/local.md) for the file format, the id prefix rules, and the tools.

## Linear quickstart

To use Linear instead of the Jira default, select it in the wizard or set `tracker.kind: linear`
explicitly.

### 1. Set credentials

```sh
export LINEAR_API_KEY=lin_api_...
```

`trackers.linear.api_key` falls back to `LINEAR_API_KEY`, and `trackers.linear.assignee` falls back to `LINEAR_ASSIGNEE`. The literal assignee `me` resolves to the API key's own user.

### 2. Write the workflow

Linear needs exactly one of `project_slugs`, `project_labels`, or `project_slug`. Prefer `project_slugs` (a list); `project_slug` (singular) is the deprecated single-slug form:

```md
---
tracker:
  kind: linear
trackers:
  linear:
    provider: linear
    project_slugs:
      - my-project
agent:
  kind: claude
---
Fix the issue below.

Title: {{ issue.title }}
Description: {{ issue.description }}
```

The default endpoint is `https://api.linear.app/graphql`. Lorenz polls issues in the active states (default `Todo` and `In Progress`) and treats `Closed`, `Cancelled`, `Canceled`, `Duplicate`, and `Done` as terminal.

### 3. Run

```sh
npx lorenz --dry-run --no-tui WORKFLOW.md
```

If the credentials and project resolve, drop the flags to run live. `npx lorenz doctor WORKFLOW.md` validates the workflow, the dispatch config, and that the agent CLI is discoverable before you start.

## What a run looks like

Both dashboards run by default. The web dashboard listens on port `4040` (override with `--port`); the terminal TUI renders when stdout is a TTY. Disable either with `--no-dashboard` or `--no-tui`.

![Lorenz terminal dashboard](images/lorenz-tui.png)

*The TUI shows live issue, agent, and dispatch state in the terminal.*

![Lorenz web dashboard](images/lorenz-dashboard.png)

*The web dashboard serves the same run state over HTTP, with per-run trace history.*

Query completed runs from a separate shell with `lorenz runs` (it reads the same observability API):

```sh
npx lorenz runs --failed --port 4040
```

## How the CLI resolves the workflow

With no path argument, the CLI reads `LORENZ_WORKFLOW` (absolute path used as-is, relative joined to the current directory), then falls back to `./WORKFLOW.md`. The runtime re-reads the workflow before each poll, so edits to config or prompt take effect on the next tick. If a reload fails, the runtime keeps the last good settings and records a `workflow_reload_failed` event. If startup cannot read or parse the workflow, the CLI exits with an error.

## See also

- [CLI](cli.md) - every command and flag, including the config wizard, `runs`, and `doctor`.
- [Workflows](workflows.md) - the full `WORKFLOW.md` format, front matter, and prompt body.
- [Trackers](trackers/index.md) - the tracker backends and how dispatch reads from them.
- [Local board](trackers/local.md) - the on-disk format, tools, and options behind `kind: local`.
- [Linear](trackers/linear.md) - project selection, credentials, and the `linear_graphql` tool.
- [Troubleshooting](troubleshooting.md) - common first-run failures and how to read them.
