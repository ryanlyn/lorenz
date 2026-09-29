import { AIR_SUBAGENT_KEY, airExtensionMeta } from "./air-extension.js";
const MAX_PENDING_PARENTS = 64;
const MAX_PENDING_UPDATES = 256;
const MAX_PENDING_UPDATES_PER_PARENT = 32;
/** The number of child tool calls whose owning child session the runtime remembers. */
const MAX_CHILD_TOOL_CALLS = 2048;
/**
 * Owns the connection-local native subagent registry and all ACP lifecycle
 * ordering. The main agent only supplies SDK facts and delivers routed output.
 */
export class NativeSubagentRuntime {
    rootSessionId;
    session;
    publish;
    logger;
    enabled;
    children;
    taskByToolUse;
    parentByToolUse;
    identityByToolUse = new Map();
    controlByToolUse = new Map();
    childByParentToolUse = new Map();
    /**
     * The child session of each tool call that went to a child session. A later
     * update of that tool call can lose `parentToolUseId`, for example a progress
     * beat after the child finished. It still belongs to the child session.
     */
    childByToolCall = new Map();
    taskFinishPromises = new Map();
    generationByTaskId = new Map();
    pending = new Map();
    pendingCount = 0;
    constructor(enabled, rootSessionId, session, publish, logger) {
        this.rootSessionId = rootSessionId;
        this.session = session;
        this.publish = publish;
        this.logger = logger;
        this.enabled = enabled;
        this.children = session.nativeSubagentsByTaskId ??= new Map();
        this.taskByToolUse = session.nativeSubagentTaskIdByToolUseId ??= new Map();
        this.parentByToolUse = session.nativeSubagentParentByToolUseId ??= new Map();
        for (const child of this.children.values()) {
            if (child.parentToolUseId) {
                this.childByParentToolUse.set(child.parentToolUseId, child);
            }
        }
    }
    async route(notification, deliver, forcedSessionId) {
        const { update } = notification;
        const claudeMeta = update._meta?.claudeCode;
        const isControl = isNativeSubagentControlUpdate(update);
        if (!this.enabled)
            return notification;
        if (this.enabled && isControl) {
            const toolCallId = update.toolCallId;
            if (update.sessionUpdate === "tool_call") {
                this.controlByToolUse.set(toolCallId, notification);
            }
            const identity = subagentIdentity(update.rawInput);
            if (identity) {
                this.identityByToolUse.set(toolCallId, mergeSubagentIdentity(this.identityByToolUse.get(toolCallId), identity));
            }
            const parentSessionId = claudeMeta?.parentToolUseId
                ? this.childByParentToolUse.get(claudeMeta.parentToolUseId)?.sessionId
                : this.rootSessionId;
            this.parentByToolUse.set(toolCallId, parentSessionId ?? this.rootSessionId);
            const child = this.childByParentToolUse.get(toolCallId);
            if (child && !child.announced) {
                child.parentSessionId = parentSessionId ?? this.rootSessionId;
                applySubagentIdentity(child, this.identityByToolUse.get(toolCallId));
                await announceNativeSubagent(child, this.publish);
                for (const pending of this.takePending(toolCallId))
                    await deliver(pending);
            }
            if (!child && isFailedToolCallUpdate(update)) {
                this.takePending(toolCallId);
                const initial = this.controlByToolUse.get(toolCallId);
                this.cleanupControl(toolCallId);
                if (forcedSessionId) {
                    return { ...notification, sessionId: forcedSessionId };
                }
                return failedControlFallback(initial, notification, parentSessionId ?? this.rootSessionId);
            }
            return forcedSessionId ? { ...notification, sessionId: forcedSessionId } : null;
        }
        const toolCallId = update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
            ? update.toolCallId
            : undefined;
        // A permission request may have had to create the tool call before native
        // child ownership was known. Keep every later update in that original ACP
        // session; moving a lifecycle after its initial call creates an orphan in
        // both transcripts.
        if (forcedSessionId) {
            const forcedChild = this.childOfSession(forcedSessionId);
            if (toolCallId && forcedChild)
                this.rememberToolCallOwner(toolCallId, forcedChild);
            return { ...notification, sessionId: forcedSessionId };
        }
        const owner = toolCallId ? this.childByToolCall.get(toolCallId) : undefined;
        if (owner)
            return this.toChild(owner, notification, toolCallId);
        if (this.enabled && claudeMeta?.parentToolUseId) {
            const child = this.childByParentToolUse.get(claudeMeta.parentToolUseId);
            if (!child || !child.announced) {
                this.buffer(claudeMeta.parentToolUseId, notification);
                return null;
            }
            return this.toChild(child, notification, toolCallId);
        }
        return notification;
    }
    async taskStarted(task, deliver) {
        if (!this.enabled)
            return;
        if (!task.subagentType) {
            if (task.toolUseId) {
                this.takePending(task.toolUseId);
                this.cleanupControl(task.toolUseId);
            }
            return;
        }
        const previous = this.children.get(task.taskId);
        if (previous && previous.terminalState === undefined)
            return;
        // A SendMessage resume reuses the finished generation's tool id, whose
        // control state is already cleaned up.
        const knownParentSessionId = (task.toolUseId ? this.parentByToolUse.get(task.toolUseId) : undefined) ??
            (previous && this.resumedParentSessionId(previous));
        const identity = task.toolUseId ? this.identityByToolUse.get(task.toolUseId) : undefined;
        // A nested child must wait for the spawning Agent/Task frame to establish
        // its immediate parent. Root children without a tool id can be announced.
        await this.openGeneration(task.taskId, previous, {
            parentSessionId: knownParentSessionId ?? this.rootSessionId,
            parentToolUseId: task.toolUseId ?? undefined,
            name: subagentDisplayName(identity?.name, identity?.description ?? task.description, identity?.subagentType ?? task.subagentType, task.taskId),
            task: subagentDescription(identity?.prompt ?? task.prompt, identity?.description ?? task.description),
            ...promptField(promptText(task.prompt) ?? identity?.prompt),
        }, !!knownParentSessionId || !task.toolUseId, deliver);
    }
    /**
     * Opens a new generation of a finished child when the SDK resumes the same
     * agent id. The SDK can resume a child without a new `task_started`, so a
     * running `task_updated` patch or a SendMessage `resumedAgentId` is the
     * signal. A child that did not finish is not changed. The `prompt` is the
     * SendMessage text that resumed the child, when the adapter knows it.
     */
    async taskResumed(taskId, deliver, prompt) {
        if (!this.enabled)
            return;
        const previous = this.children.get(taskId);
        if (!previous)
            return;
        const finishing = this.taskFinishPromises.get(taskId) ?? previous.terminalPromise;
        if (finishing)
            await finishing.catch(() => { });
        if (this.children.get(taskId) !== previous || previous.terminalState === undefined)
            return;
        await this.openGeneration(taskId, previous, {
            parentSessionId: this.resumedParentSessionId(previous),
            parentToolUseId: previous.parentToolUseId,
            name: previous.name,
            task: previous.task,
            ...promptField(promptText(prompt)),
        }, true, deliver);
    }
    async finishTask(taskId, status, deliver, toolUseId) {
        if (!this.enabled)
            return;
        const state = nativeSubagentState(status);
        const child = toolUseId ? this.childByParentToolUse.get(toolUseId) : this.children.get(taskId);
        if (child && toolUseId && this.taskByToolUse.get(toolUseId) !== taskId)
            return;
        if (!state || !child || child.terminalState !== undefined)
            return;
        const existing = this.taskFinishPromises.get(taskId);
        if (existing)
            return existing;
        const finish = Promise.resolve().then(async () => {
            try {
                await announceNativeSubagent(child, this.publish);
                if (child.parentToolUseId) {
                    for (const pending of this.takePending(child.parentToolUseId))
                        await deliver(pending);
                }
                await finishNativeSubagent(this.session, taskId, state, this.publish);
            }
            finally {
                if (child.parentToolUseId) {
                    this.cleanupControl(child.parentToolUseId);
                }
            }
        });
        this.taskFinishPromises.set(taskId, finish);
        try {
            await finish;
        }
        finally {
            if (this.taskFinishPromises.get(taskId) === finish)
                this.taskFinishPromises.delete(taskId);
        }
    }
    async finishAll(state, deliver) {
        const errors = [];
        try {
            for (const taskId of [...this.children.keys()].reverse()) {
                try {
                    await this.finishTask(taskId, state, deliver);
                }
                catch (error) {
                    errors.push(error);
                }
            }
        }
        finally {
            this.pending.clear();
            this.pendingCount = 0;
            this.identityByToolUse.clear();
            this.controlByToolUse.clear();
            this.parentByToolUse.clear();
        }
        if (errors.length === 1)
            throw errors[0];
        if (errors.length > 1)
            throw new AggregateError(errors, "Failed to finish native subagents");
    }
    discardPending(parentToolUseId) {
        this.takePending(parentToolUseId);
    }
    /**
     * Routes an update to the child session. An update of a finished child is
     * dropped: it never goes to the root session.
     */
    toChild(child, notification, toolCallId) {
        if (child.terminalState !== undefined || child.terminalPromise) {
            this.logger.log(`Session ${this.rootSessionId}: ignoring late update for terminal subagent ${child.sessionId}`);
            return null;
        }
        if (toolCallId)
            this.rememberToolCallOwner(toolCallId, child);
        return { ...notification, sessionId: child.sessionId };
    }
    /**
     * The route of the work that a child tool call started, for example an async
     * task. The route sends each update to the child generation that owned the
     * tool call when the work started, and drops the update after that child
     * finished. `undefined` means that the root session owns the tool call.
     * `eagerSessionId` is the session where a permission request created the
     * tool call before the stream routed it.
     */
    routeOfToolCall(toolCallId, eagerSessionId) {
        if (!this.enabled)
            return undefined;
        const owner = this.childByToolCall.get(toolCallId) ??
            (eagerSessionId ? this.childOfSession(eagerSessionId) : undefined);
        return owner && ((notification) => this.toChild(owner, notification, undefined));
    }
    rememberToolCallOwner(toolCallId, child) {
        this.childByToolCall.delete(toolCallId);
        this.childByToolCall.set(toolCallId, child);
        if (this.childByToolCall.size > MAX_CHILD_TOOL_CALLS) {
            const oldest = this.childByToolCall.keys().next().value;
            if (oldest !== undefined)
                this.childByToolCall.delete(oldest);
        }
    }
    /** The child generation with the ACP session `sessionId`, if one exists. */
    childOfSession(sessionId) {
        if (sessionId === this.rootSessionId)
            return undefined;
        for (const child of this.children.values()) {
            if (child.sessionId === sessionId)
                return child;
        }
        return undefined;
    }
    clear() {
        this.children.clear();
        this.childByToolCall.clear();
        this.taskByToolUse.clear();
        this.parentByToolUse.clear();
        this.identityByToolUse.clear();
        this.controlByToolUse.clear();
        this.childByParentToolUse.clear();
        this.taskFinishPromises.clear();
        this.generationByTaskId.clear();
        this.pending.clear();
        this.pendingCount = 0;
    }
    takePending(parentToolUseId) {
        const updates = this.pending.get(parentToolUseId) ?? [];
        if (updates.length > 0) {
            this.pending.delete(parentToolUseId);
            this.pendingCount -= updates.length;
        }
        return updates;
    }
    buffer(parentToolUseId, notification) {
        const updates = this.pending.get(parentToolUseId);
        if (this.pendingCount >= MAX_PENDING_UPDATES ||
            (updates === undefined && this.pending.size >= MAX_PENDING_PARENTS) ||
            (updates?.length ?? 0) >= MAX_PENDING_UPDATES_PER_PARENT) {
            this.logger.log(`Session ${this.rootSessionId}: dropping unattributed subagent update for ${parentToolUseId}; pending buffer limit reached`);
            return;
        }
        if (updates)
            updates.push(notification);
        else
            this.pending.set(parentToolUseId, [notification]);
        this.pendingCount++;
    }
    cleanupControl(toolUseId) {
        this.identityByToolUse.delete(toolUseId);
        this.controlByToolUse.delete(toolUseId);
        this.parentByToolUse.delete(toolUseId);
    }
    /** The parent of a resumed generation: the old parent while it is live, else the root. */
    resumedParentSessionId(previous) {
        return this.isLiveSession(previous.parentSessionId)
            ? previous.parentSessionId
            : this.rootSessionId;
    }
    isLiveSession(sessionId) {
        if (sessionId === this.rootSessionId)
            return true;
        for (const child of this.children.values()) {
            if (child.sessionId === sessionId)
                return child.terminalState === undefined;
        }
        return false;
    }
    /**
     * Registers a new child session for the task and makes it the owner of its
     * parent tool call. With `announce`, it publishes `subagent_spawned` and
     * delivers the updates that waited for the child.
     */
    async openGeneration(taskId, previous, fields, announce, deliver) {
        const child = {
            sessionId: this.nextChildSessionId(taskId, previous),
            ...fields,
        };
        const toolUseId = child.parentToolUseId;
        this.children.set(taskId, child);
        if (toolUseId) {
            this.taskByToolUse.set(toolUseId, taskId);
            this.childByParentToolUse.set(toolUseId, child);
            this.controlByToolUse.delete(toolUseId);
        }
        if (!announce)
            return;
        await announceNativeSubagent(child, this.publish);
        for (const pending of toolUseId ? this.takePending(toolUseId) : [])
            await deliver(pending);
    }
    nextChildSessionId(taskId, previous) {
        if (!previous) {
            this.generationByTaskId.set(taskId, 1);
            return taskId;
        }
        const generation = (this.generationByTaskId.get(taskId) ?? 1) + 1;
        this.generationByTaskId.set(taskId, generation);
        return `${taskId}:generation:${generation}`;
    }
}
export async function announceNativeSubagent(child, publish) {
    if (child.announced)
        return;
    if (child.announcePromise)
        return child.announcePromise;
    const announce = Promise.resolve().then(async () => {
        await publish({
            sessionId: child.parentSessionId,
            update: {
                sessionUpdate: "subagent_spawned",
                subagentSessionId: child.sessionId,
                name: child.name,
                task: child.task,
                ...promptField(child.prompt),
                capabilities: {},
            },
        });
        child.announced = true;
    });
    child.announcePromise = announce;
    try {
        await announce;
    }
    finally {
        if (child.announcePromise === announce)
            child.announcePromise = undefined;
    }
}
export async function finishNativeSubagent(session, taskId, state, publish) {
    const child = session.nativeSubagentsByTaskId?.get(taskId);
    if (!child || child.terminalState !== undefined)
        return;
    if (child.terminalPromise)
        return child.terminalPromise;
    const finish = Promise.resolve().then(async () => {
        await announceNativeSubagent(child, publish);
        await publish({
            sessionId: child.parentSessionId,
            update: {
                sessionUpdate: "subagent_state_update",
                subagentSessionId: child.sessionId,
                state,
            },
        });
        child.terminalState = state;
    });
    child.terminalPromise = finish;
    try {
        await finish;
    }
    finally {
        if (child.terminalPromise === finish)
            child.terminalPromise = undefined;
    }
}
/**
 * The agent id that a successful SendMessage result resumed. The SDK puts it
 * in `tool_use_result.resumedAgentId` when a finished agent runs again.
 */
