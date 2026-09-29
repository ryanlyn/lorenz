import { createContextCompactionMeta, } from "../../context-compaction-meta.js";
import { textContent } from "../content.js";
const TITLE = "Compact conversation";
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
export const compactionToolCall = {
    started(compactionId, airClient = false) {
        return {
            sessionUpdate: "tool_call",
            toolCallId: compactionId,
            title: TITLE,
            kind: "think",
            status: "in_progress",
            _meta: meta({}, airClient),
        };
    },
    inProgress(compactionId, airClient = false) {
        return {
            sessionUpdate: "tool_call_update",
            toolCallId: compactionId,
            status: "in_progress",
            _meta: meta({}, airClient),
        };
    },
    /** The terminal report. A missed opening makes it the first report, a `tool_call`. */
    finished(compactionId, status, facts, first, airClient = false) {
        const errorContent = status === "failed" && facts.error
            ? { content: [textContent(`Compaction failed: ${facts.error}`)] }
            : {};
        const rawOutput = !airClient && Object.keys(facts).length > 0 ? { rawOutput: facts } : {};
        if (first) {
            return {
                sessionUpdate: "tool_call",
                toolCallId: compactionId,
                title: TITLE,
                kind: "think",
                status: status ?? "completed",
                ...errorContent,
                ...rawOutput,
                _meta: meta(facts, airClient),
            };
        }
        return {
            sessionUpdate: "tool_call_update",
            toolCallId: compactionId,
            ...(status ? { status } : {}),
            ...errorContent,
            ...rawOutput,
            _meta: meta(facts, airClient),
        };
    },
};
/** The compaction facts for AIR, and the upstream tool name for every other client. */
function meta(facts, airClient) {
    return airClient ? createContextCompactionMeta(facts) : { claudeCode: { toolName: "compact" } };
}
