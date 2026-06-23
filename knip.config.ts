import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      entry: ["test/**/*.test.ts"],
      paths: {
        "@lorenz/cli": ["apps/cli/src/index.ts"],
        "@lorenz/cli/runs": ["apps/cli/src/runs.ts"],
        "@lorenz/*": ["packages/*/src/index.ts", "extensions/*/src/index.ts"],
      },
      ignoreDependencies: [
        // Vendored bridges are consumed via their bins at runtime, not imports.
        "@agentclientprotocol/claude-agent-acp",
        "@agentclientprotocol/codex-acp",
        "@lorenz/dispatch",
        "@lorenz/humanize",
        "@lorenz/log-file",
        "@lorenz/orchestrator",
        "@lorenz/policies",
        "@lorenz/projections",
        "@lorenz/retry-scheduler",
        "@lorenz/runtime-events",
        "@lorenz/server",
        "@lorenz/traceviz-emitter",
        "@lorenz/tui",
        "@lorenz/workspace",
        "playwright",
      ],
    },
    "apps/cli": {
      includeEntryExports: true,
    },
    "extensions/local-tracker": {
      includeEntryExports: true,
    },
    "packages/mcp": {
      includeEntryExports: true,
    },
    "packages/*": {
      entry: ["src/index.{ts,tsx}"],
    },
    "extensions/*": {
      entry: ["src/index.{ts,tsx}"],
    },
    // Vendored upstream bridges ship prebuilt dist bundles; knip must not
    // analyze them as source workspaces.
    "vendor/*": {
      entry: [],
      project: [],
      ignoreDependencies: [/.*/],
    },
  },
  ignoreDependencies: ["tsx"],
  ignoreBinaries: ["op", "tar"],
  // Test fixtures consumed by file path (cruised through dependency-cruiser, or
  // compiled by the TypeScript API) rather than statically imported, so knip's
  // static graph cannot see them used.
  ignore: [
    "sandbox/**",
    "test/fixtures/extension-import-boundaries/**",
    "test/fixtures/out-of-tree-extension/**",
  ],
};

export default config;
