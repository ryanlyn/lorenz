import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { ModelInfo, Query, Settings } from "@anthropic-ai/claude-agent-sdk";
export declare const MODEL_CONFIG_ID = "model";
export type SessionModelState = {
    availableModels: Array<{
        modelId: string;
        name: string;
        description?: string;
    }>;
    currentModelId: string;
};
type ModelLogger = {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
};
type ModelSettingsSource = {
    getSettings(): Settings;
};
export declare function resolveModelPreference(models: ModelInfo[], preference: string): ModelInfo | null;
export declare function matchResumedModel(models: ModelInfo[], liveModel: string): ModelInfo;
export declare function buildModelConfigOption(models: SessionModelState, modelInfos: ModelInfo[], useRecommendedValue: boolean): SessionConfigOption;
/**
 * Whether managed `deniedModels` blocks a model id, following the CLI's rules
 * closely enough for the picker: a family alias blocks the whole family, and a
 * model id blocks that version in every spelling plus the later minor versions
 * it prefixes (`claude-opus-5` also blocks `claude-opus-5-5`). The CLI stays
 * the enforcer; this only keeps the picker from offering a refused row.
 */
export declare function isDeniedModel(modelId: string, deniedModels: readonly string[]): boolean;
/**
 * Restrict the SDK's model list to the user's `availableModels` allowlist
 * (already merged-and-deduped across settings sources by `SettingsManager`).
 * The user's exact entries become the model IDs surfaced via configOptions
 * and passed to `setModel`, which prevents Claude Code from silently
 * substituting a date-pinned variant (e.g. `haiku` →
 * `claude-haiku-4-5-20251001`) that the user may not have access to.
 *
 * Display info and capability flags are copied from the closest SDK match so
 * the UI still renders sensible names and effort levels.
 *
 * Semantics from https://code.claude.com/docs/en/model-config#restrict-model-selection:
 * - `undefined` is handled by the caller (no allowlist applied).
 * - The Default option is unaffected by `availableModels` — it always remains
 *   available, even when the allowlist is `[]`.
 * - Managed `deniedModels` wins over the allowlist, so a denied entry is
 *   dropped even though the CLI would otherwise leave it unmatched.
 */
export declare function applyAvailableModelsAllowlist(sdkModels: ModelInfo[], allowlist: string[], settingsModelOverrides?: Record<string, string>, deniedModels?: readonly string[]): ModelInfo[];
export declare function getAvailableModels(query: Query, models: ModelInfo[], sdkModels: ModelInfo[], settingsManager: ModelSettingsSource, logger: ModelLogger, isResumedSession: boolean, sessionId: string, resumedModelHint?: string): Promise<SessionModelState>;
export {};
//# sourceMappingURL=session-model.d.ts.map
