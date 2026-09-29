export declare const CONTEXT_COMPACTION_META_VERSION = 1;
export type ContextCompactionTrigger = "manual" | "automatic";
export interface ContextCompactionMetadata {
    version: typeof CONTEXT_COMPACTION_META_VERSION;
    trigger?: ContextCompactionTrigger;
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
    error?: string;
}
/**
 * The `_meta` of a context compaction report:
 * `_meta.jetbrains.air.contextCompaction`, as `docs/air-extensions.md`
 * defines. The standard toolCallId and status fields own lifecycle identity
 * and phase; this extension carries only compaction-specific facts. Only AIR
 * gets it.
 */
export declare function createContextCompactionMeta(metadata?: Omit<ContextCompactionMetadata, "version">): Record<string, unknown>;
//# sourceMappingURL=context-compaction-meta.d.ts.map
