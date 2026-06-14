import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertWorkerDriverModule,
  type WorkerDriverModule,
  type WorkerDriverRegistry,
} from "@symphony/worker-sdk";

/**
 * Out-of-tree worker-driver loading: the configured worker-pool driver accepts a MODULE
 * SPECIFIER (an npm package name, `@scope/name`, `./relative` or `/absolute`
 * path, with an optional `#exportName` suffix) in addition to a registered
 * kind. The daemon dynamic-imports the module at startup (and on a reload that
 * changes the specifier) and registers it into the worker-driver registry under
 * the EXACT configured string, so the pool's existing registry resolution
 * (`registry.require(settings.driver)`) needs no changes and third parties
 * ship drivers without forking the repo.
 *
 * Trust: a dynamic import runs arbitrary code in the daemon process - the same
 * trust boundary as workspace hooks. Loads happen ONLY here (startup/reload),
 * never on the acquire path, and the `worker_pool_driver_loaded` audit event
 * records exactly which code went live from where.
 *
 * Module pinning: Node's ESM cache loads a given specifier's code once per
 * daemon lifetime. Changing driver CODE requires a daemon restart; changing
 * the CONFIG to a different specifier hot-loads the new module. A reload that
 * re-encounters an already-loaded specifier emits
 * `worker_pool_driver_module_pinned` so the pin is observable, and cache-busting
 * query strings are rejected (unbounded module-graph growth, half-initialized
 * module hazards).
 */

/** A parsed configured worker-pool driver value that is not a registered kind. */
export interface WorkerDriverRef {
  /** The module specifier with any `#exportName` suffix removed. */
  specifier: string;
  /** The named export selected by a `#name` suffix; undefined means default. */
  exportName?: string | undefined;
}

/**
 * Parses a configured driver string into its module-specifier form. Resolution
 * rule (the single authority for the one-field-two-grammars overload): an
 * EXACT registered kind always wins - {@link ensureWorkerDriverLoaded} checks
 * `registry.get(driver)` BEFORE calling this, so a published npm package named
 * `docker` can never shadow the built-in. A `#name` suffix selects a named
 * export; everything else is the specifier itself.
 */
export function parseWorkerDriverRef(driver: string): WorkerDriverRef {
  const hashIndex = driver.lastIndexOf("#");
  const specifier = hashIndex === -1 ? driver : driver.slice(0, hashIndex);
  const exportName = hashIndex === -1 ? undefined : driver.slice(hashIndex + 1);
  if (specifier === "") {
    throw new Error(
      `worker_pool_driver_invalid_specifier: ${driver} has an empty module specifier`,
    );
  }
  if (exportName === "") {
    throw new Error(
      `worker_pool_driver_invalid_specifier: ${driver} has an empty #exportName suffix`,
    );
  }
  if (specifier.includes("?")) {
    throw new Error(
      `worker_pool_driver_invalid_specifier: ${specifier} - cache-busting query strings are not ` +
        `supported (module code is pinned for the daemon lifetime; restart the daemon to pick ` +
        `up driver code changes)`,
    );
  }
  return { specifier, exportName };
}

/** Options for {@link loadWorkerDriverModule}. */
interface LoadWorkerDriverModuleOptions {
  /** Anchor for `./relative` specifiers; the daemon passes `dirname(workflow.path)`. */
  baseDir: string;
  /** Named export to select; undefined unwraps the default export. */
  exportName?: string | undefined;
  /** Registered kinds, used for the did-you-mean hint on a bare-specifier miss. */
  knownKinds?: ReadonlyArray<string> | undefined;
}

/** A loaded module plus the URL/specifier it was actually imported from. */
interface LoadedWorkerDriverModule {
  module: WorkerDriverModule;
  resolvedFrom: string;
}

/** Whether a specifier is a filesystem path (vs a bare npm package name). */
function isPathSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    path.isAbsolute(specifier) ||
    specifier.startsWith("file:")
  );
}

