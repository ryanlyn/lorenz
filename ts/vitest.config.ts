import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.tsx",
      "extensions/*/test/**/*.test.ts",
      "extensions/*/test/**/*.test.tsx",
      "apps/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.tsx",
      "test/**/*.test.ts",
    ],
    sequence: { concurrent: false },
    testTimeout: 30_000,
  },
});
