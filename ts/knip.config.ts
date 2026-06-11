import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      entry: ["test/**/*.test.ts"],
      paths: {
        "@symphony/cli": ["apps/cli/src/index.ts"],
        "@symphony/cli/runs": ["apps/cli/src/runs.ts"],
        "@symphony/*": ["packages/*/src/index.ts", "extensions/*/src/index.ts"],
      },
      ignoreDependencies: [
        // Vendored bridges are consumed via their bins at runtime, not imports.
        "@agentclientprotocol/claude-agent-acp",
        "@agentclientprotocol/codex-acp",
        "@symphony/dispatch",
        "@symphony/humanize",
        "@symphony/log-file",
        "@symphony/orchestrator",
        "@symphony/policies",
        "@symphony/projections",
        "@symphony/retry-scheduler",
        "@symphony/runtime-events",
        "@symphony/server",
        "@symphony/ssh",
        "@symphony/traceviz-emitter",
        "@symphony/tui",
        "@symphony/worker-host-pool",
        "@symphony/workspace",
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
  ignoreBinaries: ["op"],
  ignore: ["sandbox/**"],
};

export default config;
