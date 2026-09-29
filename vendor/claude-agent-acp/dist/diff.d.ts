import { ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";
/**
 * The largest file, in bytes, that the adapter turns into a git patch.
 *
 * A larger file, a larger new text, or an Edit whose result can be larger
 * gets no patch. The tool call then keeps its standard ACP content. The limit
 * bounds the file read, the replacement, and the line diff that run while
 * Claude waits for an approval.
 */
export declare const MAX_PATCH_FILE_BYTES: number;
/**
 * One unified-diff hunk in the `diff` package convention.
 *
 * A side with zero lines stores the number of the line after the change as its
 * start. {@link hunkHeader} converts that start to the git convention.
 */
interface PatchHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
}
/** The kind of file change that a git patch describes. */
type FileChange = "create" | "update";
/**
 * Builds the exact patch shown before Claude runs an Edit or Write tool.
 *
 * Returns undefined when the adapter cannot predict the file change exactly.
 * The caller then keeps the standard tool-call content. The adapter declines
 * a file that is missing for an Edit, too large, binary, or that has CR line
 * endings. Claude converts the line endings of an edited file, so an in-memory
 * replacement would not match the bytes that Claude writes. It also declines
 * an `old_string` that does not match exactly once, because Claude then
 * normalizes quotes or fails.
 *
 * A Write always gets content that shows the change: the patch, the standard
 * diff of a text that cannot have an exact patch, or a notice that the Write
 * overwrites a file that the adapter cannot show.
 *
 * The preview uses the tool input as it is. Claude can still remove the
 * trailing whitespace of a line before it writes. The PostToolUse hook then
 * sends the patch of the written file.
 */
export declare function previewPatchContent(toolName: string, input: Record<string, unknown>, cwd?: string): Promise<ToolCallContent[] | undefined>;
/**
 * Builds the git patch for a finished Edit or Write from the file on disk.
 *
 * The Claude SDK `structuredPatch` is display data: Claude converts leading
 * tabs to spaces and CRLF line endings to LF before it computes the hunks. A
 * patch built from those hunks does not match the file. This function diffs
 * `originalFile` against the written file instead. It returns undefined when
 * it cannot build an exact patch, and the caller then sends the standard diff.
 * A written file that contains a CR or a byte order mark is declined, because
 * Claude removed those bytes from `originalFile`.
 */
export declare function patchUpdateFromDiffToolResponse(toolResponse: unknown): Promise<{
    content: ToolCallContent[];
    locations: ToolCallLocation[];
} | undefined>;
/**
 * Builds standard ACP diff content from the structured toolResponse provided
 * by the PostToolUse hook for diff-producing tools (Edit, Write). Unlike
 * parsing the plain unified diff string, this uses the pre-parsed
 * structuredPatch which supports multiple replacement sites (replaceAll) and
 * always includes context lines for better readability.
 */
export declare function toolUpdateFromDiffToolResponse(toolResponse: unknown): {
    content?: ToolCallContent[];
    locations?: ToolCallLocation[];
};
/**
 * The text of one git patch for `filePath`.
 *
 * The headers follow `git diff`: the path loses its leading slash, gets the
 * `a/` and `b/` prefixes, and is quoted when git would quote it. A created
 * file gets its mode line and a `/dev/null` side.
 */
export declare function gitPatchText(filePath: string, change: FileChange, hunks: PatchHunk[]): string;
export {};
//# sourceMappingURL=diff.d.ts.map
