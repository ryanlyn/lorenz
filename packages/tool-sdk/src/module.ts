import type { ToolProvider } from "./provider.js";

/**
 * The tool SDK version this build of the engine speaks. Out-of-tree tool-pack
 * modules declare the version they target via {@link ToolProviderModule.sdkVersion};
 * the loader rejects a mismatch before the module ever reaches the registry.
 * Major-only: additive, backwards-compatible SDK changes never bump it.
 */
export const TOOL_SDK_VERSION = 1;

/**
 * The unit an OUT-OF-TREE tool module exports: a {@link ToolProvider} carrying
 * the SDK version it targets. In-repo extensions register packs directly (the
 * composition root vouches for them); a dynamically imported module instead
 * crosses a version boundary the daemon cannot type-check, so the explicit
 * `sdkVersion` handshake stands in for the compiler.
 */
export interface ToolProviderModule extends ToolProvider {
  readonly sdkVersion: number;
}

/**
 * Authoring sugar for out-of-tree tool modules: shape-asserts the module at
 * definition time (so a typo fails in the author's tests, not the operator's
 * daemon) and returns it unchanged. Usage:
 *
 * ```ts
 * export default defineToolProvider({
 *   name: "acme",
 *   sdkVersion: 1,
 *   toolSpecs: (settings) => [...],
 *   executeTool: (name, input, context) => acmeExecute(name, input, context),
 * });
 * ```
 */
export function defineToolProvider(module: ToolProviderModule): ToolProviderModule {
  assertToolProviderModule(module, "defineToolProvider");
  return module;
}

/**
 * Structural check + version handshake for a dynamically loaded tool module.
 * `source` names where the value came from (a module specifier, or
 * `defineToolProvider` at authoring time) so every error is actionable. Throws:
 *
 * - `tool_provider_module_invalid: <source> ...` when the value is not an
 *   object, `name` is not a non-empty string, `toolSpecs`/`executeTool` are not
 *   functions, or `sdkVersion` is not a number;
 * - `tool_provider_sdk_mismatch: <source> targets SDK v<n>, this build supports
 *   v<TOOL_SDK_VERSION>` when the declared version differs.
 */
export function assertToolProviderModule(
  value: unknown,
  source: string,
): asserts value is ToolProviderModule {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `tool_provider_module_invalid: ${source} did not yield a tool provider module object ` +
        `(got ${value === null ? "null" : typeof value}); export defineToolProvider({ name, sdkVersion, toolSpecs, executeTool }) ` +
        `as the default export or a named export`,
    );
  }
  const candidate = value as Partial<ToolProviderModule>;
  if (typeof candidate.name !== "string" || candidate.name.trim() === "") {
    throw new Error(
      `tool_provider_module_invalid: ${source} is missing a non-empty string \`name\``,
    );
  }
  if (typeof candidate.toolSpecs !== "function") {
    throw new Error(
      `tool_provider_module_invalid: ${source} (name: ${candidate.name}) is missing a \`toolSpecs(settings)\` function`,
    );
  }
  if (typeof candidate.executeTool !== "function") {
    throw new Error(
      `tool_provider_module_invalid: ${source} (name: ${candidate.name}) is missing an \`executeTool(name, input, context)\` function`,
    );
  }
  if (typeof candidate.sdkVersion !== "number") {
    throw new Error(
      `tool_provider_module_invalid: ${source} (name: ${candidate.name}) is missing a numeric \`sdkVersion\` ` +
        `(declare sdkVersion: ${TOOL_SDK_VERSION})`,
    );
  }
  if (candidate.sdkVersion !== TOOL_SDK_VERSION) {
    throw new Error(
      `tool_provider_sdk_mismatch: ${source} targets SDK v${candidate.sdkVersion}, ` +
        `this build supports v${TOOL_SDK_VERSION}`,
    );
  }
}
