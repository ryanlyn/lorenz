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

- `usage_update` notification `_meta["symphony/callUsage"]` — per-model-call
  token bucket, emitted as each call completes (both bridges).
- `usage_update` notification `_meta["symphony/totalUsage"]` (codex only) —
  the thread-cumulative counter, used as a floor so missed buckets cannot
  under-count a session. Claude has no equivalent running counter; its turn
  aggregate arrives as `PromptResponse.usage` and reconciles at turn end.
- `session/new`, `session/resume`, `session/load` request
  `_meta["symphony/config"]` (codex) — per-session codex config overrides
  (same shape as `config.toml`), merged into the thread config.
- `session/new` request `_meta["symphony/settings"]` (claude) — per-session
  settings overlay (same shape as `settings.json`), merged over the resolved
  file settings so `model`, `permissions.defaultMode`, `effortLevel`, and
  `availableModels` work without writing settings files into the workspace.

## Refreshing from upstream

1. Save the current patch set as a 3-way-applicable diff. `<pristine>` is the
   commit that last vendored an unpatched dist (`git log ts/vendor` shows the
   chore(vendor) refresh commits):

   ```sh
   git diff <pristine> HEAD -- ts/vendor/<name>/dist > /tmp/<name>.patch
   ```

2. `npm pack @agentclientprotocol/<name>@<version>` and extract `dist/`,
   `LICENSE`, `README.md` over the vendored directory. Exact-version pack
   bypasses npm release-age cooldowns; the vendored package's *dependencies*
   do not, so pick the newest bridge version whose dependency pins are at
   least as old as the active cooldown window. The repo ignores `dist/`
   globally, so stage any newly added dist files with `git add -f`.
3. Update `version` and `dependencies` in the vendored `package.json` from the
   published manifest (keep `private: true` and the trimmed shape).
4. `git add ts/vendor` (the index must hold the new pristine dist), then
   `git apply -3 /tmp/<name>.patch` and resolve any conflicts; verify with
   `grep -c symphony-patch` and `node --check`.
5. `pnpm install`, `pnpm build`, run the acp executor tests, and run the live
   capture harness (`sandbox/capture-acp-messages.ts`) for both agents:
   bucket sums must equal the turn-end totals and no `.codex/config.toml` or
   `.claude/settings.local.json` may appear in the workspace.
