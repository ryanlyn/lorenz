/** Where the subagent transcripts of a session are. */
export interface SubagentHistory {
    /** The subagent id of each Agent or Task tool use that launched a subagent. */
    ids: Map<string, string>;
    /**
     * The project directory of the session, as the SDK takes it in `dir`. With
     * it, the SDK reads a subagent transcript without a search of every project.
     */
    dir?: string;
}
/**
 * Finds the subagent transcripts of a session.
 *
 * Claude keeps the history of a subagent in its own transcript,
 * `<session>/subagents/agent-<id>.jsonl`, next to the session transcript.
 * The `agent-<id>.meta.json` file beside it names the launching tool use.
 * The ids are empty for a session without a local transcript.
 */
export declare function subagentHistory(sessionId: string): Promise<SubagentHistory>;
//# sourceMappingURL=subagent-history.d.ts.map
