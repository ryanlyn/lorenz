import { AIR_COMMAND_TITLE_KEY, AIR_SKILL_KEY, AIR_SUBAGENT_KEY, withAirMeta, } from "../air-extension.js";
import { exitPlanModeRawOutput } from "../exit-plan.js";
import { ClientCapabilities } from "./client-capabilities.js";
import { resultText, textContent, toAcpContentUpdate, toolResponseMarkers } from "./content.js";
import { reporterFor } from "./reporters/index.js";
import { resolveSkillPath } from "./reporters/interaction.js";
/** The id suffix of the call that clears the plan file of an approved plan for AIR. */
const PLAN_FILE_CLEAR_SUFFIX = ":plan-file-clear";
/**
 * Turns tool facts into the fields of the standard ACP tool call report, as
 * `docs/air-extensions.md#tool-call-contract` defines: each fact goes in one field.
 *
 * The {@link ToolReporter} of the tool reads the SDK data. The renderer
 * decides the fields from the facts and the {@link ClientCapabilities}. The
 * {@link ToolCallFieldTracker} runs after it and drops the fields that an
 * earlier report of the same tool call already sent.
 */
export class AcpToolCallRenderer {
    capabilities;
    replay;
    constructor(capabilities = new ClientCapabilities(),
    /** True when the renderer reports the history of a loaded session. */
    replay = false) {
        this.capabilities = capabilities;
        this.replay = replay;
    }
    static for(capabilities, replay = false) {
        return new AcpToolCallRenderer(ClientCapabilities.from(capabilities), replay);
    }
    /** The facts of a tool use. */
    facts(toolUse, cwd) {
        return reporterFor(toolUse.name).toolUse(toolUse.input, {
            cwd,
            capabilities: this.capabilities,
            replay: this.replay,
        });
    }
    /** The standard fields of a tool use: the title, the kind, the content, and the locations. */
    toolInfo(toolUse, cwd) {
        const facts = this.facts(toolUse, cwd);
        return {
            title: facts.title,
            kind: facts.kind,
            content: this.toolUseContent(toolUse.id, facts),
            ...(facts.locations !== undefined ? { locations: facts.locations } : {}),
        };
    }
    /**
     * The first report of a tool call. `rawInput` is left out while the input
     * still streams: the consolidated message sends it once it is complete.
     */
    toolCall(toolUse, options = {}) {
        const facts = this.facts(toolUse, options.cwd);
        const isMcp = toolUse.name.startsWith("mcp__");
        return {
            _meta: {
                ...this.toolUseMeta(toolUse, options.cwd),
                ...(facts.command && this.capabilities.terminalOutput
                    ? { terminal_info: { terminal_id: toolUse.id } }
                    : {}),
                // Only AIR gets the MCP flag. The upstream adapter does not send it.
                ...(isMcp && this.capabilities.air.client ? { is_mcp_tool_call: true } : {}),
            },
            toolCallId: toolUse.id,
            sessionUpdate: "tool_call",
            name: toolUse.name,
            // AIR gets `rawInput` once it is complete. Every other client gets the
            // input as it stands, also the empty input at the stream start.
            ...(options.inputComplete === false && this.capabilities.air.client
                ? {}
                : { rawInput: this.rawInput(facts, toolUse.input) }),
            status: "pending",
            title: facts.title,
            kind: facts.kind,
            content: options.previewContent ?? this.toolUseContent(toolUse.id, facts),
            ...(facts.locations !== undefined ? { locations: facts.locations } : {}),
        };
    }
    /** The report of a tool call whose input is complete now. */
    refinement(toolUse, cwd) {
        const facts = this.facts(toolUse, cwd);
        return {
            _meta: this.toolUseMeta(toolUse, cwd),
            toolCallId: toolUse.id,
            sessionUpdate: "tool_call_update",
            rawInput: this.rawInput(facts, toolUse.input),
            title: facts.title,
            kind: facts.kind,
            content: this.toolUseContent(toolUse.id, facts),
            ...(facts.locations !== undefined ? { locations: facts.locations } : {}),
        };
    }
    /**
     * The report of a tool call from the complete top-level fields of its still
     * streaming input. It carries no content: content built from partial input
     * is misleading (an Edit without its `new_string` renders as a deletion) or
     * invalid. AIR gets no `rawInput`, which goes out once it is complete. Every
     * other client gets the partial input as `rawInput`.
     */
    partialRefinement(toolUse, input, cwd) {
        const facts = this.facts({ name: toolUse.name, input }, cwd);
        return {
            _meta: this.toolUseMeta({ name: toolUse.name, input }, cwd),
            toolCallId: toolUse.id,
            sessionUpdate: "tool_call_update",
            ...(this.capabilities.air.client ? {} : { rawInput: input }),
            title: facts.title,
            kind: facts.kind,
            ...(facts.locations ? { locations: facts.locations } : {}),
        };
    }
    /**
     * The tool call of a permission request: `toolCallId`, `title`, and
     * `rawInput`. The client already holds the rest. The request adds only what
     * it shows new: an exact preview patch, and a location that the tool call
     * does not have.
     */
    permissionToolCall(toolUse, options = {}) {
        const facts = this.facts(toolUse, options.cwd);
        if (!this.capabilities.air.client) {
            // The upstream shape: the whole tool call again.
            const content = this.toolUseContent(toolUse.id, facts);
            const locations = [...(facts.locations ?? []), ...(options.extraLocations ?? [])];
            return {
                toolCallId: toolUse.id,
                name: toolUse.name,
                status: "pending",
                rawInput: toolUse.input,
                title: options.title ?? facts.title,
                kind: facts.kind,
                content: content.length === 0 && options.fallbackContent ? options.fallbackContent : content,
                ...(facts.locations !== undefined || options.extraLocations?.length ? { locations } : {}),
                ...(options.meta ? { _meta: options.meta } : {}),
            };
        }
        return {
            toolCallId: toolUse.id,
            title: options.title ?? facts.title,
            rawInput: this.rawInput(facts, toolUse.input),
            ...(options.previewContent ? { content: options.previewContent } : {}),
            ...(options.extraLocations?.length
                ? { locations: [...(facts.locations ?? []), ...options.extraLocations] }
                : {}),
            ...(options.meta ? { _meta: options.meta } : {}),
        };
    }
    /** The facts of a tool result. */
    resultFacts(toolUse, result, structured) {
        const reporter = reporterFor(toolUse.name);
        const context = {
            toolUse,
            result,
            structured,
            capabilities: this.capabilities,
        };
        const content = result.content;
        const hasErrorText = result.is_error === true &&
            content !== undefined &&
            content !== null &&
            (typeof content === "string" || Array.isArray(content)) &&
            content.length > 0;
        if (hasErrorText) {
            return reporter.errorResult?.(context) ?? toAcpContentUpdate(content, true);
        }
        return reporter.toolResult ? reporter.toolResult(context) : resultText(result);
    }
    /** The result fields of a tool result, before the status and the tool name. */
    resultFields(toolUse, result, structured) {
        const facts = this.resultFacts(toolUse, result, structured);
        const { command, ...fields } = facts;
        if (!command)
            return fields;
        // The terminal was announced under the tool_use id (see `toolCall`), so the
        // output keys off that id. A non-string id is no id at all.
        const idOf = (id) => (typeof id === "string" && id.length > 0 ? id : undefined);
        const terminalId = idOf(toolUse.id) ?? idOf(result.tool_use_id);
        // Without a terminal id nothing can match the output. A client that
        // buffers output for an unknown terminal would hold it forever, so the
        // output becomes a code block instead.
        if (this.capabilities.terminalOutput && terminalId !== undefined) {
            const output = { terminal_id: terminalId, data: command.output };
            return {
                ...fields,
                // A client that is not AIR gets the terminal content again, like
                // upstream: it replaces a denial text that an earlier update showed.
                ...(this.capabilities.air.client
                    ? {}
                    : { content: [{ type: "terminal", terminalId }] }),
                _meta: {
                    terminal_info: { terminal_id: terminalId },
                    ...(this.capabilities.terminalOutputDelta
                        ? { terminal_output_delta: output }
                        : { terminal_output: output }),
                    terminal_exit: { terminal_id: terminalId, exit_code: command.exitCode, signal: null },
                },
            };
        }
        return command.output.trim()
            ? {
                ...fields,
                content: [
                    {
                        type: "content",
                        content: {
                            type: "text",
                            text: `\`\`\`console\n${command.output.trimEnd()}\n\`\`\``,
                        },
                    },
                ],
            }
            : fields;
    }
    /**
     * The reports of a tool result. A command sends its output as a separate
     * report first, like codex-acp: the output, then the exit and the status.
     * The output travels once: the raw tool_result goes to `rawOutput` only
     * when no other field carries the result.
     */
    result(toolUse, result, options = {}) {
        const { _meta: resultMeta, ...fields } = this.resultFields(toolUse, result, options.structured);
        // AIR shows a read or a search that names a path as the list of viewed
        // files. That view does not show the text of the result, so it stays out.
        const viewedFiles = this.capabilities.air.client && result.is_error !== true && this.namesViewedFile(toolUse);
        if (viewedFiles) {
            const content = fields.content?.filter((item) => !(item.type === "content" && item.content.type === "text"));
            if (content?.length)
                fields.content = content;
            else
                delete fields.content;
        }
        const updates = [];
        const terminalOutput = resultMeta?.terminal_output_delta ?? resultMeta?.terminal_output;
        if (terminalOutput) {
            updates.push({
                _meta: resultMeta?.terminal_output_delta
                    ? { terminal_output_delta: terminalOutput }
                    : { terminal_output: terminalOutput },
                toolCallId: toolUse.id,
                sessionUpdate: "tool_call_update",
            });
        }
        // AIR gets the raw tool_result only when no other field carries the
        // result. Every other client gets it unless the terminal carried it.
        const rawOutput = !this.capabilities.air.client
            ? terminalOutput
                ? undefined
                : exitPlanModeRawOutput(toolUse.name, result.content)
            : "rawOutput" in fields
                ? fields.rawOutput
                : viewedFiles || terminalOutput || fields.content !== undefined
                    ? undefined
                    : result.content;
        delete fields.rawOutput;
        // A plan file that the result names goes out also when the input did not
        // name it. The field tracker drops a path that the client holds.
        const planFilePath = fields.planFilePath;
        delete fields.planFilePath;
        const planFileReleased = fields.planFileReleased === true;
        delete fields.planFileReleased;
        updates.push({
            _meta: {
                claudeCode: { toolName: toolUse.name, ...(options.nonExecution ?? {}) },
                ...(resultMeta?.terminal_exit ? { terminal_exit: resultMeta.terminal_exit } : {}),
            },
            toolCallId: toolUse.id,
            sessionUpdate: "tool_call_update",
            status: result.is_error === true ? "failed" : "completed",
            ...(rawOutput !== undefined ? { rawOutput } : {}),
            ...(planFilePath ? { rawInput: planFileInput(toolUse.input, planFilePath) } : {}),
            ...fields,
        });
        // AIR keeps the plan file button while the last reported path names a
        // file, and a blank path is its clear signal. The clear goes as a call of
        // its own, so the plan card of this call keeps its file.
        if (planFilePath && planFileReleased && result.is_error !== true) {
            updates.push({
                toolCallId: `${toolUse.id}${PLAN_FILE_CLEAR_SUFFIX}`,
                sessionUpdate: "tool_call",
                title: "Exited Plan Mode",
                kind: "switch_mode",
                status: "completed",
                rawInput: { planFilePath: "" },
                content: [],
            });
        }
        return updates;
    }
    /**
     * Whether AIR shows [toolUse] as the list of viewed files: a read or a
     * search with a path in its locations or in the `path` of its input.
     */
    namesViewedFile(toolUse) {
        const facts = this.facts(toolUse);
        if (facts.kind !== "read" && facts.kind !== "search")
            return false;
        if (facts.locations?.some((location) => location.path))
            return true;
        const path = toolUse.input?.path;
        return typeof path === "string" && path.length > 0;
    }
    /**
     * The report of a PostToolUse hook: the final change of an edit tool, and
     * the `status` and `isAsync` markers of the `tool_response`. The rest of the
     * `tool_response` repeats output that the content already carries.
     */
    async hookResult(toolUse, toolResponse, cwd) {
        const reporter = reporterFor(toolUse.name);
        const change = reporter.hookResult
            ? await reporter.hookResult(toolResponse, { cwd, capabilities: this.capabilities })
            : {};
        if (!this.capabilities.air.client) {
            // The upstream shape: the whole tool_response, on every hook.
            return {
                _meta: { claudeCode: { toolResponse, toolName: toolUse.name } },
                toolCallId: toolUse.id,
                sessionUpdate: "tool_call_update",
                ...(change.content ? { content: change.content } : {}),
                ...(change.locations ? { locations: change.locations } : {}),
            };
        }
        const markers = toolResponseMarkers(toolResponse);
        if (!markers && !change.content && !change.locations)
            return undefined;
        return {
            _meta: {
                claudeCode: { ...(markers ? { toolResponse: markers } : {}), toolName: toolUse.name },
            },
            toolCallId: toolUse.id,
            sessionUpdate: "tool_call_update",
            ...(change.content ? { content: change.content } : {}),
            ...(change.locations ? { locations: change.locations } : {}),
        };
    }
    /**
     * The report of a memory recall: a completed read tool call. A synthesis
     * shows the recalled text, a plain recall shows the memory files.
     */
    memoryRecall(recall) {
        const isSynthesis = recall.mode === "synthesize";
        const locations = isSynthesis ? [] : recall.memories.map((memory) => ({ path: memory.path }));
        const content = isSynthesis
            ? recall.memories.flatMap((memory) => typeof memory.content === "string" ? [textContent(memory.content)] : [])
            : [];
        const count = recall.memories.length;
        return {
            sessionUpdate: "tool_call",
            toolCallId: recall.uuid,
            title: isSynthesis
                ? "Recalled synthesized memory"
                : `Recalled ${count} ${count === 1 ? "memory" : "memories"}`,
            kind: "read",
            status: "completed",
            ...(locations.length > 0 && { locations }),
            ...(content.length > 0 && { content }),
            _meta: {
                claudeCode: { toolName: "memory_recall", toolResponse: { mode: recall.mode } },
            },
        };
    }
    /**
     * The report of a tool call that a rule, the classifier, or a mode denied
     * before it ran. The reason is the result to show, so `toolResponse` keeps
     * only the reason type, and the SDK message when it differs from the reason.
     */
    permissionDenied(denial) {
        const reason = denial.decisionReason ?? denial.message;
        // AIR gets the SDK message only when it differs from the reason, which
        // the content shows. Every other client gets the upstream toolResponse.
        const extraMessage = !this.capabilities.air.client
            ? { decisionReason: denial.decisionReason, message: denial.message }
            : denial.decisionReason !== undefined &&
                denial.message !== undefined &&
                denial.message !== denial.decisionReason
                ? { message: denial.message }
                : {};
        return {
            sessionUpdate: "tool_call_update",
            toolCallId: denial.toolCallId,
            status: "failed",
            content: [textContent(`Permission denied: ${reason}`)],
            _meta: {
                claudeCode: {
                    toolName: denial.toolName,
                    ...(denial.parentToolUseId ? { parentToolUseId: denial.parentToolUseId } : {}),
                    toolResponse: { decisionReasonType: denial.decisionReasonType, ...extraMessage },
                },
            },
        };
    }
    /**
     * The report of a tool progress beat. The field tracker sends the
     * `in_progress` status once, so a later beat carries only the progress.
     */
    progress(beat) {
        return {
            sessionUpdate: "tool_call_update",
            toolCallId: beat.toolCallId,
            status: "in_progress",
            _meta: {
                claudeCode: {
                    ...(beat.toolName !== undefined ? { toolName: beat.toolName } : {}),
                    ...(beat.parentToolUseId ? { parentToolUseId: beat.parentToolUseId } : {}),
                    toolResponse: {
                        elapsedTimeSeconds: beat.elapsedTimeSeconds,
                        // For Agent/Task calls: the subagent type, and the SDK retry
                        // counters while the subagent waits out an API rate limit, so a
                        // client can show why a spawn looks stalled.
                        ...(beat.subagentType !== undefined && { subagentType: beat.subagentType }),
                        ...(beat.subagentRetry !== undefined && { subagentRetry: beat.subagentRetry }),
                    },
                },
            },
        };
    }
    /**
     * `rawInput`. For AIR, without the file text that a diff holds, and with
     * the path of the plan file in place of the plan text.
     */
    rawInput(facts, rawInput) {
        if (facts.planFilePath)
            return planFileInput(rawInput, facts.planFilePath);
        if (!this.capabilities.air.client ||
            !facts.fileTextKeys ||
            !rawInput ||
            typeof rawInput !== "object" ||
            Array.isArray(rawInput)) {
            return rawInput;
        }
        const input = { ...rawInput };
        for (const key of facts.fileTextKeys)
            delete input[key];
        return input;
    }
    /**
     * The content of a tool use. A command shows the terminal marker. An edit
     * shows its change. A display copy of the input goes only to a client that
     * does not render `rawInput` itself, and never next to a terminal.
     */
    toolUseContent(toolCallId, facts) {
        const terminal = facts.command === true && this.capabilities.terminalOutput;
        return [
            ...(terminal ? [{ type: "terminal", terminalId: toolCallId }] : []),
            ...(facts.change ?? []),
            ...(!terminal && !this.capabilities.air.rawInputRendering ? (facts.display ?? []) : []),
        ];
    }
    /**
     * The `_meta` of a tool use report: the tool name, and for AIR the tool
     * flags under `_meta.jetbrains.air`. A shell description stays out of the
     * standard `title`, which clients use as the command preview. Every other
     * client gets only the upstream tool name.
     */
    toolUseMeta(toolUse, cwd) {
        const input = toolUse.input !== null && typeof toolUse.input === "object"
            ? toolUse.input
            : {};
        const description = (toolUse.name === "Bash" || toolUse.name === "PowerShell") &&
            typeof input.description === "string"
            ? input.description
            : undefined;
        const skillName = toolUse.name === "Skill" && typeof input.skill === "string" ? input.skill : undefined;
        const subagent = toolUse.name === "Agent" || toolUse.name === "Task";
        if (!this.capabilities.air.client)
            return { claudeCode: { toolName: toolUse.name } };
        let meta = { claudeCode: { toolName: toolUse.name } };
        if (description)
            meta = withAirMeta(meta, AIR_COMMAND_TITLE_KEY, description);
        if (subagent)
            meta = withAirMeta(meta, AIR_SUBAGENT_KEY, true);
        if (skillName) {
            const skillPath = resolveSkillPath(skillName, cwd);
            meta = withAirMeta(meta, AIR_SKILL_KEY, {
                name: skillName,
                ...(skillPath ? { path: skillPath } : {}),
            });
        }
        return meta;
    }
}
/** The input with the path of the plan file in place of the plan text. */
function planFileInput(rawInput, planFilePath) {
    const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? { ...rawInput }
        : {};
    delete input.plan;
    return { ...input, planFilePath };
}
