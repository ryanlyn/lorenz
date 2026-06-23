# Write your own extension out of tree

Lorenz has four extension surfaces - trackers, tool packs, agent executors, and worker drivers (see [extensions/index.md](index.md)). A surface is normally a package wired in at the composition root. But any surface whose config selector accepts a module specifier can also be loaded from a module you point config at, with no fork and no composition-root edit: you write a small module, reference it by path or package name, and the daemon loads it at startup.

The runtime contract is structural, so the smallest extension is a plain object with no build dependency on Lorenz at all. The typed SDKs exist only to give you the contract types and an optional `define*` helper while you author; they are erased from a normally-built extension.

## What is loadable today

| Surface | Config selector | Types package | Status |
| --- | --- | --- | --- |
| Tracker provider | `tracker.kind` | `@lorenz/tracker-sdk` | loadable by specifier |
| Worker driver | `worker.worker_pool.driver` | `@lorenz/worker-sdk` | loadable by specifier |
| Tool pack | (none yet) | `@lorenz/tool-sdk` | the SDK and loader exist; no config selector reads a specifier yet |
| Agent executor | (none yet) | `@lorenz/agent-sdk` | the SDK and loader exist; no config selector reads a specifier yet |

The mechanism is identical across surfaces. This page uses a tracker for the worked example and a worker driver for some config samples; where a name reads `tracker_provider`, substitute the per-surface error prefix (`worker_pool_driver`, and so on).

## The module specifier

A config selector takes one of two grammars in a single field:

- A registered kind. An exact match in the registry always wins, checked before anything is parsed as a module, so a published package named `docker` can never shadow the built-in `docker` driver.
- A module specifier. Everything that is not an exact registered kind is treated as a reference to a module.

| Form | Example | Resolves through |
| --- | --- | --- |
| relative path | `./trackers/acme.js` | the `WORKFLOW.md` directory |
| relative path | `../shared/acme.js` | the `WORKFLOW.md` directory |
| absolute path | `/opt/lorenz/acme.js` | the filesystem |
| `file:` URL | `file:///opt/lorenz/acme.js` | the filesystem |
| npm package name | `acme-tracker` | the daemon's module graph |
| scoped package | `@acme/tracker` | the daemon's module graph |

Path specifiers (`./`, `../`, absolute, `file:`) resolve against the directory containing your `WORKFLOW.md` and need nothing installed: this is the local-authoring path - build your extension to a `.js` file next to your workflow and point at it. Bare package names resolve through the daemon's own module graph, so they require the package to be installed where the daemon can resolve it; reach for a bare name when you publish your extension. Any specifier may carry a `#exportName` suffix to select a named export.

```yaml
tracker:
  kind: ./trackers/acme.js            # a local file, nothing installed
# or
  kind: "@acme/lorenz-trackers#acme"  # an installed package, named export
```

An empty specifier, an empty `#` suffix, or a `?` query string is rejected at parse time. Cache-busting query strings are unsupported because module code is pinned for the daemon's lifetime (see [When loading happens](#when-loading-happens)).

## Authoring the module

The runtime checks the loaded module STRUCTURALLY: it must be an object carrying the surface's identity field (`kind` for trackers and drivers, `name` for tool packs, `executor` for executors), the surface's required hook functions, and a numeric `sdkVersion`. Nothing in that contract requires importing Lorenz at runtime.

### Zero-dependency: a typed plain object

Install the surface's SDK as a dev dependency for the TYPES only, write the module with `satisfies`, and stamp a literal `sdkVersion`. The types are erased at build, so the emitted JavaScript imports nothing from Lorenz:

```ts
import type { TrackerProviderModule } from "@lorenz/tracker-sdk";

export default {
  kind: "acme",
  sdkVersion: 1,
  createClient: (settings) => new AcmeClient(settings),
} satisfies TrackerProviderModule;
```

This is the recommended shape for a local extension: it builds to a self-contained `.js` file you point `tracker.kind` at, with no install on the operator side. A runnable example and a test that proves the built output carries no `@lorenz` import live in `test/fixtures/out-of-tree-extension/`.

