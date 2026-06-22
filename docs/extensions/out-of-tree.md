# Ship a worker driver out of tree

This page is for an extension author who has a worker backend - a cloud API, a VM fleet, a container host - and wants Lorenz to provision against it without forking the repo. You write a small module, publish or vendor it, point one config key at it, and the daemon loads it at startup. The driver contract itself is covered in [worker-driver.md](worker-driver.md); this page covers the loading mechanism, the SDK handshake, and the trust boundary you accept by using it.

The whole feature is one idea: `worker.worker_pool.driver` accepts a module specifier as well as a registered kind. A built-in kind (`fake`, `static-ssh`, `docker`) resolves through the registry. Anything else is dynamic-imported, shape-checked, and registered under the exact string you wrote.

## The module specifier

`worker.worker_pool.driver` takes one of two grammars in a single field:

- A registered kind. An exact match in the worker-driver registry always wins, checked before anything is parsed as a module. A published npm package named `docker` can never shadow the built-in `docker` driver.
- A module specifier. Everything that is not an exact registered kind is treated as a reference to a module.

A specifier is one of:

| Form | Example | Resolves through |
| --- | --- | --- |
| npm package name | `acme-worker` | the daemon's module graph |
| scoped package | `@acme/worker` | the daemon's module graph |
| relative path | `./drivers/acme.js` | `dirname(workflow.path)` |
| relative path | `../shared/acme.js` | `dirname(workflow.path)` |
| absolute path | `/opt/lorenz/acme.js` | the filesystem |
| `file:` URL | `file:///opt/lorenz/acme.js` | the filesystem |

Any specifier may carry a `#exportName` suffix to select a named export instead of the default:

```yaml
worker:
  worker_pool:
    driver: "@acme/lorenz-drivers#acmeWorkerDriver"
```

Relative and absolute paths resolve against `baseDir`, which the daemon sets to the directory containing your `WORKFLOW.md` (`dirname(workflow.path)`). Bare package names resolve through the daemon's module graph, so the operator installs your driver package next to Lorenz; `./path` is the escape hatch when installation is not an option.

Two specifier shapes are rejected at parse time:

- An empty specifier or an empty `#` suffix throws `worker_pool_driver_invalid_specifier`.
- A query string (`?`) throws `worker_pool_driver_invalid_specifier`. Cache-busting query strings are not supported, because module code is pinned for the daemon's lifetime (see below).

## Authoring the module with `defineWorkerDriver`

An out-of-tree module exports a `WorkerDriverModule`: a `WorkerDriverFactory` plus the SDK version it targets. Use `defineWorkerDriver` from `@lorenz/worker-sdk`, which shape-asserts the module at definition time and returns it unchanged, so a typo fails in your tests rather than the operator's daemon.

```ts
import { defineWorkerDriver } from "@lorenz/worker-sdk";
import { AcmeWorkerDriver } from "./acme-driver.js";

export default defineWorkerDriver({
  kind: "acme",
  sdkVersion: 1,
  create: (options, deps) => new AcmeWorkerDriver(options, deps),
});
```

The three fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | non-empty string | the driver's self-declared kind, recorded in the audit trail (not the registry key) |
| `sdkVersion` | number | the SDK major version the module targets; must equal `WORKER_DRIVER_SDK_VERSION` |
| `create` | `(options, deps) => WorkerDriver` | factory the pool calls once to construct the driver |

`create` receives the `workers.<name>` options verbatim (minus `driver`) and a `DriverDeps` bundle (`clock`, `logEvent`, `runSsh`). Validate the options fail-loud inside `create`. The `WorkerDriver` you return implements `provision`, `probe`, `destroy`, `list`, and a `capabilities` object; that contract lives in [worker-driver.md](worker-driver.md).

Export the module as the default export, or as a named export selected by a `#name` suffix on the specifier.

## The SDK version handshake

`WORKER_DRIVER_SDK_VERSION` is `1`. The version is major-only: additive, backwards-compatible SDK changes never bump it.

