/**
 * Architecture enforcement over the real import graph (see docs/ARCHITECTURE.md).
 * Run with `pnpm architecture:check`; render a graph with `pnpm architecture:graph`.
 *
 * Layer model (dependencies must point strictly downward):
 *
 *   apps        apps/*                              - anything
 *   extension   extensions/*                        - SDKs + extension support + leaf
 *   engine      every other packages/*              - engine + SDKs + support + leaf
 *   sdk         packages/{tracker,tool,agent}-sdk   - leaf only
 *   support     packages/issue                      - leaf only
 *   leaf        packages/domain                     - no workspace dependencies
 *
 * Extension membership is by directory: anything under extensions/ gets the extension
 * rules by construction, and the engine (all of packages/) may never import from it.
 *
 * Cross-package imports resolve through pnpm workspace symlinks to the target package's
 * published `dist/` surface (Node `exports` encapsulation forbids anything else at
 * runtime), so layer rules match on path prefixes regardless of whether the edge lands
 * on dist/index.js or a sanctioned subpath export.
 */

const LEAF = "packages/domain/";
const SDK = "packages/(?:tracker-sdk|tool-sdk|agent-sdk)/";
const SUPPORT = "packages/issue/";

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "Import cycles make modules order-sensitive and resist refactoring.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolvable",
      comment:
        "An unresolvable import (e.g. cruising before `pnpm build` produced dist/) would " +
        "silently exempt the edge from every layer rule below.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "cross-package-via-published-surface-only",
      comment:
        "Another workspace package may only be imported through its package name (resolved " +
        "to its built dist/ via the exports map), never by reaching into its src/ files.",
      severity: "error",
      from: { path: "^((?:packages|extensions|apps)/[^/]+)/" },
      to: { path: "^(?:packages|extensions|apps)/[^/]+/src/", pathNot: "^$1/" },
    },
    {
      name: "packages-must-not-import-apps",
      severity: "error",
      from: { path: "^(?:packages|extensions)/" },
      to: { path: "^apps/" },
    },
    {
      name: "leaf-has-no-workspace-dependencies",
      comment: "domain is the dependency root; it imports nothing internal.",
      severity: "error",
      from: { path: "^(packages/domain)/" },
      to: { path: "^(?:packages|extensions|apps)/", pathNot: "^$1/" },
    },
    {
      name: "sdks-depend-on-sdk-layers-only",
      comment:
        "Extension SDKs sit directly on the domain and may build on each other (tracker-sdk " +
        "uses tool-sdk's tool contract; no-circular keeps that a DAG). They stay engine-free.",
      severity: "error",
      from: { path: "^(packages/(?:tracker-sdk|tool-sdk|agent-sdk))/" },
      to: { path: "^(?:packages|extensions|apps)/", pathNot: ["^$1/", `^${LEAF}`, `^${SDK}`] },
    },
    {
      name: "extension-support-depends-on-leaf-only",
      severity: "error",
      from: { path: "^(packages/issue)/" },
      to: { path: "^(?:packages|extensions|apps)/", pathNot: ["^$1/", `^${LEAF}`] },
    },
    {
      name: "extensions-depend-on-sdk-layers-only",
      comment:
        "A provider or tool pack must be implementable from the SDK surface alone; importing " +
        "engine packages would couple extensions to the core they extend.",
      severity: "error",
      from: { path: "^(extensions/[^/]+)/" },
      to: {
        path: "^(?:packages|extensions|apps)/",
        pathNot: ["^$1/", `^${LEAF}`, `^${SDK}`, `^${SUPPORT}`],
      },
    },
    {
      name: "engine-must-not-import-extensions",
      comment:
        "The engine resolves backends through the SDK registries; importing a provider " +
        "would defeat the extension architecture (docs/ARCHITECTURE.md).",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^extensions/" },
    },
  ],
  options: {
    doNotFollow: {
      // Compiled output and externals are edge targets, not traversal roots; the source
      // graph is what we lint.
      path: "node_modules|/dist/",
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "types", "default"],
      mainFields: ["main", "module"],
    },
    exclude: { path: "\\.d\\.ts$" },
    reporterOptions: {
      dot: { collapsePattern: "^(packages|extensions|apps)/[^/]+" },
      mermaid: { minify: false },
    },
  },
};
