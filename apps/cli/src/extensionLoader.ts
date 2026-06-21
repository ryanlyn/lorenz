import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Axis-generic out-of-tree extension loading. lorenz has four extension axes -
 * trackers, tools, agent-executors, worker-drivers - each registered into the
 * daemon through a static `registerBuiltinBackends()` trust boundary for
 * BUILT-INS. This module is the OTHER half: an operator names a MODULE SPECIFIER
 * (an npm package name, `@scope/name`, `./relative` or `/absolute` path, with an
 * optional `#exportName` suffix) in config, and the daemon dynamic-imports that
 * module at startup (and on a reload that changes the specifier) and registers
 * it into the axis registry under the EXACT configured string, so the existing
 * registry resolution needs no changes and third parties ship extensions without
 * forking the repo.
 *
 * The worker-driver loader was the first instance of this shape; this core lifts
 * its every literal behind {@link ExtensionAxis} so the same audited mechanics -
 * exact-kind-wins resolution, native `import()` + `pathToFileURL`, the
 * sdkVersion handshake, the loaded/pinned audit events, the per-registry pin
 * WeakMap, the cache-busting-query rejection - serve all four axes from one
 * place. It is purely additive: built-ins never flow through here.
 *
 * Trust: a dynamic import runs arbitrary code in the daemon process - the same
 * trust boundary as workspace hooks. Loads happen ONLY at startup/reload, never
 * on an acquire/hot path, and the `<axis>_loaded` audit event records exactly
 * which code went live from where.
 *
 * Module pinning: Node's ESM cache loads a given specifier's code once per
 * daemon lifetime. Changing extension CODE requires a daemon restart; changing
 * the CONFIG to a different specifier hot-loads the new module. A reload that
 * re-encounters an already-loaded specifier emits the `<axis>_module_pinned`
 * event so the pin is observable, and cache-busting query strings are rejected
 * (unbounded module-graph growth, half-initialized module hazards).
 */

/** The minimal registry surface the loader needs, shared by all four axes. */
export interface ExtensionRegistry<TFactory> {
  /** The factory registered for a kind, or undefined when none is. */
  get(kind: string | undefined): TFactory | undefined;
  /** Register a factory; the loader always registers under the configured string. */
  register(factory: TFactory): void;
  /** Registered kinds, used for the did-you-mean hint on a bare-specifier miss. */
  kinds(): string[];
}

/**
 * The per-axis configuration that turns the generic core into a concrete loader.
 * Every literal that was worker-driver-specific in the original loader lives
 * here so the mechanics stay byte-identical across instances.
 */
export interface ExtensionAxis<TFactory, TModule> {
  /**
   * Error-code prefix for this axis (the worker-driver instance passes
   * `"worker_pool_driver"`). All thrown errors and the resolution diagnostics
   * are namespaced under it.
   */
  readonly errorPrefix: string;
  /** Audit event names emitted on a fresh load vs a re-encountered pin. */
  readonly eventNames: { loaded: string; pinned: string };
  /**
   * The authoring-sugar helper name an out-of-tree module exports through (the
   * worker-driver instance passes `"defineWorkerDriver"`), named in the
   * no-default-export error so the author knows the expected shape.
   */
  readonly defineHelperName: string;
  /**
   * The noun for "this axis's units" used in the empty-registry resolution hint
   * (`no <noun> registered`) and the cache-busting-query advice (`restart the
   * daemon to pick up <noun> code changes`). The worker-driver instance passes
   * `"worker drivers"` to keep its diagnostics byte-identical to the original
   * single-axis loader.
   */
  readonly unitNoun: string;
  /**
   * Shape-asserts the unwrapped candidate is a valid module for this axis and
   * runs the sdkVersion handshake, throwing loud on a mismatch. `source` names
   * where the value came from so every error is actionable.
   */
  assertModule(value: unknown, source: string): asserts value is TModule;
  /**
   * Whether the unwrapped value structurally looks like a module of this axis,
   * used by {@link selectExport} to disambiguate the transpiled-CJS double-default
   * shape and the CJS-hoisted-exports shape. The worker-driver instance tests
   * for a `create` function.
   */
  looksLikeModule(value: unknown): boolean;
  /**
   * The registry factory to register under the configured specifier string. The
   * factory's kind IS the specifier (the registry resolves the configured value
   * verbatim), delegating to the loaded module.
   */
  toFactory(specifier: string, module: TModule): TFactory;
  /** The audit fields describing a loaded module (its self-declared kind/version). */
  describeModule(module: TModule): { kind: string; sdkVersion: number };
}