export function resumedNativeSubagentId(toolUseResult) {
    if (typeof toolUseResult !== "object" || toolUseResult === null)
        return undefined;
    const result = toolUseResult;
    return result.success === true ? nonBlankString(result.resumedAgentId) : undefined;
}
/**
 * The SendMessage text that resumed the agent `agentId`. The tool uses of
 * `resultToolUseIds` come first: they are the SendMessage calls whose result
 * carried the resume. Otherwise the latest SendMessage call to `agentId` counts.
 */
export function sendMessageResumePrompt(toolUses, agentId, resultToolUseIds = []) {
    for (const toolUseId of resultToolUseIds) {
        const toolUse = toolUses[toolUseId];
        if (toolUse?.name !== "SendMessage")
            continue;
        const text = promptText(toolUse.input?.message);
        if (text)
            return text;
    }
    if (resultToolUseIds.length > 0)
        return undefined;
    for (const toolUse of Object.values(toolUses).reverse()) {
        if (toolUse?.name !== "SendMessage")
            continue;
        const input = toolUse.input;
        if (input?.to === agentId)
            return promptText(input.message);
    }
    return undefined;
}
export function nativeSubagentState(status) {
    if (status === "completed")
        return "completed";
    if (status === "failed")
        return "failed";
    if (status === "disconnected")
        return "disconnected";
    if (status === "killed" || status === "cancelled" || status === "stopped")
        return "cancelled";
    return undefined;
}
export function isNativeSubagentControlUpdate(update) {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
        return false;
    }
    const claudeMeta = update._meta?.claudeCode;
    return (airExtensionMeta(update._meta)?.[AIR_SUBAGENT_KEY] === true ||
        isNativeSubagentControlTool(claudeMeta?.toolName));
}
export function isNativeSubagentControlTool(toolName) {
    return toolName === "Agent" || toolName === "Task";
}
function isFailedToolCallUpdate(update) {
    return ((update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
        update.status === "failed");
}
function failedControlFallback(initial, terminal, sessionId) {
    if (terminal.update.sessionUpdate !== "tool_call" &&
        terminal.update.sessionUpdate !== "tool_call_update") {
        return { ...terminal, sessionId };
    }
    if (!initial || initial.update.sessionUpdate !== "tool_call") {
        const claudeMeta = terminal.update._meta?.claudeCode;
        return {
            ...terminal,
            sessionId,
            update: {
                ...terminal.update,
                sessionUpdate: "tool_call",
                status: "failed",
                // The synthesized tool_call is this call's first report, so give it
                // the standard `name` the initial one would have carried.
                ...(typeof claudeMeta?.toolName === "string" ? { name: claudeMeta.toolName } : {}),
                title: typeof terminal.update.title === "string" && terminal.update.title.length > 0
                    ? terminal.update.title
                    : claudeMeta?.toolName === "Task"
                        ? "Task"
                        : "Agent",
                _meta: ordinaryToolMeta(terminal.update._meta),
            },
        };
    }
    return {
        ...initial,
        sessionId,
        update: {
            ...initial.update,
            ...terminal.update,
            sessionUpdate: "tool_call",
            status: "failed",
            title: typeof terminal.update.title === "string" && terminal.update.title.trim().length > 0
                ? terminal.update.title
                : initial.update.title,
            _meta: {
                ...initial.update._meta,
                ...terminal.update._meta,
                ...ordinaryToolMeta(initial.update._meta, terminal.update._meta),
            },
        },
    };
}
function ordinaryToolMeta(...values) {
    const merged = Object.assign({}, ...values);
    const claudeCode = Object.assign({}, ...values.map((value) => value?.claudeCode ?? {}));
    const result = { ...merged, claudeCode };
    const air = airExtensionMeta(merged);
    if (air && AIR_SUBAGENT_KEY in air) {
        const rest = { ...air };
        delete rest[AIR_SUBAGENT_KEY];
        result.jetbrains = { ...merged.jetbrains, air: rest };
    }
    return result;
}
function subagentDisplayName(explicitName, description, type, taskId) {
    for (const value of [explicitName, description, type]) {
        if (typeof value === "string" && value.trim().length > 0)
            return value.trim();
    }
    const suffix = taskId.length > 8 ? taskId.slice(-8) : taskId;
    return `Agent ${suffix}`;
}
function subagentDescription(prompt, description) {
    for (const value of [prompt, description]) {
        if (typeof value === "string" && value.trim().length > 0)
            return value.trim();
    }
    return "Delegated task";
}
function subagentIdentity(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input))
        return undefined;
    const value = input;
    const identity = {
        name: nonBlankString(value.name),
        description: nonBlankString(value.description),
        prompt: promptText(value.prompt),
        subagentType: nonBlankString(value.subagent_type),
    };
    return Object.values(identity).some(Boolean) ? identity : undefined;
}
function mergeSubagentIdentity(previous, next) {
    return {
        name: next.name ?? previous?.name,
        description: next.description ?? previous?.description,
        prompt: next.prompt ?? previous?.prompt,
        subagentType: next.subagentType ?? previous?.subagentType,
    };
}
function applySubagentIdentity(child, identity) {
    if (!identity)
        return;
    if (identity.name || identity.description) {
        child.name = subagentDisplayName(identity.name, identity.description, identity.subagentType, child.sessionId);
    }
    if (identity.prompt || identity.description) {
        child.task = subagentDescription(identity.prompt, identity.description);
    }
    child.prompt ??= identity.prompt;
}
/** The prompt text unchanged, or `undefined` when it is not a non-blank string. */
function promptText(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function promptField(prompt) {
    return prompt === undefined ? {} : { prompt };
}
function nonBlankString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
