import type { ToolReporter, ToolResultContext, ToolResultFacts, ToolUseContext, ToolUseFacts } from "../facts.js";
/** Read: the file text is the result to show. */
export declare class ReadReporter implements ToolReporter {
    toolUse(input: unknown, { cwd }: ToolUseContext): ToolUseFacts;
    toolResult({ toolUse, result, structured }: ToolResultContext): ToolResultFacts;
}
//# sourceMappingURL=read.d.ts.map
