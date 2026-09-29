import type { ToolReporter, ToolResultContext, ToolResultFacts, ToolUseContext, ToolUseFacts } from "../facts.js";
/**
 * ExitPlanMode: the plan is input that the user approves.
 *
 * Claude writes the plan to a file under `plansDirectory` while it drafts it.
 * The CLI adds the file text as `plan` and the file path as `planFilePath` to
 * the complete input. A `planFile` client gets the path and reads the plan
 * from the file. Without the file, it gets the plan text like other clients.
 */
export declare class ExitPlanModeReporter implements ToolReporter {
    toolUse(input: unknown, { capabilities }: ToolUseContext): ToolUseFacts;
    /** The approval text repeats the plan, which the input holds. */
    toolResult(context: ToolResultContext): ToolResultFacts;
    /**
     * The rejection reason has no display form. Claude fences it, so unfence it.
     * A client that is not AIR gets the error text as the result to show.
     */
    errorResult(context: ToolResultContext): ToolResultFacts | undefined;
}
/** AskUserQuestion: the questions are input that the user reads. */
export declare class AskUserQuestionReporter implements ToolReporter {
    /**
     * AIR gets a fixed title, because the question is input. Every other client
     * gets the question of a single question as the title, like upstream.
     */
    toolUse(input: unknown, { capabilities }: ToolUseContext): ToolUseFacts;
}
/** Skill: the skill name is the label. The result is a confirmation. */
export declare class SkillReporter implements ToolReporter {
    toolUse(input: unknown): ToolUseFacts;
    toolResult(): ToolResultFacts;
}
/**
 * TodoWrite and the Task* tools. The stream reports them as a plan. Only a
 * permission request surfaces them as a tool call.
 */
export declare class PlanToolReporter implements ToolReporter {
    private readonly toolName;
    constructor(toolName: string);
    toolUse(input: unknown): ToolUseFacts;
}
/** ReportFindings: the findings are input that the user reads. */
export declare class ReportFindingsReporter implements ToolReporter {
    toolUse(input: unknown): ToolUseFacts;
}
/** Every other tool, MCP tools too: the result text is the result to show. */
export declare class GenericReporter implements ToolReporter {
    private readonly toolName;
    constructor(toolName: string);
    toolUse(input: unknown): ToolUseFacts;
}
/**
 * An agent control tool (SendMessage, TaskStop, ListAgents, Monitor). AIR
 * shows the result in its own frame and parses the JSON result of SendMessage
 * and TaskStop. So AIR gets the error text as plain text, without a fence.
 * A client that is not AIR gets the fenced error text.
 */
export declare class AgentControlReporter extends GenericReporter {
    errorResult({ result, capabilities }: ToolResultContext): ToolResultFacts | undefined;
}
/**
 * Absolute path of a skill's `SKILL.md`, or `undefined` when none of the known layouts holds one.
 *
 * The `Skill` tool reports only the skill's name, so the file has to be located by probing the layouts skills
 * actually use: project- and user-level `.claude/skills` (plus this repo's `.agents/skills` source of truth), and
 * for a `<prefix>:<name>` spelling either a plugin (`.claude/plugins/<prefix>/skills/<name>`) or a
 * directory-scoped skill (`<prefix>/.claude/skills/<name>`), which share that spelling. Only a path that exists
 * on disk is returned, so a wrong guess costs nothing and clients never render a link to a missing file.
 */
export declare function resolveSkillPath(skillName: string, cwd?: string): string | undefined;
//# sourceMappingURL=interaction.d.ts.map
