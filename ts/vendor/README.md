# Vendored ACP bridges

Symphony-maintained copies of the published ACP bridge packages, carrying local
extensions that the upstream protocol does not provide:

- `codex-acp/` — `@agentclientprotocol/codex-acp` (upstream
  https://github.com/agentclientprotocol/codex-acp)
- `claude-agent-acp/` — `@agentclientprotocol/claude-agent-acp` (upstream
  https://github.com/agentclientprotocol/claude-agent-acp)

Each directory contains the published `dist/` output plus a trimmed
`package.json` (runtime dependencies only). They are pnpm workspace packages;
the workspace root depends on both, so their bins resolve from
`node_modules/.bin/` and Symphony's default agent config points at them.

## Symphony extensions

Local modifications to `dist/` are marked with `symphony-patch` comments.
Search for that marker to find every divergence from upstream:

```sh
grep -rn "symphony-patch" vendor/*/dist
```

Extensions are namespaced under `_meta` keys (`symphony/...`) on ACP messages
so they ride the protocol's sanctioned extension point:

- `usage_update`(notification) `_meta["symphony/callUsage"]` — per-model-call
  token bucket, emitted as each call completes.
- `usage_update` `_meta["symphony/totalUsage"]` (codex) and
  `_meta["symphony/turnUsage"]` (claude) — aggregate counters used for
  turn-end reconciliation.
- `session/new`, `session/resume`, `session/load` request
  `_meta["symphony/config"]` (codex) — per-session codex config overrides
  (same shape as `config.toml`), merged into the thread config.

## Refreshing from upstream

1. `npm pack @agentclientprotocol/<name>@<version>` and extract `dist/`,
   `LICENSE`, `README.md` over the vendored directory. The repo ignores
   `dist/` globally, so stage any newly added dist files with `git add -f`
   (already-tracked files commit normally).
2. Update `version` and `dependencies` in the vendored `package.json` from the
   published manifest (keep `private: true` and the trimmed shape).
3. Re-apply the `symphony-patch` blocks (diff against git history for the
   previous patched dist).
4. `pnpm install`, then run the acp executor tests and the live capture
   harness (`sandbox/capture-acp-messages.ts`) for both agents.
