export declare const AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY = "nativeSubagentSessions";
export declare const AIR_ASYNC_TASKS_CAPABILITY = "asyncTasks";
export declare const AIR_SESSION_FAILURE_CAPABILITY = "sessionFailure";
export declare const AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY = "recommendedValue";
export declare const AIR_DIFF_PATCH_CAPABILITY = "diffPatch";
/** AIR renders `rawInput` itself and needs no display copy of the input. */
export declare const AIR_RAW_INPUT_RENDERING_CAPABILITY = "rawInputRendering";
/**
 * The plan of an ExitPlanMode is a file. `rawInput.planFilePath` names the
 * file, and AIR reads the plan from it.
 */
export declare const AIR_PLAN_FILE_CAPABILITY = "planFile";
/** The `_meta.jetbrains.air` keys that the ACP tool call contract defines. */
export declare const AIR_COMMAND_TITLE_KEY = "commandTitle";
export declare const AIR_SUBAGENT_KEY = "subagent";
export declare const AIR_SKILL_KEY = "skill";
export declare const AIR_CONTEXT_COMPACTION_KEY = "contextCompaction";
export declare const AIR_GOAL_KEY = "goal";
export declare const AIR_KIND_KEY = "kind";
export declare const AIR_PERMISSION_KEY = "permission";
export declare const AIR_CUSTOM_ANSWER_KEY = "customAnswer";
/** The capability list this side advertises, as its own `_meta` object. */
export declare function airCapabilityMeta(...capabilities: string[]): Record<string, unknown>;
/**
 * Merges one AIR extension payload into an existing `_meta`.
 *
 * Every other namespace is preserved: an update can carry both agent-native
 * `claudeCode` metadata and an AIR payload, and two AIR payloads can share the
 * same `air` object. Pass `undefined` to build a fresh `_meta`.
 */
export declare function withAirMeta(meta: Record<string, unknown> | null | undefined, capability: string, payload: unknown): Record<string, unknown>;
/**
 * Whether the client is JetBrains AIR: it declared `_meta.jetbrains.air` in
 * its capabilities.
 *
 * Only AIR gets the AIR extensions of `docs/air-extensions.md`. Every other
 * client, Zed too, gets the fields and the upstream `_meta` keys of the
 * upstream adapter, and no key that exists only for AIR.
 */
export declare function isAirClient(capabilities: unknown): boolean;
/**
 * The `_meta` of an AIR client with one more AIR payload, or undefined for
 * every other client: a client that is not AIR gets no AIR key.
 */
export declare function airOnlyMeta(airClient: boolean, capability: string, payload: unknown, meta?: Record<string, unknown> | null): Record<string, unknown> | undefined;
/** The `air` object inside a `_meta`, or undefined when the peer sent no AIR extension. */
export declare function airExtensionMeta(meta: unknown): Record<string, unknown> | undefined;
/**
 * Whether the peer advertised `capability`.
 *
 * Takes `unknown` because every caller is reading wire data: an ACP
 * `ClientCapabilities`, or a bag whose `_meta` was never validated.
 */
export declare function clientSupportsAirCapability(capabilities: unknown, capability: string): boolean;
//# sourceMappingURL=air-extension.d.ts.map