/**
 * Dynamic-imports a worker-driver module and validates it. Relative and absolute
 * paths resolve against `baseDir` via `pathToFileURL`; bare names resolve
 * through the daemon's module graph (the operator installs the driver package
 * next to symphony; `./path` is the escape hatch). The imported namespace is
 * unwrapped (`default`, the transpiled-CJS `default.default` shape, or the
 * selected named export) and passed through `assertWorkerDriverModule`, so a
 * malformed module or an SDK version mismatch fails loud here - before the
 * pool, the runtime, or any provision exists.
 */
async function loadWorkerDriverModule(
  specifier: string,
  options: LoadWorkerDriverModuleOptions,
): Promise<LoadedWorkerDriverModule> {
  const { baseDir, exportName, knownKinds } = options;
  const resolvedFrom =
    isPathSpecifier(specifier) && !specifier.startsWith("file:")
      ? pathToFileURL(path.resolve(baseDir, specifier)).href
      : specifier;

  let namespace: Record<string, unknown>;
  try {
    namespace = (await import(resolvedFrom)) as Record<string, unknown>;
  } catch (error) {
    throw moduleResolutionError(specifier, resolvedFrom, error, knownKinds ?? []);
  }

  const source = exportName === undefined ? specifier : `${specifier}#${exportName}`;
  const candidate = selectExport(namespace, exportName);
  if (candidate === undefined) {
    const available = Object.keys(namespace)
      .filter((key) => key !== "__esModule")
      .sort();
    throw new Error(
      exportName === undefined
        ? `worker_pool_driver_module_invalid: ${source} has no default export` +
            (available.length > 0 ? ` (named exports: ${available.join(", ")})` : "") +
            `; export defineWorkerDriver(...) as the default export or select a named export with #name`
        : `worker_pool_driver_module_invalid: ${source} has no export named "${exportName}"` +
            (available.length > 0 ? ` (available: ${available.join(", ")})` : ""),
    );
  }
  assertWorkerDriverModule(candidate, source);
  return { module: candidate, resolvedFrom };
}

/**
 * Unwraps the driver module from the imported namespace: the selected named
 * export (falling back through a transpiled-CJS `default` object), or the
 * default export including the `default.default` shape some transpilers emit.
 */
function selectExport(namespace: Record<string, unknown>, exportName: string | undefined): unknown {
  if (exportName !== undefined) {
    const named = namespace[exportName];
    if (named !== undefined) return named;
    const viaDefault = namespace["default"];
    if (typeof viaDefault === "object" && viaDefault !== null) {
      return (viaDefault as Record<string, unknown>)[exportName];
    }
    return undefined;
  }
  let candidate: unknown = namespace["default"];
  if (candidate === undefined) {
    // A CJS module's exports are hoisted onto the namespace itself; accept the
    // namespace only when it already looks like a driver module, so an ESM
    // module that simply lacks a default export gets the no-default error.
    return typeof namespace["create"] === "function" ? namespace : undefined;
  }
  // Transpiled-CJS double default: `module.exports = { default: <module> }`
  // imported as `{ default: { default: <module> } }`. A real driver module has
  // a `create` function, so only unwrap when the outer layer does not.
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "default" in candidate &&
    typeof (candidate as { create?: unknown }).create !== "function"
  ) {
    candidate = (candidate as Record<string, unknown>)["default"];
  }
  return candidate;
}

/** Builds the actionable error for a failed module import. */
function moduleResolutionError(
  specifier: string,
  resolvedFrom: string,
  cause: unknown,
  knownKinds: ReadonlyArray<string>,
): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (isPathSpecifier(specifier)) {
    return new Error(
      `worker_pool_driver_unavailable: ${specifier} (failed to import ${resolvedFrom}: ${message})`,
    );
  }
  const kinds =
    knownKinds.length > 0
      ? ` (known kinds: ${[...knownKinds].sort().join(", ")})`
      : " (no worker drivers registered)";
  const close = closestKind(specifier, knownKinds);
  const hint = close === undefined ? "" : ` - did you mean "${close}"?`;
  return new Error(
    `worker_pool_driver_unavailable: ${specifier} is not a registered kind and could not be ` +
      `resolved as a module${kinds}${hint} [${message}]`,
  );
}