### With the `define*` helper

If you would rather have the SDK shape-assert your module at definition time, so a typo fails in your tests instead of the operator's daemon, use the axis `define*` helper. It is a runtime function, so it adds a runtime dependency on the SDK (install it as a regular dependency, or bundle it into your build):

```ts
import { defineWorkerDriver, WORKER_DRIVER_SDK_VERSION } from "@lorenz/worker-sdk";

export default defineWorkerDriver({
  kind: "acme",
  sdkVersion: WORKER_DRIVER_SDK_VERSION,
  create: (options, deps) => new AcmeWorkerDriver(options, deps),
});
```

Export the module as the default export, or as a named export selected by a `#name` suffix on the specifier. The per-surface contracts - which hooks a module must implement - live with each surface: [worker-driver.md](worker-driver.md) for drivers, and the `TrackerProvider`, `ToolProvider`, and `AgentExecutorProvider` types in their SDKs for the rest.

## The SDK version handshake

Each SDK exports a major-only version constant (`TRACKER_SDK_VERSION`, `WORKER_DRIVER_SDK_VERSION`, and so on), currently `1`. Additive, backwards-compatible SDK changes never bump it.

In-repo extensions register through the composition root, which vouches for them at build time. A dynamically imported module crosses a version boundary the daemon cannot type-check, so the `sdkVersion` handshake stands in for the compiler. The loader runs `assert<Surface>Module` on the imported value before it reaches the registry, and rejects, loudly and at load time:

| Throw | Cause |
| --- | --- |
| `<prefix>_module_invalid` | the value is not an object, the identity field is not a non-empty string, a required hook is not a function, or `sdkVersion` is not a number |
| `<prefix>_sdk_mismatch` | `sdkVersion` is a number other than the one this build supports |
| `<prefix>_module_invalid` | the specifier resolved but has no default export and no matching named export |
| `<prefix>_unavailable` | the specifier could not be imported at all (with a did-you-mean hint toward a close registered kind for a bare name) |

A `sdkVersion` of `2` against a `v1` build does not load a half-working extension; it stops the daemon before the runtime exists.

## When loading happens

The daemon loads a specifier in exactly two places: at startup, before the runtime is built, and on a workflow reload that CHANGES the specifier. Loading never happens on a hot path; a run never triggers a dynamic import.

Resolution is idempotent. A registry hit - a built-in kind, an in-repo extension, or a specifier a previous call already loaded - is a no-op. Changing the config to a new specifier hot-loads the new module on the next reload. Changing the CODE behind an already-loaded specifier does not take effect, because Node's ESM cache loads a specifier's code once per daemon lifetime; restart the daemon to pick up code changes.

## Audit events

Two events make the loader's decisions observable (see [observability.md](../observability.md)):

| Event | Fired when | Fields |
| --- | --- | --- |
| `<prefix>_loaded` | a specifier is dynamic-imported and registered for the first time | `specifier`, `kind`, `sdkVersion`, `resolvedFrom` |
| `<prefix>_module_pinned` | a reload re-encounters a specifier already loaded | `specifier` |

## The trust boundary

A dynamic import runs arbitrary code in the daemon process, with the daemon's full privileges - the same trust boundary as workspace hooks. Treat a third-party extension package the way you treat a hook script. The boundary is narrowed three ways: code loads only at startup or on a specifier-changing reload, never on a hot path; the module is registered under the exact configured specifier string, not its self-declared identity, so what runs is what you wrote in config; and the module is pinned for the daemon's lifetime, so its code cannot change under a running daemon. See [security.md](../security.md) for the broader daemon trust model.

## See also

- [extensions/index.md](index.md) - the four extension surfaces and how the built-in set registers
- [worker-driver.md](worker-driver.md) - the `WorkerDriver` contract a driver module implements
- [security.md](../security.md) - the daemon trust model and what runs with its privileges
- [worker-pool.md](../workers/worker-pool.md) - the warm pool that leases the workers a driver provisions
