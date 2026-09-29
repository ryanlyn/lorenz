import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { findTranscript } from "./resumed-session.js";
/**
 * Finds the subagent transcripts of a session.
 *
 * Claude keeps the history of a subagent in its own transcript,
 * `<session>/subagents/agent-<id>.jsonl`, next to the session transcript.
 * The `agent-<id>.meta.json` file beside it names the launching tool use.
 * The ids are empty for a session without a local transcript.
 */
export async function subagentHistory(sessionId) {
    const ids = new Map();
    const transcript = await findTranscript(sessionId);
    if (!transcript)
        return { ids };
    const directory = path.join(path.dirname(transcript), sessionId, "subagents");
    let names;
    try {
        names = await readdir(directory);
    }
    catch {
        return { ids };
    }
    await Promise.all(names.map(async (name) => {
        const match = /^agent-(.+)\.meta\.json$/.exec(name);
        if (!match)
            return;
        try {
            const meta = JSON.parse(await readFile(path.join(directory, name), "utf8"));
            const toolUseId = meta?.toolUseId;
            if (typeof toolUseId === "string")
                ids.set(toolUseId, match[1]);
        }
        catch {
            // A damaged meta file leaves its subagent without history.
        }
    }));
    if (ids.size === 0)
        return { ids };
    // The folder name encodes the project directory, and the encoding loses
    // characters. The session info reads it back from the transcript.
    const dir = (await getSessionInfo(sessionId).catch(() => undefined))?.cwd;
    return dir ? { ids, dir } : { ids };
}
