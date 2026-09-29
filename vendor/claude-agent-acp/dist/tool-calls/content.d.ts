import type { ContentBlock, ToolCallContent } from "@agentclientprotocol/sdk";
import { DocumentBlockParam, ImageBlockParam, TextBlockParam, ToolResultBlockParam, WebSearchResultBlock, WebSearchToolResultBlockParam, WebSearchToolResultError } from "@anthropic-ai/sdk/resources";
import { BetaBashCodeExecutionResultBlock, BetaBashCodeExecutionToolResultBlockParam, BetaBashCodeExecutionToolResultError, BetaCodeExecutionResultBlock, BetaCodeExecutionToolResultBlockParam, BetaCodeExecutionToolResultError, BetaImageBlockParam, BetaRequestMCPToolResultBlockParam, BetaTextEditorCodeExecutionCreateResultBlock, BetaTextEditorCodeExecutionStrReplaceResultBlock, BetaTextEditorCodeExecutionToolResultBlockParam, BetaTextEditorCodeExecutionToolResultError, BetaTextEditorCodeExecutionViewResultBlock, BetaToolReferenceBlock, BetaToolResultBlockParam, BetaToolSearchToolResultBlockParam, BetaToolSearchToolResultError, BetaToolSearchToolSearchResultBlock, BetaWebFetchBlock, BetaWebFetchToolResultBlockParam, BetaWebFetchToolResultErrorBlock, BetaWebSearchToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta.mjs";
/**
 * Union of all possible content types that can appear in tool results from the Anthropic SDK.
 * These are transformed to valid ACP ContentBlock types by toValidAcpContent().
 */
export type ToolResultContent = TextBlockParam | DocumentBlockParam | ImageBlockParam | BetaImageBlockParam | BetaToolReferenceBlock | BetaToolSearchToolSearchResultBlock | BetaToolSearchToolResultError | WebSearchResultBlock | WebSearchToolResultError | BetaWebFetchBlock | BetaWebFetchToolResultErrorBlock | BetaCodeExecutionResultBlock | BetaCodeExecutionToolResultError | BetaBashCodeExecutionResultBlock | BetaBashCodeExecutionToolResultError | BetaTextEditorCodeExecutionViewResultBlock | BetaTextEditorCodeExecutionCreateResultBlock | BetaTextEditorCodeExecutionStrReplaceResultBlock | BetaTextEditorCodeExecutionToolResultError;
/**
 * Convert an absolute file path to a project-relative path for display.
 * Returns the original path if it's outside the project directory or if no cwd is provided.
 */
export declare function toDisplayPath(filePath: string, cwd?: string): string;
/**
 * Narrow the untyped message-level `tool_use_result` toward a per-tool Output
 * shape: rejects everything but a plain non-null object (arrays pass a bare
 * `typeof === "object"` check, so they're excluded here). The returned value
 * is only *nominally* typed — it arrives over the wire from arbitrary CLI
 * versions, so each caller must still guard the specific fields it reads
 * before trusting them.
 */
export declare function structuredResult<T extends object>(toolUseResult: unknown): T | undefined;
/** One display format for a web-search hit, shared by the structured
 *  WebSearchOutput render and the server-side `web_search_result` block so
 *  the two paths can't drift. */
export declare function formatWebSearchHit(hit: {
    title: string;
    url: string;
}): string;
export declare function toAcpContentUpdate(content: any, isError?: boolean): {
    content?: ToolCallContent[];
};
export declare function toAcpContentBlock(content: ToolResultContent, isError: boolean): ContentBlock;
export declare function markdownEscape(text: string): string;
/** Every SDK block that reports the result of a tool use. */
export type ToolResultBlock = ToolResultBlockParam | BetaToolResultBlockParam | BetaWebSearchToolResultBlockParam | BetaWebFetchToolResultBlockParam | WebSearchToolResultBlockParam | BetaCodeExecutionToolResultBlockParam | BetaBashCodeExecutionToolResultBlockParam | BetaTextEditorCodeExecutionToolResultBlockParam | BetaRequestMCPToolResultBlockParam | BetaToolSearchToolResultBlockParam;
/** One text content block. */
export declare function textContent(text: string): ToolCallContent;
/** The result text that the model saw, as the result to show. */
export declare function resultText(result: {
    content?: unknown;
    is_error?: boolean | null;
}): {
    content?: ToolCallContent[];
};
/**
 * The marker fields of a PostToolUse `tool_response` that clients read.
 *
 * The full `tool_response` repeats the tool output. A Read holds the whole
 * file, a Bash holds stdout and stderr, and a Write holds the content. The
 * tool-call content already carries that output. JetBrains AIR reads
 * `status` and `isAsync` to detect an async subagent launch, so only those
 * fields stay. Returns undefined when neither field is present.
 */
export declare function toolResponseMarkers(toolResponse: unknown): {
    status?: string;
    isAsync?: boolean;
} | undefined;
//# sourceMappingURL=content.d.ts.map
