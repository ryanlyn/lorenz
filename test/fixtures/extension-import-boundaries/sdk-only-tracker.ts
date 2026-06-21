// A well-behaved out-of-tree tracker extension: it is implementable from the SDK
// surface plus the domain leaf alone. The import-boundary guard
// (test/extension-import-boundaries.test.ts) cruises this fixture and asserts it
// touches ONLY the SDK + domain layers, the same contract depcruise's
// `extensions-depend-on-sdk-layers-only` rule enforces for in-tree extensions but
// which is invisible for code reached through the loader's opaque
// `import(specifier)` string.
import { defineTrackerProvider } from "@lorenz/tracker-sdk";
import type { Issue } from "@lorenz/domain";

export default defineTrackerProvider({
  kind: "sdk-only",
  sdkVersion: 1,
  defaultEndpoint: "https://acme.example",
  createClient() {
    return {
      async fetchCandidateIssues(): Promise<Issue[]> {
        return [];
      },
      async fetchIssuesByIds(): Promise<Issue[]> {
        return [];
      },
    };
  },
});
