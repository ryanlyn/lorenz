import { type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
type ResumeLogger = {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
};
export type ResumedSessionSnapshot = {
    messages?: SessionMessage[];
    model?: string;
};
/** Return the concrete model recorded by the last real assistant response.
 * Claude Code restores a resumed query from this same transcript field.
 * Synthetic assistant records use angle-bracket placeholders and do not
 * describe a model the resumed query can run. */
export declare function resumedModelFromTranscript(messages: SessionMessage[]): string | undefined;
/** Read the resume model from the local transcript without starting a Claude
 * control request. This is intentionally on the load critical path. */
export declare function readResumedSession(sessionId: string, logger?: ResumeLogger): Promise<ResumedSessionSnapshot>;
/**
 * Read the resume model of a session from the end of its local transcript.
 *
 * A resume needs only the model, not the messages. The transcript file is
 * read backwards until the last real assistant record of the main thread, so
 * the cost does not grow with the length of the session. A session without a
 * local transcript file falls back to {@link readResumedSession}.
 */
export declare function readResumedModel(sessionId: string, logger?: ResumeLogger): Promise<string | undefined>;
/** The local transcript of a session in any project directory, as the SDK looks it up. */
export declare function findTranscript(sessionId: string): Promise<string | undefined>;
export {};
//# sourceMappingURL=resumed-session.d.ts.map
