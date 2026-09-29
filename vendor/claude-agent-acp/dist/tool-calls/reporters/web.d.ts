import type { ToolReporter, ToolResultContext, ToolResultFacts, ToolUseFacts } from "../facts.js";
/** WebFetch: the prompt is input that the user reads. The answer is the result. */
export declare class WebFetchReporter implements ToolReporter {
    toolUse(input: unknown): ToolUseFacts;
}
/** WebSearch: the hits are the result to show. */
export declare class WebSearchReporter implements ToolReporter {
    toolUse(input: unknown): ToolUseFacts;
    toolResult({ result, structured }: ToolResultContext): ToolResultFacts;
}
//# sourceMappingURL=web.d.ts.map
