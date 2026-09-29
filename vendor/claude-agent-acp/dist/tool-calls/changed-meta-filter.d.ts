import type { SessionNotification } from "@agentclientprotocol/sdk";
type SessionUpdate = SessionNotification["update"];
/**
 * Removes the `_meta` keys of a `tool_call_update` that an earlier report of
 * the same tool call already sent with the same value.
 *
 * Only an AIR client gets the filtered updates, because AIR merges these
 * `_meta` keys. ACP does not define a merge for `_meta` keys, so another
 * client gets every key on every update.
 *
 * It runs on the final notification, after the native subagent routing,
 * because the routing reads `claudeCode.toolName` and
 * `claudeCode.parentToolUseId` on every update. It compares the keys of
 * `claudeCode`, of `jetbrains.air`, and the flags `is_mcp_tool_call` and
 * `terminal_info`. It never compares `terminal_output`,
 * `terminal_output_delta`, `terminal_exit`, or `mcp_output_delta`: a client
 * appends their data. An update with nothing left is dropped.
 */
export declare class ChangedMetaFilter {
    private readonly sent;
    /** Returns the update without the unchanged keys, or null when nothing is left. */
    apply(update: SessionUpdate): SessionUpdate | null;
    /** Stores the entry as the most recent one, and forgets the oldest one past the limit. */
    private remember;
}
export {};
//# sourceMappingURL=changed-meta-filter.d.ts.map
