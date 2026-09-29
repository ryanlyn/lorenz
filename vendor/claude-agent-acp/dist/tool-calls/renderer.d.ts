import type { ClientCapabilities as AcpClientCapabilities, RequestPermissionRequest, SessionNotification, ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";
import { ClientCapabilities } from "./client-capabilities.js";
import type { ToolResultContext, ToolResultFacts, ToolUse, ToolUseFacts } from "./facts.js";
export type ToolCallUpdate = SessionNotification["update"];
/** The `_meta` of a tool call report. */
export type ToolUpdateMeta = {
    claudeCode?: {
        toolName?: string;
        toolResponse?: unknown;
        parentToolUseId?: string;
        nonExecutionKind?: string;
        userFeedback?: string;
        mcpServer?: {
            name: string;
            source: string;
        };
    };
    jetbrains?: {
        air?: {
            version?: number;
            commandTitle?: string;
            subagent?: true;
            skill?: {
                name: string;
                path?: string;
            };
            [key: string]: unknown;
        };
    };
    is_mcp_tool_call?: true;
    terminal_info?: {
        terminal_id: string;
    };
    terminal_output?: {
        terminal_id: string;
        data: string;
    };
    terminal_output_delta?: {
        terminal_id: string;
        data: string;
    };
    terminal_exit?: {
        terminal_id: string;
        exit_code: number;
        signal: string | null;
    };
};
/** The result fields of a tool call report, before the status and the tool name. */
export interface RenderedResult {
    title?: string;
    content?: ToolCallContent[];
    locations?: ToolCallLocation[];
    /** Present when the reporter decided the raw output. */
    rawOutput?: unknown;
    /** The plan file that `rawInput` names. See {@link ToolResultFacts.planFilePath}. */
    planFilePath?: string;
    /** See {@link ToolResultFacts.planFileReleased}. */
    planFileReleased?: boolean;
    _meta?: Pick<ToolUpdateMeta, "terminal_info" | "terminal_output" | "terminal_output_delta" | "terminal_exit">;
}
/** The SDK tool_result block that a result report reads. */
type ResultBlock = ToolResultContext["result"];
/**
 * Turns tool facts into the fields of the standard ACP tool call report, as
 * `docs/air-extensions.md#tool-call-contract` defines: each fact goes in one field.
 *
 * The {@link ToolReporter} of the tool reads the SDK data. The renderer
 * decides the fields from the facts and the {@link ClientCapabilities}. The
 * {@link ToolCallFieldTracker} runs after it and drops the fields that an
 * earlier report of the same tool call already sent.
 */
export declare class AcpToolCallRenderer {
    readonly capabilities: ClientCapabilities;
    /** True when the renderer reports the history of a loaded session. */
    readonly replay: boolean;
    constructor(capabilities?: ClientCapabilities,
    /** True when the renderer reports the history of a loaded session. */
    replay?: boolean);
    static for(capabilities: AcpClientCapabilities | null | undefined, replay?: boolean): AcpToolCallRenderer;
    /** The facts of a tool use. */
    facts(toolUse: Pick<ToolUse, "name" | "input">, cwd?: string): ToolUseFacts;
    /** The standard fields of a tool use: the title, the kind, the content, and the locations. */
    toolInfo(toolUse: ToolUse, cwd?: string): {
        title: string;
        kind: ToolUseFacts["kind"];
        content: ToolCallContent[];
        locations?: ToolCallLocation[];
    };
    /**
     * The first report of a tool call. `rawInput` is left out while the input
     * still streams: the consolidated message sends it once it is complete.
     */
    toolCall(toolUse: ToolUse, options?: {
        cwd?: string;
        inputComplete?: boolean;
        previewContent?: ToolCallContent[];
    }): ToolCallUpdate;
    /** The report of a tool call whose input is complete now. */
    refinement(toolUse: ToolUse, cwd?: string): ToolCallUpdate;
    /**
     * The report of a tool call from the complete top-level fields of its still
     * streaming input. It carries no content: content built from partial input
     * is misleading (an Edit without its `new_string` renders as a deletion) or
     * invalid. AIR gets no `rawInput`, which goes out once it is complete. Every
     * other client gets the partial input as `rawInput`.
     */
    partialRefinement(toolUse: Pick<ToolUse, "id" | "name">, input: unknown, cwd?: string): {
        locations?: ToolCallLocation[] | undefined;
        title: string;
        kind: import("@agentclientprotocol/sdk").ToolKind;
        rawInput?: unknown;
        _meta: ToolUpdateMeta;
        toolCallId: string;
        sessionUpdate: "tool_call_update";
    };
    /**
     * The tool call of a permission request: `toolCallId`, `title`, and
     * `rawInput`. The client already holds the rest. The request adds only what
     * it shows new: an exact preview patch, and a location that the tool call
     * does not have.
     */
    permissionToolCall(toolUse: ToolUse, options?: {
        cwd?: string;
        title?: string;
        previewContent?: ToolCallContent[];
        extraLocations?: ToolCallLocation[];
        meta?: ToolUpdateMeta;
        /** The content of a client that is not AIR, when the tool call has none. */
        fallbackContent?: ToolCallContent[];
    }): RequestPermissionRequest["toolCall"];
    /** The facts of a tool result. */
    resultFacts(toolUse: ToolUse, result: ResultBlock, structured?: unknown): ToolResultFacts;
    /** The result fields of a tool result, before the status and the tool name. */
    resultFields(toolUse: ToolUse, result: ResultBlock, structured?: unknown): RenderedResult;
    /**
     * The reports of a tool result. A command sends its output as a separate
     * report first, like codex-acp: the output, then the exit and the status.
     * The output travels once: the raw tool_result goes to `rawOutput` only
     * when no other field carries the result.
     */
    result(toolUse: ToolUse, result: ResultBlock, options?: {
        structured?: unknown;
        nonExecution?: Record<string, unknown>;
    }): ToolCallUpdate[];
    /**
     * Whether AIR shows [toolUse] as the list of viewed files: a read or a
     * search with a path in its locations or in the `path` of its input.
     */
    private namesViewedFile;
    /**
     * The report of a PostToolUse hook: the final change of an edit tool, and
     * the `status` and `isAsync` markers of the `tool_response`. The rest of the
     * `tool_response` repeats output that the content already carries.
     */
    hookResult(toolUse: Pick<ToolUse, "id" | "name">, toolResponse: unknown, cwd?: string): Promise<ToolCallUpdate | undefined>;
    /**
     * The report of a memory recall: a completed read tool call. A synthesis
     * shows the recalled text, a plain recall shows the memory files.
     */
    memoryRecall(recall: {
        uuid: string;
        mode: string;
        memories: {
            path: string;
            content?: string;
        }[];
    }): ToolCallUpdate;
    /**
     * The report of a tool call that a rule, the classifier, or a mode denied
     * before it ran. The reason is the result to show, so `toolResponse` keeps
     * only the reason type, and the SDK message when it differs from the reason.
     */
    permissionDenied(denial: {
        toolCallId: string;
        toolName: string;
        parentToolUseId?: string;
        decisionReasonType?: string;
        decisionReason?: string;
        message?: string;
    }): ToolCallUpdate;
    /**
     * The report of a tool progress beat. The field tracker sends the
     * `in_progress` status once, so a later beat carries only the progress.
     */
    progress(beat: {
        toolCallId: string;
        toolName?: string;
        parentToolUseId?: string;
        elapsedTimeSeconds: number;
        subagentType?: string;
        subagentRetry?: unknown;
    }): ToolCallUpdate;
    /**
     * `rawInput`. For AIR, without the file text that a diff holds, and with
     * the path of the plan file in place of the plan text.
     */
    rawInput(facts: ToolUseFacts, rawInput: unknown): unknown;
    /**
     * The content of a tool use. A command shows the terminal marker. An edit
     * shows its change. A display copy of the input goes only to a client that
     * does not render `rawInput` itself, and never next to a terminal.
     */
    toolUseContent(toolCallId: string, facts: ToolUseFacts): ToolCallContent[];
    /**
     * The `_meta` of a tool use report: the tool name, and for AIR the tool
     * flags under `_meta.jetbrains.air`. A shell description stays out of the
     * standard `title`, which clients use as the command preview. Every other
     * client gets only the upstream tool name.
     */
    toolUseMeta(toolUse: {
        name: string;
        input?: unknown;
    }, cwd?: string): ToolUpdateMeta;
}
export {};
//# sourceMappingURL=renderer.d.ts.map
