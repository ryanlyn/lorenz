import { AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY, withAirMeta } from "./air-extension.js";
import { EFFORT_CONFIG_ID } from "./session-config-ids.js";
export { EFFORT_CONFIG_ID } from "./session-config-ids.js";
// The SDK drops `undefined` during JSON transport and only clears a flag-layer
// setting when it receives an explicit `null`. Map both an absent picker and
// the legacy "default" row to null so a previously applied effort is cleared.
export function toSdkEffortLevel(value) {
    return value === undefined || value === "default" ? null : value;
}
function canonicalizeModelSettingsKey(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/-(\d+m)$/i, "[$1]");
}
/** Resolve the effort the CLI will use: per-model settings first, then the
 *  legacy top-level effort setting. Model settings are keyed by canonical
 *  model name, so try the resolved SDK model before picker and raw IDs. */
export function settingsEffortForModel(settings, modelInfo, modelId) {
    const modelSettings = settings.modelSettings;
    if (modelSettings) {
        for (const key of [modelInfo?.resolvedModel, modelInfo?.value, modelId]) {
            if (key === undefined)
                continue;
            const exact = modelSettings[key]?.effortLevel;
            if (typeof exact === "string")
                return exact;
            const canonicalKey = canonicalizeModelSettingsKey(key);
            const matchingEntry = Object.entries(modelSettings).find(([candidate]) => canonicalizeModelSettingsKey(candidate) === canonicalKey);
            const perModel = matchingEntry?.[1]?.effortLevel;
            if (typeof perModel === "string")
                return perModel;
        }
    }
    return settings.effortLevel;
}
/** Programmatic query settings have higher priority than file-backed settings,
 * matching the SDK. Keep unrelated per-model entries from lower tiers while
 * replacing entries supplied at the programmatic tier. */
export function mergeEffortSettings(base, override) {
    if (!override)
        return base;
    const overriddenModelKeys = new Set(Object.keys(override.modelSettings ?? {}).map(canonicalizeModelSettingsKey));
    const unshadowedBaseModelSettings = Object.fromEntries(Object.entries(base.modelSettings ?? {}).filter(([key]) => !overriddenModelKeys.has(canonicalizeModelSettingsKey(key))));
    return {
        ...base,
        ...override,
        modelSettings: base.modelSettings || override.modelSettings
            ? { ...unshadowedBaseModelSettings, ...override.modelSettings }
            : undefined,
    };
}
export function buildEffortConfigOption(modelInfos, currentModelId, currentEffortLevel, useRecommendedValue) {
    const currentModelInfo = modelInfos.find((model) => model.value === currentModelId);
    const supportedLevels = currentModelInfo?.supportsEffort
        ? (currentModelInfo.supportedEffortLevels ?? [])
        : [];
    if (supportedLevels.length === 0)
        return undefined;
    const recommendedEffort = supportedLevels.includes("medium")
        ? "medium"
        : supportedLevels[0];
    const options = [
        ...(useRecommendedValue ? [] : [{ value: "default", name: "Default" }]),
        ...supportedLevels.map((level) => ({
            value: level,
            name: level
                .split(/[_-]/)
                .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
                .join(" "),
        })),
    ];
    const includes = (level) => (!useRecommendedValue && level === "default") || supportedLevels.includes(level);
    const currentValue = currentEffortLevel && includes(currentEffortLevel)
        ? currentEffortLevel
        : useRecommendedValue
            ? recommendedEffort
            : "default";
    return {
        id: EFFORT_CONFIG_ID,
        name: "Effort",
        description: "Available effort levels for this model",
        category: "thought_level",
        type: "select",
        currentValue,
        options,
        ...(useRecommendedValue
            ? {
                _meta: withAirMeta(undefined, AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY, recommendedEffort),
            }
            : {}),
    };
}
