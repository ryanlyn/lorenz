import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import type { AcpSessionNotification, AsyncTaskState } from "./acp-subagents.js";
type Publish = (notification: AcpSessionNotification) => Promise<void>;
/** Moves an update to its owner session, or drops it with `null`. */
type Route = (notification: AcpSessionNotification) => AcpSessionNotification | null;
type TaskIdentity = {
    taskId?: unknown;
    task_id?: unknown;
};
export type AsyncTaskStarted = TaskIdentity & {
    taskType?: unknown;
    task_type?: unknown;
    description?: unknown;
    subagentType?: unknown;
    subagent_type?: unknown;
    isBackgrounded?: unknown;
    is_backgrounded?: unknown;
    workflowName?: unknown;
    workflow_name?: unknown;
    skipTranscript?: unknown;
    skip_transcript?: unknown;
    outputFilePath?: unknown;
    output_file?: unknown;
    toolCallId?: unknown;
    tool_use_id?: unknown;
};
export type AsyncTaskUpdated = TaskIdentity & {
    patch?: TaskPatch;
};
type TaskPatch = {
    status?: unknown;
    description?: unknown;
    isBackgrounded?: unknown;
    is_backgrounded?: unknown;
    error?: unknown;
    outputFilePath?: unknown;
    output_file?: unknown;
};
export type AsyncTaskNotification = TaskIdentity & {
    status?: unknown;
    toolCallId?: unknown;
    tool_use_id?: unknown;
    summary?: unknown;
    outputFilePath?: unknown;
    output_file?: unknown;
};
type TaskProgress = TaskIdentity & {
    description?: unknown;
    toolCallId?: unknown;
    tool_use_id?: unknown;
    summary?: unknown;
    lastToolName?: unknown;
    last_tool_name?: unknown;
    usage?: unknown;
    outputFilePath?: unknown;
    output_file?: unknown;
};
type BackgroundTaskLevel = TaskIdentity & {
    taskType?: unknown;
    task_type?: unknown;
    description?: unknown;
};
export declare function clientSupportsAsyncTasks(capabilities?: ClientCapabilities | null): boolean;
/** Publishes Claude's non-agent background work as a separate AIR task lifecycle. */
export declare class AsyncTaskRuntime {
    readonly enabled: boolean;
    private readonly sessionId;
    private readonly publish;
    /** `notices`: the client can present `notice` updates, so the stop
     *  acknowledgement need not be a transcript line. `routeOf`: the route of
     *  the tasks that a tool call in another session started, for example in
     *  a native subagent session. */
    private readonly options;
    /**
     * One registry owns both active tasks and terminal tombstones. Keeping an
     * unannounced terminal record is intentional: the Bash result proving that
     * a command was backgrounded can arrive after its terminal SDK edge.
     */
    private readonly tasks;
    constructor(enabled: boolean, sessionId: string, publish: Publish,
    /** `notices`: the client can present `notice` updates, so the stop
     *  acknowledgement need not be a transcript line. `routeOf`: the route of
     *  the tasks that a tool call in another session started, for example in
     *  a native subagent session. */
    options?: {
        notices?: boolean;
        routeOf?: (toolCallId: string) => Route | undefined;
    });
    taskStarted(message: AsyncTaskStarted): Promise<void>;
    taskBackgrounded(message: AsyncTaskStarted): Promise<void>;
    taskUpdated(message: AsyncTaskUpdated): Promise<void>;
    taskUpdated(taskId: string, patch: TaskPatch): Promise<void>;
    taskProgress(message: TaskProgress): Promise<void>;
    taskNotification(message: AsyncTaskNotification): Promise<void>;
    taskNotification(taskId: string, status: unknown, summary?: unknown, outputFilePath?: unknown): Promise<void>;
    /**
     * Reconciles the SDK's replace-semantics background task level. It does not
     * create unknown tasks because this level normally precedes task_started and
     * carries no tool-call attribution. It can, however, promote a known
     * foreground task and terminate an announced task whose edge was lost.
     */
    backgroundTasksChanged(tasksOrMessage: readonly BackgroundTaskLevel[] | {
        tasks?: unknown;
    }): Promise<void>;
    finishAll(state: Extract<AsyncTaskState, "failed" | "stopped">): Promise<void>;
    canStop(taskId: string): boolean;
    claimStop(taskId: string): boolean;
    releaseStop(taskId: string): void;
    taskStopped(taskId: string): Promise<void>;
    /**
     * Sends the spawn of each held task without a tool call id. The prompt
     * result ends the model turn, and the result of the tool call that started a
     * task comes before it. So a held task is never held for longer than one turn.
     */
    releaseHeld(): Promise<void>;
    clear(): void;
    private task;
    private mergeStarted;
    /** Keeps the first tool call id that a later SDK message brings. */
    private mergeToolCallId;
    /** Sends an update of an announced task. A held task sends it after its spawn. */
    private whenAnnounced;
    private mergePatch;
    private mergeLevel;
    private mergeOutputFilePath;
    /**
     * Sends the spawn of the task. The spawn names the tool call that started the
     * task, so it waits for the tool call id: the task is held until the id
     * arrives. The id comes as `tool_use_id` of the SDK `task_started`,
     * `task_progress`, or `task_notification`, or from the Bash result of a
     * backgrounded command. A held task gets its spawn without the id when it
     * ends first, or when the prompt result ends the model turn
     * ({@link releaseHeld}). No guess by the command text binds a task.
     */
    private announce;
    private finish;
    private publishMetadata;
    /**
     * Publishes the progress fields that changed since the last report of the
     * task. A beat with nothing new is not sent.
     */
    private publishProgress;
    /** Publishes a state, with the output path and the tool call only when they changed. */
    private publishState;
    /** Publishes an update of the task in the session that owns the task. */
    private send;
}
/** Recovers background Bash lifecycle data exposed only on its tool result. */
export declare function backgroundBashTaskFromToolResult(content: unknown, toolUseResult: unknown, toolUses: Record<string, {
    name: string;
    input: unknown;
}>): AsyncTaskStarted | undefined;
export {};
//# sourceMappingURL=async-tasks.d.ts.map
