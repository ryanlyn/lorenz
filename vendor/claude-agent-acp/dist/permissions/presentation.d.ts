import type { RequestPermissionRequest, ToolCallContent } from "@agentclientprotocol/sdk";
import { ClientCapabilities } from "../tool-calls/client-capabilities.js";
export interface ClaudePermissionPresentationInput {
    toolName: string;
    input: Record<string, unknown>;
    toolUseID: string;
    cwd?: string;
    capabilities?: ClientCapabilities;
    /** The exact patch of the change to approve, for a negotiated `diffPatch` client. */
    previewContent?: ToolCallContent[];
    blockedPath?: string;
    title?: string;
    displayName?: string;
    description?: string;
    decisionReason?: string;
    defaultToNo?: boolean;
}
/**
 * The permission request presentation.
 *
 * The request `toolCall` carries `toolCallId`, `title`, and `rawInput`. The
 * adapter emits the `tool_call` before the request, so the client already
 * holds the rest. The request adds only what it shows new: the exact preview
 * patch, and the blocked path when the tool call has no such location.
 */
export declare function buildClaudePermissionPresentation(value: ClaudePermissionPresentationInput): Pick<RequestPermissionRequest, "toolCall" | "_meta">;
//# sourceMappingURL=presentation.d.ts.map
