# Changelog

## 2026-06-14

- Removed session resumption: deleted the `@symphony/resume-state` package and
  its `.git/symphony/resume.json` persistence, the executor-aware resume
  validation, the ACP `resumeSession`/`loadSession` paths with their replay
  suppression, and the now-redundant `resume_id` field (always a duplicate of
  `session_id`) across the runtime, presenter, dashboard, and run-history
  surfaces. The live provider `session_id` is unchanged.

## 2026-06-09

- Removed the Elixir reference implementation (`elixir/`), leaving the
  TypeScript port as the sole implementation. Dropped the Elixir CI job,
  worktree bootstrap step, and PR-template gate, and relocated the live SSH
  worker Docker fixtures under `ts/test/support/`.

## 2026-05-27

- Tightened TypeScript port runtime fidelity by tracking live elapsed runtime
  for active runs in the TUI and refreshing running-issue tracker state during
  reconcile so dashboard stages follow live state transitions.

## 2026-05-26

- Hardened the TypeScript port with type-aware ESLint
  (`recommendedTypeChecked`), consistent type-import and import-order rules,
  and broad unit plus property-based test coverage across the workspace,
  dispatch, issue, config, orchestrator, resume-state, and auth packages.

## 2026-05-22

- Added 1Password `op://` secret resolution via the `op` CLI, adopted the
  Linear SDK for tracker access, and added a demo setup with a Linear issue
  seed script and a simplified Codex workflow.
- Improved repository ergonomics with pre-commit hooks and a CI TypeScript
  `mise check` job.

## 2026-05-21

- Added a standalone TypeScript port of Symphony under `ts/`, structured as a
  pnpm workspace (`packages/*` plus `apps/cli`) with parity-tested protocol,
  domain, policy, runtime, adapter, presentation, and infrastructure libraries,
  a `symphony-ts` CLI mirroring the Elixir entrypoint, an Ink terminal
  dashboard, a Hono observability server, and pino-based log rotation. The port
  copies the Elixir workflow files byte-for-byte and enforces drift checks
  rather than importing Elixir code.

## 2026-05-03

- Fixed stale retry slot claims so a failed worker no longer strands eligible
  retry issues behind an orphaned claimed slot.
- Removed the deprecated `mcp_server_python` workflow setting and the PR
  description lint workflow.

## 2026-04-30

- Added tracker dispatch routing with Linear route labels (e.g.
  `Symphony:shard-a`), letting multiple Symphony instances split work by
  configured route.

## 2026-04-24

- Decoupled the built-in skills from Codex/Elixir specifics by dropping the
  hard-coded Codex co-author trailer, broadening contributor-guide references,
  and discovering project pre-push validation from repo guides instead of a
  fixed `make -C elixir` gate.

## 2026-04-23

- Inlined the PR body template directly in the `symphony-push` skill.

## 2026-04-09

- Added an orchestrator run history observability CLI exposing completed
  attempts, retries, token totals, and per-run forensic context.
- Excluded dynamic Claude system prompt sections from `--print` runs for a more
  stable stream payload.
- Hardened runtime and dispatch behavior by composing global and per-status
  concurrency caps, caching parsed workflow templates, and bounding workspace
  setup and hook execution with runner-side timeouts.

## 2026-04-07

- Added Context Ensembles with configurable multi-agent issue fan-out,
  per-slot workspaces, prompt and dashboard ensemble context, `ensemble:*`
  label overrides, and a dedicated `WORKFLOW_ENSEMBLE.md` example built around
  independent workpads.
- Replaced the Claude Python MCP sidecar with a built-in `/mcp` endpoint,
  giving the Claude executor shared tool serving, authenticated remote worker
  access, and matching Codex/Claude tool behavior.

## 2026-04-06

- Hardened unattended runtime behavior by defaulting the bundled workflow to
  Codex `workspace-write` sandboxing, honoring Linear `Retry-After` backoff on
  `429` responses, tightening remote workspace path validation, and improving
  orchestrator poll scheduling and restart handling.
- Improved Claude executor parity and safety by passing rendered issue context
  into Claude turns, aligning timeout behavior with Codex inactivity semantics,
  keeping injected Linear MCP credentials out of generated config, and
  tightening workspace validation and partial-startup cleanup.
- Strengthened session resumption by requiring explicit executor kind in resume
  state.
- Improved observability with status dashboard fixes for embedded asset
  fingerprinting and configured-orchestrator snapshot handling.
- Tightened workflow/config behavior by preserving the last known good
  orchestrator state on invalid reloads, fixing workflow init and agent-kind
  handling, and respecting Linear unstarted state types during blocker checks.

## 2026-04-03

- Added the Claude Code executor as an alternative agent backend, including
  agent-level executor abstraction, Claude-specific resume handling, MCP
  sidecar generation, dashboard integration, and live Claude resume coverage.

## 2026-03-31

- Added Codex session resumption for Git-backed workspaces via
  `.git/symphony/resume.json`.
- Added local `.claude` and `.codex` repo settings for agent tooling.
- Split the example workflow into full-access and sandboxed variants.

## 2026-03-28

- Improved local developer ergonomics by removing the CLI guardrails
  acknowledgement flag requirement, running local hooks with `bash` when
  available, inheriting app-server environment on local launch, and routing
  nested `mix` invocations through `mise`.

## 2026-03-27

- Renamed built-in skills to the `symphony-*` namespace and updated workflow
  references to match.
