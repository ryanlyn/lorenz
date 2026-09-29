import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { EffortLevel, ModelInfo, Settings } from "@anthropic-ai/claude-agent-sdk";
export { EFFORT_CONFIG_ID } from "./session-config-ids.js";
export declare function toSdkEffortLevel(value: string | undefined): EffortLevel | null;
/** Resolve the effort the CLI will use: per-model settings first, then the
 *  legacy top-level effort setting. Model settings are keyed by canonical
 *  model name, so try the resolved SDK model before picker and raw IDs. */
export declare function settingsEffortForModel(settings: Settings, modelInfo: ModelInfo | undefined, modelId?: string): string | undefined;
/** Programmatic query settings have higher priority than file-backed settings,
 * matching the SDK. Keep unrelated per-model entries from lower tiers while
 * replacing entries supplied at the programmatic tier. */
export declare function mergeEffortSettings(base: Settings, override: Settings | undefined): Settings;
export declare function buildEffortConfigOption(modelInfos: ModelInfo[], currentModelId: string, currentEffortLevel: string | undefined, useRecommendedValue: boolean): SessionConfigOption | undefined;
//# sourceMappingURL=session-effort.d.ts.map
