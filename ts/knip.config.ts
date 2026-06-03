import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      entry: ["test/**/*.test.ts"],
      ignoreDependencies: [
        "@symphony/dispatch",
        "@symphony/humanize",
        "@symphony/log-file",
        "@symphony/mcp",
        "@symphony/memory-tracker",
        "@symphony/orchestrator",
        "@symphony/policies",
        "@symphony/projections",
        "@symphony/retry-scheduler",
        "@symphony/runtime-events",
        "@symphony/server",
        "@symphony/ssh",
        "@symphony/traceviz-emitter",
        "@symphony/traceviz-server",
        "@symphony/tui",
        "@symphony/worker-host-pool",
        "@symphony/workflow",
        "@symphony/workspace",
        "playwright",
      ],
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