/** A parsed configured extension value that is not a registered kind. */
export interface ExtensionRef {
  /** The module specifier with any `#exportName` suffix removed. */
  specifier: string;
  /** The named export selected by a `#name` suffix; undefined means default. */
  exportName?: string | undefined;
}

/** Options for {@link ExtensionLoader.ensureLoaded}. */
export interface EnsureExtensionLoadedOptions {
  /** Anchor for `./relative` specifiers; the daemon passes a workflow-derived dir. */
  baseDir?: string | undefined;
  /** Structured-event sink for the loaded/pinned audit events. */
  logEvent?: ((event: Record<string, unknown>) => void) | undefined;
}

/** The public surface of an axis loader instance. */
export interface ExtensionLoader<TFactory> {
  /**
   * Parses a configured value into its module-specifier form. Resolution rule
   * (the single authority for the one-field-two-grammars overload): an EXACT
   * registered kind always wins - {@link ExtensionLoader.ensureLoaded} checks
   * the registry BEFORE calling this, so a published npm package can never
   * shadow a built-in. A `#name` suffix selects a named export; everything else
   * is the specifier itself.
   */
  parseRef(value: string): ExtensionRef;
  /**
   * Idempotently makes the configured extension resolvable in `registry`. A
   * registry hit (a built-in kind, an extension, or a specifier a previous call
   * already loaded) is a no-op - except that a re-encountered loader-registered
   * specifier emits the `<axis>_module_pinned` event so the code-is-pinned
   * semantic is observable on reload. A miss parses the value as a module
   * reference, dynamic-imports it, and registers a factory whose kind IS the
   * configured string, emitting the `<axis>_loaded` event.
   */
  ensureLoaded(
    value: string,
    registry: ExtensionRegistry<TFactory>,
    options?: EnsureExtensionLoadedOptions,
  ): Promise<void>;
}

