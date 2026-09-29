import type { FileWriteInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import type { ToolReporter, ToolResultContext, ToolResultFacts, ToolUseContext, ToolUseFacts } from "../facts.js";
/**
 * Write: the diff holds the file text. The PostToolUse hook sends the final
 * diff, so the result text is only a confirmation.
 */
export declare class WriteReporter implements ToolReporter {
    toolUse(input: unknown, { cwd, capabilities, replay }: ToolUseContext): ToolUseFacts;
    toolResult(): ToolResultFacts;
    hookResult(toolResponse: unknown, context: ToolUseContext): Promise<ToolResultFacts>;
}
/** A Write input with the canonical keys, and the input key that holds the file text. */
type NormalizedWriteInput = Partial<FileWriteInput> & {
    contentKey?: string;
};
/**
 * Reads a Write input the way the CLI validates it. Since CLI 2.1.280 the CLI
 * accepts `path` for `file_path`, and `file_text` or `file_content` for
 * `content`. The streamed tool use keeps the original keys. The canonical key
 * wins when both spellings are present.
 */
export declare function normalizeWriteInput(input: unknown): NormalizedWriteInput | undefined;
/** Edit: the diff holds the old and the new text. */
export declare class EditReporter implements ToolReporter {
    toolUse(input: unknown, { cwd }: ToolUseContext): ToolUseFacts;
    toolResult(): ToolResultFacts;
    hookResult(toolResponse: unknown, context: ToolUseContext): Promise<ToolResultFacts>;
}
/**
 * NotebookEdit: the new cell source is input. ACP has no notebook diff, and a
 * `diff` block would name the `.ipynb` file with cell text instead of file
 * text, so the source stays in `rawInput` and gets a display copy.
 *
 * Only AIR gets this rendering. Every other client gets the generic rendering
 * of the upstream adapter.
 */
export declare class NotebookEditReporter implements ToolReporter {
    toolUse(input: unknown, { cwd, capabilities }: ToolUseContext): ToolUseFacts;
    /**
     * The result text repeats the new cell source, which the input holds. A
     * cell deletion has no source, so its result text is the result to show.
     */
    toolResult(context: ToolResultContext): ToolResultFacts;
}
export {};
//# sourceMappingURL=file-edit.d.ts.map
