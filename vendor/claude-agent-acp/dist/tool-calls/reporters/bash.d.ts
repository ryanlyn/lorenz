import type { ToolReporter, ToolResultContext, ToolResultFacts, ToolUseFacts } from "../facts.js";
/** Bash and PowerShell: a command whose output goes to the terminal channel. */
export declare class BashReporter implements ToolReporter {
    toolUse(input: unknown): ToolUseFacts;
    /** A client with a terminal reads a failed command from the terminal channel. */
    errorResult(context: ToolResultContext): ToolResultFacts | undefined;
    toolResult({ result, structured }: ToolResultContext): ToolResultFacts;
}
//# sourceMappingURL=bash.d.ts.map
