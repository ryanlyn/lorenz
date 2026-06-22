# Security and trust posture

What Lorenz trusts, what it isolates, and what it leaves to you. This page is for operators and evaluators deciding whether Lorenz fits a given threat model. The honest summary: Lorenz is a high-trust harness. The workflow file is executable code, the agent runs with broad host access, and several layers assume the inputs reaching them are not adversarial. The [SPEC](reference/spec.md) requires every implementation to document this posture explicitly, and this page is that document.

## The trust boundary

The orchestrator is a scheduler and tracker reader, not a policy sandbox. Three things execute with the same authority as the daemon process.

- **Workflow hooks.** The four lifecycle hooks (`after_create`, `before_run`, `after_run`, `before_remove`) in [`WORKFLOW.md`](workflows.md) run as arbitrary shell through `bash -lc` (a login shell) with the workspace as the working directory. The SPEC states it plainly: hooks are fully trusted configuration. Anyone who can edit `WORKFLOW.md` can run code on the host.
- **The coding agent.** The agent (Codex or Claude) runs commands and edits files inside the workspace. Lorenz auto-approves its permission requests by default (see [Approval gating](#approval-gating-what-lorenz-does-not-do) below).
- **Out-of-tree worker drivers.** When `worker.worker_pool.driver` names a module specifier instead of a built-in kind, Lorenz dynamic-imports that module into the daemon process at startup or reload. This is the same trust boundary as hooks: arbitrary code in the daemon, not a plugin sandbox.

Treat `WORKFLOW.md` and any out-of-tree driver as you would treat the daemon's own source. Review them. Restrict who can push to them. Do not run a workflow you would not run by hand.

<!-- DIAGRAM: none assigned to this page -->

## Out-of-tree driver loading

The worker pool can load a driver from outside the repo by module specifier (`worker.worker_pool.driver: ./my-driver.ts#myExport`, an npm package name, a `@scope/name`, a `/absolute` path, or a `file:` URL). The loader (`apps/cli/src/workerDriverLoader.ts`) constrains this in ways worth knowing.

- **Loads only at startup and reload, never on the acquire path.** A module is imported when the daemon boots and again only if a reload changes the specifier string. It is never imported while leasing a worker. Module code is pinned for the daemon lifetime: changing the code requires a restart, only changing the config to a new specifier hot-loads.
- **An exact built-in kind always wins.** The loader checks the registry for the literal kind first, so a published npm package named `docker` cannot shadow the built-in `docker` driver.
- **The load is audited.** A successful load emits `worker_pool_driver_loaded`; the pinned module emits `worker_pool_driver_module_pinned`. Cache-busting query strings are rejected with `worker_pool_driver_invalid_specifier`, and an SDK-version mismatch throws `worker_pool_driver_sdk_mismatch` (the SDK is pinned at major version `1`).

The driver is registered under the exact configured specifier string, not the module's self-declared `kind`. See [Out-of-tree extensions](extensions/out-of-tree.md) for the full loading contract.

## Secret handling

Secrets are resolved at config-parse time, not baked into `WORKFLOW.md`. The resolution order in `resolveConfiguredSecret` (`packages/config/src/parse.ts`) is fixed:

1. If a value is exactly `$VAR` (the whole string matches `^\$[A-Za-z_][A-Za-z0-9_]*$`), it is replaced by `env[VAR]`, or the empty string if unset. Substring interpolation is not done: `$HOME/x` passes through unexpanded.
2. If that yields nothing, the provider's env fallback applies (for example `LINEAR_API_KEY` for Linear, `JIRA_API_KEY` for Jira).
3. Any remaining `op://` value is read through the 1Password CLI: an `op --version` probe, then `op read <ref>`. A bare `op://` fallback resolves even with no inline value set.

The intent is that secrets live in the environment or in 1Password, and `WORKFLOW.md` holds only the reference. Keep literal API keys out of the committed file. The 1Password path shells out to `op` on `PATH`; its absence throws a specific message, and a failed `op read` throws `Failed to resolve 1Password reference: <ref>`. Tool-pack option values (`tools.<pack>.*`) and tracker credentials go through the same resolver, so string options can also carry `$VAR` / `op://`.

See [Secret resolution](features/secret-resolution.md) for the decision tree and examples.

## Workspace containment

Each issue gets a directory under `workspace.root`. The [workspace](workspace.md) layer keeps every path inside that root and rejects escapes.

- `validateWorkspaceCwd` / `ensureInsideRoot` realpath the root and the target and reject a blank or newline-containing path (`invalid_workspace_cwd`), the root itself used as a cwd (`refusing to use workspace root as cwd`), a symlink that escapes the canonical root (`unsafe symlink in workspace path`), and a path resolving outside the root (`workspace outside root`).
- Containment is re-checked immediately before each local hook launch, so a cwd swapped to an out-of-root symlink between validation and execution is caught.
- `safeIdentifier` sanitizes the tracker identifier into the directory name by replacing every character outside `[A-Za-z0-9_.-]` with `_`. Two identifiers differing only in stripped characters collide on the same directory; identifiers are not otherwise disambiguated.
- Skill overlay sources must be real directories with no symlink anywhere in their subtree (`rejectSourceTreeSymlinks`), or the sync throws `workspace_skill_source_symlink`. A skill that is a file throws `workspace_skill_source_unsupported`. Overlaid skills land in `.lorenz/skills/` with a `.gitignore` of `*` so they are never committed.

Hook subprocesses are spawned detached in their own process group. On timeout (`hooks.timeout_ms`, default `60000`) Lorenz sends `SIGTERM` to the whole group, then `SIGKILL` after a `5000ms` grace, so a hook that backgrounds children cannot leak them. Hook output is truncated to `4096` characters in logs.

## SSH worker access

When work runs on a remote worker host, hooks and the agent execute over SSH (`packages/ssh/src/index.ts`). SSH inherits the host's own trust: Lorenz runs `cd <workspace> && <command>` on the worker under whatever credentials the SSH config provides.

- The `LORENZ_SSH_CONFIG` environment variable is passed to `ssh` as `-F <path>`, letting you pin host keys, identities, jump hosts, and `ProxyCommand` per deployment without touching the workflow.
- Remote commands run in a detached process group; on timeout (`worker.ssh_timeout_ms`, default `60000`) the entire group is `SIGTERM`ed then `SIGKILL`ed after `5000ms`.
- Remote workspace root resolution expands `~` / `$HOME` against the worker's `$HOME` over SSH, not the local one, so a remote root cannot be aliased to a local path by accident.

Two unrelated config surfaces share the "static SSH" name: the legacy `worker.ssh_hosts` list (pre-existing destinations the runtime shards across, no provisioning) and the `static-ssh` worker-pool driver. They are mutually exclusive in config. See [Static SSH workers](workers/static-ssh.md).

## MCP endpoint authentication

Agents reach tracker tools over an HTTP MCP endpoint at `POST /mcp`. Every request is authenticated.

- **Per-agent leased bearer tokens.** Each agent run leases an endpoint that carries a random base64url token in an `Authorization: Bearer <token>` header. A request without a valid token gets `401 {error:{code:'unauthorized'}}`.
- **Scoped tokens.** A token is valid only for the scope `mcp:<sha256(identity)>`, derived from the server host, port, full tracker config, and canonicalized tool options. Any settings change rotates the scope and invalidates tokens minted for the old one.
- **In-memory only.** Tokens live in a process-local map. They do not persist across restarts and are not shared across processes.
- **Remote tunnels.** For workers, the endpoint is reached through an SSH reverse tunnel (`ssh -R`) managed per run by `@lorenz/worker-host-pool`, so the token never traverses an open network port.

The endpoint binds to `server.host` (default `127.0.0.1`). A failed tool call is returned as data (`isError: true` inside an HTTP 200 JSON-RPC result), not as a transport error, so a misbehaving tool cannot crash the seam. See the [HTTP API reference](reference/http-api.md) and [tracker tools](reference/tracker-tools.md).

## The Codex sandbox default

The vendored `codex-acp` bridge runs Codex in its `Agent` mode by default (`DEFAULT_AGENT_MODE`). That mode is `workspace-write`: the agent may read and edit files in the workspace and run commands, with `networkAccess: false` and approvals set to `on-request`. Because Lorenz auto-approves those requests (next section), the practical effect is workspace-scoped writes with no network, no approval prompts.

A workflow can widen this to `agent-full-access` (`danger-full-access`), which lets Codex edit files outside the workspace and run commands with network access. That is a deliberate, documented step up in blast radius. The default is the narrower mode; do not move to full access without a reason.

Claude sessions are configured through a `provider_config` overlay (settings.json shape) rather than a sandbox mode. The default Claude record sets `provider_config.permissions.defaultMode = 'dontAsk'`; the vendored `claude-agent-acp` bridge additionally disallows the `AskUserQuestion` tool for every Claude session, independent of the record. See [Codex](agents/codex.md) and [Claude](agents/claude.md) for the per-agent details.

## Slack bot_user_id gating

The [Slack tracker](trackers/slack.md) requires `tracker.bot_user_id` (or the `SLACK_BOT_USER_ID` environment variable). Without it, the Slack tool ops throw `slack tools are unavailable: tracker.bot_user_id (or SLACK_BOT_USER_ID) is not configured`.

This is a safety gate, not a formality. The mention matcher (`isBotMention`) only treats a message as work when it mentions that specific bot user id. If `bot_user_id` is unset, the matcher falls back to matching any `<@...>` mention, so any human-to-human mention in a watched channel could spawn an agent run. Setting `bot_user_id` scopes dispatch to messages that explicitly address the bot.

## Approval gating: what Lorenz does not do

The SPEC lists "mandating strong sandbox controls beyond what the coding agent and host OS provide" and "mandating a single default approval, sandbox, or operator-confirmation posture" as explicit non-goals. Lorenz follows that. Concretely, there is no built-in approval gate beyond the agent's own sandbox mode and the host OS.

- **Permission requests are auto-approved.** The ACP executor selects the first option whose kind starts with `allow` and emits `approval_auto_approved`. It does not pause for an operator. If no allow option exists, it emits `approval_required` and returns a cancelled outcome.
- **No human-in-the-loop confirmation step.** Lorenz does not prompt before a hook runs, before a command executes, or before a ticket write. Ticket writes happen through agent tooling, governed by the workflow prompt, not a Lorenz policy.
- **No per-issue eligibility filter beyond dispatch routing.** Lorenz dispatches on tracker state and labels. It does not vet whether an issue's content is trusted before the agent reads it.

The SPEC frames harness hardening as part of the core safety model, not an afterthought, and points to deployment-specific controls Lorenz does not ship: OS/container/VM isolation, network restrictions, separate credentials, and tracker-source filtering. Those are yours to add.

## Hardening checklist

For an operator standing up a deployment, in rough priority order:

- **Lock down `WORKFLOW.md`.** Treat it as production code. Require review on changes; restrict who can push to the branch the daemon reads.
- **Vet out-of-tree drivers.** Review any module behind `worker.worker_pool.driver`. Pin it. Audit `worker_pool_driver_loaded` events.
- **Keep secrets out of the file.** Use `$VAR` env references or `op://` 1Password references. Never commit literal keys.
- **Run on dedicated, low-privilege hosts.** Hooks and agents run with the daemon's authority. Give that process the minimum filesystem, credential, and network access the workflow needs.
- **Keep the Codex default sandbox.** Stay on `workspace-write` unless a workflow genuinely needs `agent-full-access`. Reserve network access and out-of-workspace writes for cases that require them.
- **Add external isolation.** Containerize or VM-isolate the worker. Restrict outbound network. Use separate credentials per deployment.
- **Set `bot_user_id` for Slack.** Always configure it so only mentions of the bot trigger runs.
- **Bind the MCP endpoint narrowly.** Keep `server.host` on `127.0.0.1` unless a remote tunnel requires otherwise; rely on the per-run SSH reverse tunnel for worker access rather than exposing the port.
- **Pin SSH host keys.** Point `LORENZ_SSH_CONFIG` at a hardened config with known hosts and explicit identities.
- **Filter dispatch.** Use [dispatch routing](features/dispatch-routing.md) (`tracker.dispatch.only_routes`, label prefixes) so out-of-scope or untrusted issues do not automatically reach an agent.
- **Run `lorenz doctor`.** Validate the workflow and prerequisites before going live.

## See also
- [Workspaces](workspace.md) - containment rules, hook execution, and the skill overlay in full
- [Workflows](workflows.md) - the `WORKFLOW.md` contract that hooks and config live in
- [Secret resolution](features/secret-resolution.md) - `$VAR` / `op://` / env-fallback order
- [Out-of-tree extensions](extensions/out-of-tree.md) - the dynamic-import loading contract
- [SPEC](reference/spec.md) - the trust-and-safety requirements this page documents
