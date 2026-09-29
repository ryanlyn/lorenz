import type { AcpSessionNotification, SubagentState } from "./acp-subagents.js";
export type NativeSubagent = {
    sessionId: string;
    parentSessionId: string;
    parentToolUseId?: string;
    name: string;
    task: string;
    /**
     * The exact prompt of this generation, sent as `prompt` in
     * `subagent_spawned`. It is absent when the adapter has no prompt.
     */
    prompt?: string;
    announced?: boolean;
    terminalState?: SubagentState;
    /** Connection-local single-flight state; never serialized on the wire. */
    announcePromise?: Promise<void>;
    /** Connection-local single-flight state; never serialized on the wire. */
    terminalPromise?: Promise<void>;
};
export type NativeSubagentSession = {
    nativeSubagentsByTaskId?: Map<string, NativeSubagent>;
    nativeSubagentTaskIdByToolUseId?: Map<string, string>;
    nativeSubagentParentByToolUseId?: Map<string, string>;
};
type Publish = (notification: AcpSessionNotification) => Promise<void>;
type Logger = {
    log(message: string): void;
};
type TaskStarted = {
    taskId: string;
    toolUseId?: string | null;
    subagentType?: unknown;
    description?: unknown;
    prompt?: unknown;
};
/**
 * Owns the connection-local native subagent registry and all ACP lifecycle
 * ordering. The main agent only supplies SDK facts and delivers routed output.
 */
export declare class NativeSubagentRuntime {
    private readonly rootSessionId;
    private readonly session;
    private readonly publish;
    private readonly logger;
    readonly enabled: boolean;
    private readonly children;
    private readonly taskByToolUse;
    private readonly parentByToolUse;
    private readonly identityByToolUse;
    private readonly controlByToolUse;
    private readonly childByParentToolUse;
    /**
     * The child session of each tool call that went to a child session. A later
     * update of that tool call can lose `parentToolUseId`, for example a progress
     * beat after the child finished. It still belongs to the child session.
     */
    private readonly childByToolCall;
    private readonly taskFinishPromises;
    private readonly generationByTaskId;
    private readonly pending;
    private pendingCount;
    constructor(enabled: boolean, rootSessionId: string, session: NativeSubagentSession, publish: Publish, logger: Logger);
    route(notification: AcpSessionNotification, deliver: Publish, forcedSessionId?: string): Promise<AcpSessionNotification | null>;
    taskStarted(task: TaskStarted, deliver: Publish): Promise<void>;
    /**
     * Opens a new generation of a finished child when the SDK resumes the same
     * agent id. The SDK can resume a child without a new `task_started`, so a
     * running `task_updated` patch or a SendMessage `resumedAgentId` is the
     * signal. A child that did not finish is not changed. The `prompt` is the
     * SendMessage text that resumed the child, when the adapter knows it.
     */
    taskResumed(taskId: string, deliver: Publish, prompt?: string): Promise<void>;
    finishTask(taskId: string, status: unknown, deliver: Publish, toolUseId?: string | null): Promise<void>;
    finishAll(state: SubagentState, deliver: Publish): Promise<void>;
    discardPending(parentToolUseId: string): void;
    /**
     * Routes an update to the child session. An update of a finished child is
     * dropped: it never goes to the root session.
     */
    private toChild;
    /**
     * The route of the work that a child tool call started, for example an async
     * task. The route sends each update to the child generation that owned the
     * tool call when the work started, and drops the update after that child
     * finished. `undefined` means that the root session owns the tool call.
     * `eagerSessionId` is the session where a permission request created the
     * tool call before the stream routed it.
     */
    routeOfToolCall(toolCallId: string, eagerSessionId?: string): ((notification: AcpSessionNotification) => AcpSessionNotification | null) | undefined;
    private rememberToolCallOwner;
    /** The child generation with the ACP session `sessionId`, if one exists. */
    private childOfSession;
    clear(): void;
    private takePending;
    private buffer;
    private cleanupControl;
    /** The parent of a resumed generation: the old parent while it is live, else the root. */
    private resumedParentSessionId;
    private isLiveSession;
    /**
     * Registers a new child session for the task and makes it the owner of its
     * parent tool call. With `announce`, it publishes `subagent_spawned` and
     * delivers the updates that waited for the child.
     */
    private openGeneration;
    private nextChildSessionId;
}
export declare function announceNativeSubagent(child: NativeSubagent, publish: Publish): Promise<void>;
export declare function finishNativeSubagent(session: NativeSubagentSession, taskId: string, state: SubagentState, publish: Publish): Promise<void>;
/**
 * The agent id that a successful SendMessage result resumed. The SDK puts it
 * in `tool_use_result.resumedAgentId` when a finished agent runs again.
 */
export declare function resumedNativeSubagentId(toolUseResult: unknown): string | undefined;
/**
 * The SendMessage text that resumed the agent `agentId`. The tool uses of
 * `resultToolUseIds` come first: they are the SendMessage calls whose result
 * carried the resume. Otherwise the latest SendMessage call to `agentId` counts.
 */
export declare function sendMessageResumePrompt(toolUses: Record<string, {
    name: string;
    input: unknown;
} | undefined>, agentId: string, resultToolUseIds?: readonly string[]): string | undefined;
export declare function nativeSubagentState(status: unknown): SubagentState | undefined;
export declare function isNativeSubagentControlUpdate(update: AcpSessionNotification["update"]): update is Extract<AcpSessionNotification["update"], {
    sessionUpdate: "tool_call" | "tool_call_update";
}>;
export declare function isNativeSubagentControlTool(toolName: unknown): boolean;
export {};
//# sourceMappingURL=native-subagents.d.ts.map