/**
 * The registered kind within a small edit distance of a mistyped bare
 * specifier, or undefined when nothing is close. Mitigates the typo detection
 * a closed config enum used to provide: `driver: dokcer` now reads as a module
 * specifier, so the resolution failure points back at the built-in.
 */
function closestKind(specifier: string, kinds: ReadonlyArray<string>): string | undefined {
  let best: { kind: string; distance: number } | undefined;
  for (const kind of kinds) {
    const distance = editDistance(specifier.toLowerCase(), kind.toLowerCase());
    if (distance <= 2 && (best === undefined || distance < best.distance)) {
      best = { kind, distance };
    }
  }
  return best?.kind;
}

/** Levenshtein distance (small inputs only: driver kinds and specifiers). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i += 1) {
    const current = [i, ...new Array<number>(cols - 1).fill(0)];
    for (let j = 1; j < cols; j += 1) {
      const substitution = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((prev[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    prev = current;
  }
  return prev[cols - 1] ?? Math.max(a.length, b.length);
}

/**
 * Specifiers THIS loader registered, per registry. Distinguishes a reload that
 * re-encounters an already-loaded specifier (emit the module-pinned audit
 * event) from an ordinary built-in/extension hit (silent no-op).
 */
const loadedSpecifiers = new WeakMap<WorkerDriverRegistry, Set<string>>();

/** Options for {@link ensureWorkerDriverLoaded}. */
export interface EnsureWorkerDriverLoadedOptions {
  /** Anchor for `./relative` specifiers; the daemon passes `dirname(workflow.path)`. */
  baseDir?: string | undefined;
  /** Structured-event sink for the loaded/pinned audit events. */
  logEvent?: ((event: Record<string, unknown>) => void) | undefined;
}

/**
 * Idempotently makes the configured worker-pool driver resolvable in
 * `registry`. A registry hit (a built-in kind, an extension, or a specifier a
 * previous call already loaded) is a no-op - except that a re-encountered
 * loader-registered specifier emits `worker_pool_driver_module_pinned` so the
 * code-is-pinned semantic is observable on reload. A miss parses the driver as
 * a module reference, dynamic-imports it, and registers a factory whose kind
 * IS the configured specifier string, emitting `worker_pool_driver_loaded`.
 *
 * Called by the daemon BEFORE `createWorkerPool` at startup and (via the
 * coordinator's injected `driverLoader`) BEFORE `pool.reconcile` on reload, so
 * the pool's registry resolution stays synchronous and transactional. A module
 * registered for a reconcile that later fails is harmless: the registry is a
 * catalog, and an unused entry is inert.
 */
export async function ensureWorkerDriverLoaded(
  driver: string,
  registry: WorkerDriverRegistry,
  options: EnsureWorkerDriverLoadedOptions = {},
): Promise<void> {
  const logEvent = options.logEvent ?? ((): void => {});
  if (registry.get(driver) !== undefined) {
    if (loadedSpecifiers.get(registry)?.has(driver)) {
      logEvent({ event: "worker_pool_driver_module_pinned", specifier: driver });
    }
    return;
  }

  const ref = parseWorkerDriverRef(driver);
  const { module, resolvedFrom } = await loadWorkerDriverModule(ref.specifier, {
    baseDir: options.baseDir ?? process.cwd(),
    exportName: ref.exportName,
    knownKinds: registry.kinds(),
  });

  // Register under the EXACT configured string: the pool resolves
  // `settings.driver` verbatim, so the factory's kind must be the specifier,
  // not the module's self-declared kind (which is logged for the audit trail).
  registry.register({
    kind: driver,
    create: (driverOptions, deps) => module.create(driverOptions, deps),
  });
  let loaded = loadedSpecifiers.get(registry);
  if (loaded === undefined) {
    loaded = new Set<string>();
    loadedSpecifiers.set(registry, loaded);
  }
  loaded.add(driver);
  logEvent({
    event: "worker_pool_driver_loaded",
    specifier: driver,
    kind: module.kind,
    sdkVersion: module.sdkVersion,
    resolvedFrom,
  });
}
