import { makeSdkModuleContract } from "@lorenz/domain";

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
 * the SDK version it targets. A dynamically imported module crosses a version
 * boundary the daemon cannot type-check, so the explicit `sdkVersion` handshake
 * stands in for the compiler.
 */
export interface ToolProviderModule extends ToolProvider {
  readonly sdkVersion: number;
}

const contract = makeSdkModuleContract<ToolProviderModule>({
  errorPrefix: "tool_provider",
  moduleNoun: "a tool provider module",
  identityField: "name",
  defineCall: "defineToolProvider({ name, sdkVersion, toolSpecs, executeTool })",
  requiredFns: [
    { field: "toolSpecs", signature: "toolSpecs(settings)", article: "a" },
    { field: "executeTool", signature: "executeTool(name, input, context)", article: "an" },
  ],
  sdkVersion: TOOL_SDK_VERSION,
});

/**
 * Structural check + version handshake for a dynamically loaded tool module.
 * `source` names where the value came from so every error is actionable.
 */
export const assertToolProviderModule: (
  value: unknown,
  source: string,
) => asserts value is ToolProviderModule = contract.assertModule;

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
  return contract.defineModule(module, "defineToolProvider");
}
