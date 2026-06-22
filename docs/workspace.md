# Workspace

Every issue Lorenz works gets its own directory on disk, where the coding agent clones the repo,
installs dependencies, and edits files. This page is for operators who configure where that directory
lives, what bootstrap commands run inside it, and how it is cleaned up. It covers the workspace path
layout, the four lifecycle hooks, root resolution, containment rules, and the skills overlay.

## What a workspace is

A workspace is a per-issue working directory. When Lorenz picks up an issue, it creates one
directory, runs the agent inside it, then removes it. The directory is the agent's current working
directory (`cwd`) for the whole run. Hooks populate it before the agent starts (clone, install,
configure) and tear it down afterward.

The `@lorenz/workspace` package owns this lifecycle. It creates the directory, runs the four hooks,
overlays skill directories, enforces that the agent never escapes the configured root, and deletes
the directory on cleanup. Workspaces can live on the machine running Lorenz or on a remote
[worker](workers/index.md) reached over SSH.

## Where a workspace lives

The path is `<root>/<safe-identifier>[/<slot>]`.

- `<root>` is `workspace.root` (see [Root resolution](#root-resolution)).
- `<safe-identifier>` is the tracker issue identifier with every character outside `[A-Za-z0-9_.-]`
  replaced by `_`. So `ENG-1234` stays `ENG-1234`, but `feat/login` becomes `feat_login`.
- `<slot>` is a numeric slot index, appended only for [ensembles](features/context-ensembles.md)
  (where one issue runs in parallel across several slots) or when co-residence forces it.

The slot suffix rules:

| Case | Path |
| --- | --- |
| Solo run (ensemble size 1) | `<root>/<safe-identifier>` |
| Ensemble (size > 1) | `<root>/<safe-identifier>/<slotIndex>` |
| Forced slot suffix | `<root>/<safe-identifier>/<slotIndex>` (applied unconditionally) |

The forced suffix exists so two slots of the same issue cannot share the bare path on one machine.

Two distinct identifiers that differ only in sanitized characters collapse to the same directory
name. `feat/login` and `feat:login` both become `feat_login`. Lorenz does not otherwise
disambiguate, so keep tracker identifiers distinct in their alphanumeric characters.

## Lifecycle and hooks

Four hooks run at fixed points in the workspace lifecycle. Each is a shell command you set under the
`hooks:` block. All four default to `null` (no command).

| Hook | Config key | When it runs | On failure |
| --- | --- | --- | --- |
| `after_create` | `hooks.after_create` | Once, right after the directory is created | Fail-fast: aborts workspace creation |
| `before_run` | `hooks.before_run` | Once per attempt, before the agent session starts | Fail-fast: aborts the attempt |
| `after_run` | `hooks.after_run` | Once per attempt, after the session ends | Best-effort: logged and ignored |
| `before_remove` | `hooks.before_remove` | Once, before the directory is deleted | Best-effort: caught and ignored |

<p align="center"><img src="assets/diagrams/workspace-lifecycle.svg" alt="workspace lifecycle diagram" width="720" style="width:100%;max-width:720px;height:auto" /></p>
*The per-issue workspace lifecycle: create, after_create, then per-attempt before_run / session / after_run, ending in before_remove and removal. Solid hooks abort on failure; dashed hooks are best-effort.*

Two hooks are fail-fast, two are best-effort. `after_create` and `before_run` abort if they fail or
time out: a broken clone or a failed `npm install` stops the run before the agent wastes a turn on a
half-built tree. `after_run` and `before_remove` swallow failures by design. A failing teardown or
cleanup hook does not surface as a run failure; `after_run` emits a stderr update (`Ignoring
after_run hook failure ...`) and the run proceeds.

`before_run` and `after_run` run once per attempt, not once per agent turn. `before_run` fires after
the workspace is prepared and before the agent session opens, so it wraps the entire turn loop.
`after_run` fires once the loop finishes, in a `finally` block, so it runs whether the attempt
succeeded or failed.

### How hooks execute

Locally, each hook runs as `bash -lc <command>`, a login shell, with the workspace directory as
`cwd`. The subprocess is spawned detached in its own process group so a timeout can kill the whole
group (including any backgrounded children).

Over SSH, the hook runs as `cd <workspace> && <command>` on the worker host. Output is captured with
stdout and stderr merged.

Hook output surfaces as a `hook_execution` event carrying a `HookExecutionMessage` with `status` of
`started`, `completed`, or `failed`. Captured output is truncated to 4096 characters, with a
`[truncated N chars]` suffix and `outputTruncated` / `errorTruncated` flags when it exceeds that.

### Timeout

`hooks.timeout_ms` bounds all four hooks. The default is `60000` (60 seconds).

When a hook exceeds the timeout, Lorenz sends `SIGTERM` to the process group, then `SIGKILL` after a
5000 ms grace, and the hook fails with `hook timed out after <n>ms`. For a fail-fast hook, that
aborts the run.

### Issue templating

Hook commands can reference the issue through a Liquid template. Templating activates only when the
command references `issue.` or `issue[` inside `{{` or `{%` and an issue is present. Otherwise the
command passes through unchanged.

The template engine runs with strict variables and strict filters, so an unknown issue field throws
rather than rendering blank. Every interpolation is shell-escaped by default. Use `| raw` to opt out
of escaping and `| shell_escape` to escape explicitly without double-escaping.

The issue context exposes snake_case keys: `id`, `identifier`, `title`, `description`, `priority`,
`state`, `state_type`, `branch_name`, `url`, `assignee_id`, `blocked_by` (an array of
`{id, identifier, state, state_type}`), `labels`, `assigned_to_worker`, `created_at`, `updated_at`.

### Bootstrap example

A typical `after_create` clones the repo and installs dependencies; a `before_run` checks out the
issue's branch. Set strict shell options so any failed step aborts the fail-fast hook:

```yaml
hooks:
  timeout_ms: 300000
  after_create: |
    set -euo pipefail
    git clone git@github.com:acme/app.git .
    npm ci
  before_run: |
    set -euo pipefail
    git fetch origin
    git checkout -B {{ issue.branch_name }} origin/main
```

`set -euo pipefail` makes the hook exit non-zero on the first failing command, an unset variable, or
a broken pipe, so a fail-fast hook stops the run instead of leaving a half-prepared tree. The default
60-second timeout rarely covers a fresh clone plus install, so raise `hooks.timeout_ms` to fit your
repo.

## Root resolution

`workspace.root` is resolved in this order:

1. `LORENZ_WORKSPACE_ROOT` environment variable, if non-empty.
2. `workspace.root` from your config YAML.
3. Default: `<os.tmpdir()>/lorenz_workspaces`.

The chosen value is expanded before use:

- A leading `~` or `~/` expands against `$HOME` (or `$USERPROFILE`).
- A whole-value `$VAR` expands to that environment variable.

Expansion of `$VAR` is whole-value only. `$HOME` expands, but `$HOME/work` does not: an embedded
variable passes through unexpanded. Only the `~` / `~/` forms get path-prefix treatment. To build a
path under a variable, use the `~/...` form or set the full path in `LORENZ_WORKSPACE_ROOT`.

The workspace block has no snake_case aliases. Write `root` and `isolation` directly. Only the
`hooks` keys have aliases (`after_create`, `before_run`, `after_run`, `before_remove`, `timeout_ms`).

### Remote root resolution

For SSH workers, the unexpanded form of `root` is preserved separately as `rootExpression`. If that
expression is `~` or starts with `~/`, Lorenz looks up `$HOME` on the worker over SSH and joins
against it, rather than reusing the locally expanded path. A `~/lorenz_workspaces` root therefore
resolves to the worker's home directory, not the orchestrator's.

## Containment and safety

The agent's `cwd` must stay inside the configured root. Lorenz realpaths the root and checks every
workspace path against it.

It rejects:

- A blank, newline-containing, or missing `cwd` (`invalid_workspace_cwd`).
- The workspace root itself used as a `cwd` (`refusing to use workspace root as cwd`).
- A path whose canonical form leaves the canonical root via a symlink (`unsafe symlink in workspace
  path` or `workspace outside root`).
- A symlinked root.

Containment relies on realpath, so a symlink pointing out of the root is caught even when the literal
path string looks contained. The check re-runs immediately before each local hook, to catch a `cwd`
swapped under a symlink after creation. On remote workers, a pure-shell canonicalize routine runs the
same check and rejects symlink escapes. See [Security](security.md) for the full threat model.

## Skills overlay

[Skills](agents/skills.md) you configure under `agent.skills` are copied into each workspace at
`.lorenz/skills/<basename>`. The destination is a fixed string and is not configurable through
workspace settings.

Each sync (re)writes a `.gitignore` containing `*` at the skills root, so the agent never commits
overlaid skills. Each source must be a real directory whose entire subtree contains no symlinks. A
symlink anywhere in the tree throws `workspace_skill_source_symlink`; a source that is a file throws
`workspace_skill_source_unsupported`; a missing source throws `workspace_skill_source_missing`.
Sources are de-duplicated, and each sync replaces the target unless source and target already share a
realpath.

For remote workers, the source directory is archived with `tar` and piped over SSH into a guard
script that rejects symlinked parents and targets before extracting. Remote sync needs a valid
positive-integer `worker.ssh_timeout_ms` (default `60000`); a missing or invalid value throws
`invalid_ssh_timeout` before any transfer.

## Ensembles

When an issue carries an `ensemble:<n>` label, Lorenz runs it across `n` slots in parallel, each with
its own workspace at `<root>/<safe-identifier>/<slotIndex>`. Each slot is an independent directory
with its own hook runs, so a `before_run` that checks out a branch runs once per slot. See
[Context ensembles](features/context-ensembles.md) for how slots are scored and merged.

## Shared mode

Set `workspace.isolation` to `none` to run every issue in the root directory itself rather than a
per-issue subdirectory. The default is `per-agent` (isolated workspaces).

In shared mode:

- `createWorkspaceForIssue` returns the root for every issue.
- Lifecycle hooks never run. Configuring any hook is a config error
  (`workspace.isolation = "none" does not support hooks; remove <names>`).
- The root is never auto-removed.
- Skills are still overlaid into the shared root.

Shared mode and hooks are mutually exclusive.

## See also

- [Configuration reference](reference/configuration.md) - every `workspace.*` and `hooks.*` key with defaults
- [Security](security.md) - the containment model and symlink-escape rejection
- [Skills](agents/skills.md) - what skills are and how the `.lorenz/skills` overlay is assembled
- [Context ensembles](features/context-ensembles.md) - per-slot workspaces for parallel attempts
- [Workers](workers/index.md) - running workspaces and hooks on remote SSH hosts
