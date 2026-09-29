import type { SessionNotification, ToolCallContent } from "@agentclientprotocol/sdk";
type SessionUpdate = SessionNotification["update"];
/**
 * Remembers what the client holds for each open tool call, so that a
 * `tool_call_update` carries only the fields that changed.
 *
 * A client overwrites a field that an update carries and merges `_meta` by
 * key. An update that repeats a field value therefore only costs bandwidth,
 * and for a Write it repeats the whole file. The tracker drops such fields.
 * It never drops `_meta`, because a client appends `terminal_output_delta`
 * data.
 *
 * An entry starts at the `tool_call` and ends after both the tool_result and
 * the PostToolUse hook callback, or when the session is torn down.
 */
export declare class ToolCallFieldTracker {
    private readonly calls;
    /**
     * Records a `tool_call`, or removes the unchanged fields of a
     * `tool_call_update` and records the rest.
     *
     * Returns false when the update carries nothing new: no replaced field
     * remains, `_meta` has no key besides `claudeCode` and `jetbrains`, and
     * every `claudeCode` and `jetbrains.air` key repeats its value. The caller
     * then skips the update. An update for a tool call that the tracker does
     * not know passes through unchanged.
     *
     * `replacePinnedContent` lets the final result of the tool replace an exact
     * approval patch (see {@link pinContent}).
     */
    apply(update: SessionUpdate, options?: {
        replacePinnedContent?: boolean;
    }): boolean;
    /**
     * Records the exact approval patch that the client shows for a tool call.
     *
     * The streamed tool input later refines the call with a standard diff of
     * the Edit snippet. That diff must not replace the exact patch, so the
     * content stays until an update passes `replacePinnedContent`.
     */
    pinContent(toolCallId: string, content: ToolCallContent[]): void;
    /**
     * Marks the tool_result of a tool call. The entry ends now, or after the
     * PostToolUse hook callback when `hookPending` is true.
     */
    finishResult(toolCallId: string, hookPending: boolean): void;
    /**
     * Marks the end of the PostToolUse hook callback of a tool call. The entry
     * ends when the tool_result was seen. Otherwise the tool_result ends it.
     */
    finishHook(toolCallId: string): void;
    /** Forgets one tool call. */
    delete(toolCallId: string): void;
    /** Forgets every tool call, when the session is torn down. */
    clear(): void;
}
export {};
//# sourceMappingURL=field-tracker.d.ts.map
