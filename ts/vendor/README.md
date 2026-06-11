# Vendored ACP bridges

Symphony-maintained copies of the published ACP bridge packages:

- `codex-acp/` — `@agentclientprotocol/codex-acp` (upstream
  https://github.com/agentclientprotocol/codex-acp)
- `claude-agent-acp/` — `@agentclientprotocol/claude-agent-acp` (upstream
  https://github.com/agentclientprotocol/claude-agent-acp)

Each directory contains the published `dist/` output plus a trimmed
`package.json` (runtime dependencies only). They are pnpm workspace packages;
the workspace root depends on both, so their bins resolve from
`node_modules/.bin/` and the executor resolves the default bridge commands to
them for local spawns.

Local modifications to `dist/` are marked with `symphony-patch` comments.
Search for that marker to find every divergence from upstream:

```sh
grep -rn "symphony-patch" vendor/*/dist
```

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
   capture harness (`sandbox/capture-acp-messages.ts`) for both agents.
