import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      entry: ["test/**/*.test.ts"],
      paths: {
        "@symphony/cli": ["apps/cli/src/index.ts"],
        "@symphony/cli/runs": ["apps/cli/src/runs.ts"],
        "@symphony/*": ["packages/*/src/index.ts"],
      },
      ignoreDependencies: [
        "@symphony/dispatch",
        "@symphony/humanize",
        "@symphony/log-file",
        "@symphony/memory-tracker",
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
        "@symphony/workflow",
        "@symphony/workspace",
        "playwright",
      ],
    },
    "apps/cli": {
      includeEntryExports: true,
    },
    "packages/local-tracker": {
      includeEntryExports: true,
    },
    "packages/mcp": {
      includeEntryExports: true,
    },
    "packages/*": {
      entry: ["src/index.{ts,tsx}"],
    },
  },
  ignoreDependencies: ["tsx"],
  ignoreBinaries: ["op"],
  ignore: ["sandbox/**"],
};

export default config;
