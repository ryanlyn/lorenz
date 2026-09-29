/** The `_meta` namespaces whose keys a client merges one by one. */
const MERGED_NAMESPACES = ["claudeCode"];
/** The top-level `_meta` flags that stay the same for a tool call. */
const FLAGS = ["is_mcp_tool_call", "terminal_info"];
/** The number of tool calls whose `_meta` the filter remembers. */
const TOOL_CALL_LIMIT = 2048;
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
export class ChangedMetaFilter {
    sent = new Map();
    /** Returns the update without the unchanged keys, or null when nothing is left. */
    apply(update) {
        if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
            return update;
        }
        let held = this.sent.get(update.toolCallId);
        if (update.sessionUpdate === "tool_call" || !held) {
            held = new Map();
            this.remember(update.toolCallId, held);
            recordAndStrip(held, update._meta, false);
            return update;
        }
        this.remember(update.toolCallId, held);
        if (!update._meta)
            return update;
        const meta = structuredClone(update._meta);
        recordAndStrip(held, meta, true);
        const filtered = { ...update, _meta: meta };
        if (Object.keys(meta).length === 0)
            delete filtered._meta;
        const carriesSomething = Object.keys(filtered).some((key) => key !== "sessionUpdate" && key !== "toolCallId");
        return carriesSomething ? filtered : null;
    }
    /** Stores the entry as the most recent one, and forgets the oldest one past the limit. */
    remember(toolCallId, held) {
        this.sent.delete(toolCallId);
        this.sent.set(toolCallId, held);
        if (this.sent.size > TOOL_CALL_LIMIT) {
            const oldest = this.sent.keys().next().value;
            if (oldest !== undefined)
                this.sent.delete(oldest);
        }
    }
}
/** Records the compared keys of `meta`. With `strip`, deletes the unchanged ones. */
function recordAndStrip(held, meta, strip) {
    if (!meta)
        return;
    const keep = (key, value) => {
        const json = JSON.stringify(value);
        if (strip && held.get(key) === json)
            return false;
        held.set(key, json);
        return true;
    };
    const mergeKeys = (prefix, values) => {
        for (const [key, value] of Object.entries(values)) {
            if (!keep(prefix + key, value))
                delete values[key];
        }
    };
    for (const namespace of MERGED_NAMESPACES) {
        const values = asRecord(meta[namespace]);
        if (!values)
            continue;
        mergeKeys(`${namespace}.`, values);
        if (Object.keys(values).length === 0)
            delete meta[namespace];
    }
    const jetbrains = asRecord(meta.jetbrains);
    const air = asRecord(jetbrains?.air);
    if (jetbrains && air) {
        mergeKeys("jetbrains.air.", air);
        if (Object.keys(air).length === 0)
            delete jetbrains.air;
        if (Object.keys(jetbrains).length === 0)
            delete meta.jetbrains;
    }
    for (const flag of FLAGS) {
        if (meta[flag] !== undefined && !keep(flag, meta[flag]))
            delete meta[flag];
    }
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
