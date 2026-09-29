import type { ToolReporter, ToolResultContext, ToolResultFacts, ToolUseFacts } from "../facts.js";
/** Agent and Task: a subagent. Its prompt is input that the user reads. */
export declare class AgentReporter implements ToolReporter {
    toolUse(input: unknown): ToolUseFacts;
    toolResult({ result, structured }: ToolResultContext): ToolResultFacts;
}
//# sourceMappingURL=agent.d.ts.map
