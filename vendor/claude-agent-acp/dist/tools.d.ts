import type { PlanEntry, ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { TaskCreateInput, TaskCreateOutput, TaskListOutput, TaskUpdateInput, TaskUpdateOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import type { ToolResultBlock } from "./tool-calls/content.js";
import { type RenderedResult } from "./tool-calls/renderer.js";
export { markdownEscape, toDisplayPath } from "./tool-calls/content.js";
/**
 * The title, kind, content, and locations of a tool use, for a client with the
 * given terminal and patch capabilities. The {@link AcpToolCallRenderer} builds
 * them from the facts of the tool reporter.
 */
export declare function toolInfoFromToolUse(toolUse: any, supportsTerminalOutput?: boolean, cwd?: string, supportsDiffPatch?: boolean): {
    title: string;
    kind: ToolKind;
    content: ToolCallContent[];
    locations?: ToolCallLocation[];
};
/**
 * The result fields of a tool result, for a client with the given terminal
 * capabilities. The {@link AcpToolCallRenderer} builds them from the facts of
 * the tool reporter.
 */
export declare function toolUpdateFromToolResult(toolResult: ToolResultBlock, toolUse: any | undefined, supportsTerminalOutput?: boolean, toolUseResult?: unknown, preferTerminalOutputDelta?: boolean): RenderedResult;
export type ClaudePlanEntry = {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm: string;
};
export declare function planEntries(input: {
    todos: ClaudePlanEntry[];
} | undefined): PlanEntry[];
/**
 * Per-session task list accumulated from Task* tool calls (TaskCreate /
 * TaskUpdate). The headless/SDK session emits these as incremental tool
 * calls keyed by task ID, replacing the snapshot-style TodoWrite tool.
 * Iteration order is insertion order (Map semantics), matching the order
 * tasks are created.
 */
export type TaskEntry = {
    subject: string;
    status: "pending" | "in_progress" | "completed";
    activeForm?: string;
    description?: string;
};
export type TaskState = Map<string, TaskEntry>;
export declare function parseTaskCreateOutput(content: unknown): TaskCreateOutput | undefined;
export declare function parseTaskListOutput(content: unknown): TaskListOutput | undefined;
export declare function parseTaskUpdateOutput(content: unknown, expectedTaskId?: string): TaskUpdateOutput | undefined;
export declare function applyTaskCreate(state: TaskState, input: TaskCreateInput | undefined, output: TaskCreateOutput | undefined): void;
export declare function applyTaskUpdate(state: TaskState, input: TaskUpdateInput | undefined): void;
export declare function applyTaskList(state: TaskState, output: TaskListOutput): void;
export declare function taskStateToPlanEntries(state: TaskState): PlanEntry[];
/**
 * The plan entries of the task list, or undefined when the client already
 * holds the same entries. The TaskCreated and TaskCompleted hooks and the
 * Task* tool results report the same change, so the second report of a
 * change has nothing new.
 *
 * Only an AIR client skips the repeated plan. Every other client gets every
 * plan, like upstream.
 */
export declare function changedTaskPlanEntries(state: TaskState, airClient: boolean): PlanEntry[] | undefined;
/** Forgets the plan that the client holds, so that the next plan goes out, for example on replay. */
export declare function forgetPublishedTaskPlan(state: TaskState): void;
export declare const registerHookCallback: (toolUseID: string, { onPostToolUseHook, onRelease, }: {
    onPostToolUseHook?: (toolUseID: string, toolInput: unknown, toolResponse: unknown) => Promise<void>;
    onRelease?: () => void;
}, ownerId?: string) => void;
export declare function unregisterHookCallback(toolUseID: string): void;
/** Whether a PostToolUse callback for the tool use is still registered. */
export declare function hasHookCallback(toolUseID: string): boolean;
/** PostToolUse normally follows tool_result, so keep the callback for a short
 * grace period while still bounding retention when the hook never arrives. */
export declare function completeHookCallback(toolUseID: string): void;
export declare function clearHookCallbacks(ownerId: string): void;
export declare const createPostToolUseHook: (options?: {
    onEnterPlanMode?: () => Promise<void>;
}) => HookCallback;
/**
 * Hook callback for `TaskCreated` / `TaskCompleted` events. The SDK fires
 * these for both user-facing TaskCreate tool calls and subagent task
 * creation, giving us `task_id` + `task_subject` without having to parse
 * tool_result payloads.
 *
 * Populating `taskState` from the hook means a later `TaskUpdate` (which
 * typically only carries `taskId` + `status`) finds an existing entry with
 * a real subject, instead of synthesizing a placeholder with empty content.
 */
export declare const createTaskHook: (options: {
    taskState: TaskState;
    onChange?: () => Promise<void>;
}) => HookCallback;
//# sourceMappingURL=tools.d.ts.map
