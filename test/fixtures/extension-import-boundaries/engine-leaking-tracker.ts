// A MISBEHAVING out-of-tree tracker extension: it reaches past the SDK surface into
// an ENGINE package (`@lorenz/runtime`), the core the extension is meant to extend.
// depcruise's static `extensions-depend-on-sdk-layers-only` rule would catch this
// for an in-tree extension, but a module loaded through the generic loader's
// `import(specifier)` string is invisible to that scan - so the import-boundary
// guard cruises this fixture explicitly and asserts the engine import is FLAGGED.
import { Orchestrator } from "@lorenz/runtime";
import { defineTrackerProvider } from "@lorenz/tracker-sdk";

void Orchestrator;

export default defineTrackerProvider({
  kind: "engine-leaking",
  sdkVersion: 1,
  defaultEndpoint: "https://acme.example",
  createClient() {
    return {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByIds() {
        return [];
      },
    };
  },
});
