import type { ToolReporter, ToolUseFacts } from "../facts.js";
/** Glob: the file list is the result to show. */
export declare class GlobReporter implements ToolReporter {
    toolUse(input: unknown): ToolUseFacts;
}
/** Grep: the title is the equivalent grep command line. */
export declare class GrepReporter implements ToolReporter {
    toolUse(input: unknown): ToolUseFacts;
}
//# sourceMappingURL=search.d.ts.map
