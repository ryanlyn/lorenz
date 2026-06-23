// Example out-of-tree tracker provider, authored against @lorenz/tracker-sdk.
//
// It imports ONLY types (`import type`) and stamps a literal `sdkVersion`, so the
// compiled JavaScript carries no @lorenz import: the built extension is a plain,
// zero-runtime-dependency module that lorenz dynamic-imports by path
// (`tracker.kind: ./dist/example-tracker.js`).
import type { TrackerProviderModule } from "@lorenz/tracker-sdk";

export default {
  kind: "example",
  // The loader's sdkVersion handshake checks this against the SDK the running
  // daemon was built with. Import `TRACKER_SDK_VERSION` from the SDK instead if
  // you prefer the constant - that turns it into a runtime dependency.
  sdkVersion: 1,
  createClient: () => ({
    fetchCandidateIssues: async () => [],
    fetchIssuesByIds: async () => [],
  }),
} satisfies TrackerProviderModule;