/** A loaded module plus the URL/specifier it was actually imported from. */
interface LoadedModule<TModule> {
  module: TModule;
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
 * Builds an axis loader from {@link ExtensionAxis}. The returned instance is the
 * single entrypoint per axis (lorenz has one registration mode, so one
 * `ensureLoaded` suffices - no setup/metadata/discovery fan-out).
 */
export function createExtensionLoader<TFactory, TModule>(
  axis: ExtensionAxis<TFactory, TModule>,
): ExtensionLoader<TFactory> {
  /**
   * Specifiers THIS loader registered, per registry. Distinguishes a reload that
   * re-encounters an already-loaded specifier (emit the module-pinned event)
   * from an ordinary built-in/extension hit (silent no-op).
   */
  const loadedSpecifiers = new WeakMap<ExtensionRegistry<TFactory>, Set<string>>();

  function parseRef(value: string): ExtensionRef {
    const hashIndex = value.lastIndexOf("#");
    const specifier = hashIndex === -1 ? value : value.slice(0, hashIndex);
    const exportName = hashIndex === -1 ? undefined : value.slice(hashIndex + 1);
    if (specifier === "") {
      throw new Error(
        `${axis.errorPrefix}_invalid_specifier: ${value} has an empty module specifier`,
      );
    }
    if (exportName === "") {
      throw new Error(
        `${axis.errorPrefix}_invalid_specifier: ${value} has an empty #exportName suffix`,
      );
    }
    if (specifier.includes("?")) {
      throw new Error(
        `${axis.errorPrefix}_invalid_specifier: ${specifier} - cache-busting query strings are not ` +
          `supported (module code is pinned for the daemon lifetime; restart the daemon to pick ` +
          `up ${axis.unitNoun} code changes)`,
      );
    }
    return { specifier, exportName };
  }

  /**
   * Unwraps the module from the imported namespace: the selected named export
   * (falling back through a transpiled-CJS `default` object), or the default
   * export including the `default.default` shape some transpilers emit.
   */
  function selectExport(
    namespace: Record<string, unknown>,
    exportName: string | undefined,
  ): unknown {
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
      // namespace only when it already looks like a module, so an ESM module
      // that simply lacks a default export gets the no-default error.
      return axis.looksLikeModule(namespace) ? namespace : undefined;
    }
    // Transpiled-CJS double default: `module.exports = { default: <module> }`
    // imported as `{ default: { default: <module> } }`. A real module looks
    // like a module, so only unwrap when the outer layer does not.
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "default" in candidate &&
      !axis.looksLikeModule(candidate)
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
        `${axis.errorPrefix}_unavailable: ${specifier} (failed to import ${resolvedFrom}: ${message})`,
      );
    }
    const kinds =
      knownKinds.length > 0
        ? ` (known kinds: ${[...knownKinds].sort().join(", ")})`
        : ` (no ${axis.unitNoun} registered)`;
    const close = closestKind(specifier, knownKinds);
    const hint = close === undefined ? "" : ` - did you mean "${close}"?`;
    return new Error(
      `${axis.errorPrefix}_unavailable: ${specifier} is not a registered kind and could not be ` +
        `resolved as a module${kinds}${hint} [${message}]`,
    );
  }

  /**
   * Dynamic-imports a module and validates it. Relative and absolute paths
   * resolve against `baseDir` via `pathToFileURL`; bare names resolve through
   * the daemon's module graph. The imported namespace is unwrapped and passed
   * through {@link ExtensionAxis.assertModule}, so a malformed module or an SDK
   * version mismatch fails loud here - before any consumer exists.
   */
  async function loadModule(
    specifier: string,
    options: {
      baseDir: string;
      exportName?: string | undefined;
      knownKinds?: ReadonlyArray<string> | undefined;
    },
  ): Promise<LoadedModule<TModule>> {
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
          ? `${axis.errorPrefix}_module_invalid: ${source} has no default export` +
              (available.length > 0 ? ` (named exports: ${available.join(", ")})` : "") +
              `; export ${axis.defineHelperName}(...) as the default export or select a named export with #name`
          : `${axis.errorPrefix}_module_invalid: ${source} has no export named "${exportName}"` +
              (available.length > 0 ? ` (available: ${available.join(", ")})` : ""),
      );
    }
    axis.assertModule(candidate, source);
    return { module: candidate, resolvedFrom };
  }

  async function ensureLoaded(
    value: string,
    registry: ExtensionRegistry<TFactory>,
    options: EnsureExtensionLoadedOptions = {},
  ): Promise<void> {
    const logEvent = options.logEvent ?? ((): void => {});
    if (registry.get(value) !== undefined) {
      if (loadedSpecifiers.get(registry)?.has(value)) {
        logEvent({ event: axis.eventNames.pinned, specifier: value });
      }
      return;
    }

    const ref = parseRef(value);
    const { module, resolvedFrom } = await loadModule(ref.specifier, {
      baseDir: options.baseDir ?? process.cwd(),
      exportName: ref.exportName,
      knownKinds: registry.kinds(),
    });

    // Register under the EXACT configured string: the consumer resolves the
    // configured value verbatim, so the factory's kind must be the specifier,
    // not the module's self-declared kind (which is logged for the audit trail).
    registry.register(axis.toFactory(value, module));
    let loaded = loadedSpecifiers.get(registry);
    if (loaded === undefined) {
      loaded = new Set<string>();
      loadedSpecifiers.set(registry, loaded);
    }
    loaded.add(value);
    const described = axis.describeModule(module);
    logEvent({
      event: axis.eventNames.loaded,
      specifier: value,
      kind: described.kind,
      sdkVersion: described.sdkVersion,
      resolvedFrom,
    });
  }

  return { parseRef, ensureLoaded };
}

/**
 * The registered kind within a small edit distance of a mistyped bare specifier,
 * or undefined when nothing is close. Mitigates the typo detection a closed
 * config enum used to provide.
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

/** Levenshtein distance (small inputs only: extension kinds and specifiers). */
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
