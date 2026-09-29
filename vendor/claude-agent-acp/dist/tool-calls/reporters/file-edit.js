import { patchUpdateFromDiffToolResponse, toolUpdateFromDiffToolResponse } from "../../diff.js";
import { markdownEscape, resultText, textContent, toDisplayPath } from "../content.js";
/**
 * Write: the diff holds the file text. The PostToolUse hook sends the final
 * diff, so the result text is only a confirmation.
 */
export class WriteReporter {
    toolUse(input, { cwd, capabilities, replay }) {
        const write = normalizeWriteInput(input);
        const displayPath = write?.file_path ? toDisplayPath(write.file_path, cwd) : undefined;
        const facts = {
            title: displayPath ? `Write ${displayPath}` : "Preparing file…",
            kind: "edit",
            locations: write?.file_path ? [{ path: write.file_path }] : [],
        };
        if (write?.file_path) {
            // A negotiated client gets the exact patch from the approval preview or
            // from the PostToolUse hook. The input does not tell whether the file
            // exists, so the live tool call shows no diff: a diff without the old
            // text would claim a creation. The adapter reads the file only for the
            // preview. A replay has no preview and no hook, so it keeps the diff.
            if (!capabilities.diffPatch || replay) {
                facts.change = [
                    {
                        type: "diff",
                        path: write.file_path,
                        oldText: null,
                        // The content is absent until the input streams in. The diff still names the file.
                        newText: write.content,
                    },
                ];
            }
            // The patch holds the file text, so rawInput does not.
            if (write.contentKey)
                facts.fileTextKeys = [write.contentKey];
        }
        else if (write?.content) {
            facts.display = [textContent(write.content)];
        }
        return facts;
    }
    toolResult() {
        return {};
    }
    hookResult(toolResponse, context) {
        return finalChange(toolResponse, context);
    }
}
const WRITE_CONTENT_KEYS = ["content", "file_text", "file_content"];
/**
 * Reads a Write input the way the CLI validates it. Since CLI 2.1.280 the CLI
 * accepts `path` for `file_path`, and `file_text` or `file_content` for
 * `content`. The streamed tool use keeps the original keys. The canonical key
 * wins when both spellings are present.
 */
export function normalizeWriteInput(input) {
    if (!input || typeof input !== "object")
        return undefined;
    const raw = input;
    const filePath = typeof raw.file_path === "string"
        ? raw.file_path
        : typeof raw.path === "string"
            ? raw.path
            : undefined;
    const contentKey = WRITE_CONTENT_KEYS.find((key) => raw[key] !== undefined && raw[key] !== null);
    const content = contentKey ? raw[contentKey] : undefined;
    return { file_path: filePath, content, contentKey };
}
/** Edit: the diff holds the old and the new text. */
export class EditReporter {
    toolUse(input, { cwd }) {
        const edit = input;
        const displayPath = edit?.file_path ? toDisplayPath(edit.file_path, cwd) : undefined;
        const facts = {
            title: displayPath ? `Edit ${displayPath}` : "Edit",
            kind: "edit",
            locations: edit?.file_path ? [{ path: edit.file_path }] : [],
        };
        if (edit?.file_path && (edit.old_string || edit.new_string)) {
            // The standard diff, also for a client that negotiated patches: the
            // input holds a snippet, not the file, so a patch would need line
            // numbers that the adapter does not know here.
            facts.change = [
                {
                    type: "diff",
                    path: edit.file_path,
                    oldText: edit.old_string || null,
                    newText: edit.new_string ?? "",
                },
            ];
            facts.fileTextKeys = ["old_string", "new_string"];
        }
        return facts;
    }
    toolResult() {
        return {};
    }
    hookResult(toolResponse, context) {
        return finalChange(toolResponse, context);
    }
}
/**
 * The final change of an Edit or a Write, from the structuredPatch of the
 * PostToolUse `tool_response`. For Write it replaces the optimistic creation
 * diff with the real diff of an updated file. A negotiated client gets an
 * exact git patch built from the written file, or the standard diff when none
 * can be built.
 */
async function finalChange(toolResponse, { capabilities }) {
    if (!capabilities.diffPatch)
        return toolUpdateFromDiffToolResponse(toolResponse);
    const patch = await patchUpdateFromDiffToolResponse(toolResponse);
    if (patch)
        return patch;
    const created = createdFileDiff(toolResponse);
    return created ?? toolUpdateFromDiffToolResponse(toolResponse);
}
/**
 * The standard diff of a file that a Write created, when it cannot have an
 * exact patch. The Write tool call of a client with diffPatch shows no diff,
 * so without it the client would never see the created file.
 */
function createdFileDiff(toolResponse) {
    const response = toolResponse;
    if (response?.type !== "create" ||
        typeof response.filePath !== "string" ||
        typeof response.content !== "string") {
        return undefined;
    }
    return {
        content: [{ type: "diff", path: response.filePath, oldText: null, newText: response.content }],
        locations: [{ path: response.filePath }],
    };
}
/**
 * NotebookEdit: the new cell source is input. ACP has no notebook diff, and a
 * `diff` block would name the `.ipynb` file with cell text instead of file
 * text, so the source stays in `rawInput` and gets a display copy.
 *
 * Only AIR gets this rendering. Every other client gets the generic rendering
 * of the upstream adapter.
 */
export class NotebookEditReporter {
    toolUse(input, { cwd, capabilities }) {
        if (!capabilities.air.client)
            return { title: "NotebookEdit", kind: "other" };
        const notebook = input;
        const displayPath = notebook?.notebook_path
            ? toDisplayPath(notebook.notebook_path, cwd)
            : undefined;
        const cell = notebook?.cell_id ? ` ${notebook.cell_id}` : "";
        const verb = notebook?.edit_mode === "insert"
            ? "Insert"
            : notebook?.edit_mode === "delete"
                ? "Delete"
                : "Edit";
        const source = notebookSource(notebook);
        return {
            title: displayPath ? `${verb} cell${cell} in ${displayPath}` : "Edit notebook",
            kind: "edit",
            locations: notebook?.notebook_path ? [{ path: notebook.notebook_path }] : [],
            ...(source ? { display: source } : {}),
        };
    }
    /**
     * The result text repeats the new cell source, which the input holds. A
     * cell deletion has no source, so its result text is the result to show.
     */
    toolResult(context) {
        return context.capabilities.air.client &&
            notebookSource(context.toolUse.input)
            ? { rawOutput: undefined }
            : resultText(context.result);
    }
}
function notebookSource(input) {
    if (input?.edit_mode === "delete" || typeof input?.new_source !== "string")
        return undefined;
    return [textContent(markdownEscape(input.new_source))];
}