In-repo extensions register their factories directly through the composition root, which vouches for them at build time. A dynamically imported module crosses a version boundary the daemon cannot type-check, so the explicit `sdkVersion` handshake stands in for the compiler. The loader runs `assertWorkerDriverModule` on the imported value before it ever reaches the registry, and rejects:

| Throw | Cause |
| --- | --- |
| `worker_pool_driver_module_invalid` | the value is not an object, `kind` is not a non-empty string, `create` is not a function, or `sdkVersion` is not a number |
| `worker_pool_driver_sdk_mismatch` | `sdkVersion` is a number other than `1` |
| `worker_pool_driver_module_invalid` | the specifier resolved but has no default export and no matching named export |
| `worker_pool_driver_unavailable` | the specifier could not be imported at all (with a did-you-mean hint toward a close registered kind for a bare name) |

Every failure is loud and happens at load time, before the pool, the runtime, or any provision exists. A `sdkVersion` of `2` against a `v1` build does not load a half-working driver; it stops the daemon.

## When loading happens

The daemon calls `ensureWorkerDriverLoaded` in exactly two places:

- At startup, before the worker pool is created.
- On a workflow reload that changes the driver specifier, before `pool.reconcile`, via the coordinator's injected driver loader.

Loading never happens on the acquire path. A run never triggers a dynamic import; by the time the pool leases a worker, the driver is already resolved and constructed.

`ensureWorkerDriverLoaded` is idempotent. A registry hit is a no-op: a built-in kind, an in-repo extension, or a specifier a previous call already loaded. The one observable effect on a repeat is the audit event below.

```yaml
worker:
  worker_pool:
    enabled: true
    driver: "@acme/lorenz-drivers#acmeWorkerDriver"
workers:
  acme:
    driver: "@acme/lorenz-drivers#acmeWorkerDriver"
    region: "us-east-1"
```

Changing the driver CONFIG to a new specifier hot-loads the new module on the next reload. Changing the driver CODE behind an already-loaded specifier does not take effect on reload: Node's ESM cache loads a given specifier's code once per daemon lifetime. To pick up code changes, restart the daemon.

## Audit events

Two events make the loader's decisions observable. Both flow through the standard event log; see [observability.md](../observability.md).

| Event | Fired when | Fields |
| --- | --- | --- |
| `worker_pool_driver_loaded` | a specifier is dynamic-imported and registered for the first time | `specifier`, `kind` (the module's self-declared kind), `sdkVersion`, `resolvedFrom` |
| `worker_pool_driver_module_pinned` | a reload re-encounters a specifier this loader already loaded | `specifier` |

`worker_pool_driver_loaded` records exactly which code went live and where it was imported from. `worker_pool_driver_module_pinned` makes the code-is-pinned semantic observable: it tells you the reload saw your config but reused the cached module rather than re-importing it.

## The trust boundary

A dynamic import runs arbitrary code in the daemon process. This is the same trust boundary as workspace hooks: the module you point at executes with the daemon's full privileges. Treat a third-party driver package the way you treat a hook script.

The boundary is narrowed in three ways:

- Code loads only at startup or on a specifier-changing reload, never on the acquire path. A run cannot cause new code to load.
- The factory is registered under the exact configured specifier string, not the module's self-declared `kind`. The pool resolves `settings.driver` verbatim, so what runs is what you wrote in config.
- The module is pinned for the daemon's lifetime. Once loaded, the code cannot silently change underneath a running daemon; a restart is required to load different code.

For the broader picture of what runs with daemon privileges and how to contain it, see [security.md](../security.md).

## See also

- [worker-driver.md](worker-driver.md) - the `WorkerDriver` contract your module implements
- [security.md](../security.md) - the daemon trust model and what runs with its privileges
- [worker-pool.md](../workers/worker-pool.md) - the warm pool that leases, reaps, and bills the workers your driver provisions
- [extensions/index.md](index.md) - the four extension surfaces and how they register
