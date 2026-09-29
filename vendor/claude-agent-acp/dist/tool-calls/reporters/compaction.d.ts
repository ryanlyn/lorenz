import type { SessionNotification } from "@agentclientprotocol/sdk";
import { type ContextCompactionMetadata } from "../../context-compaction-meta.js";
type CompactionFacts = Omit<ContextCompactionMetadata, "version">;
type ToolCallUpdate = SessionNotification["update"];
/**
 * The synthetic "Compact conversation" tool call, for a client without the
 * ACP compaction updates.
 *
 * AIR detects it by `_meta.jetbrains.air.contextCompaction`, which holds the
 * trigger, the token counts, the duration, and the error. The error also goes
 * to `content` once, because it is the result to show. No `rawOutput` repeats
 * the facts for AIR.
 *
 * Every other client gets the upstream fields: the tool name `compact`, and
 * the facts in `rawOutput`. It gets no AIR key.
 */
export declare const compactionToolCall: {
    started(compactionId: string, airClient?: boolean): ToolCallUpdate;
    inProgress(compactionId: string, airClient?: boolean): ToolCallUpdate;
    /** The terminal report. A missed opening makes it the first report, a `tool_call`. */
    finished(compactionId: string, status: "completed" | "failed" | undefined, facts: CompactionFacts, first: boolean, airClient?: boolean): ToolCallUpdate;
};
export {};
//# sourceMappingURL=compaction.d.ts.map
