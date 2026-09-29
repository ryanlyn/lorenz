import type { ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk";
/** Fire-and-forget advisory text for the user: live events rather than
 *  conversation history. See the ACP Session Notices RFD
 *  (https://agentclientprotocol.com/rfds/session-notices). */
export type SessionNotice = {
    severity: "info" | "warning" | "error";
    /** Plain text that stands alone. */
    title: string;
    /** Plain-text detail or guidance. */
    description?: string;
};
/** Longest free-form line that may serve as a notice title on its own. Past
 *  this the text moves to `description` under a generic title. */
export declare const MAX_NOTICE_TITLE_LENGTH = 256;
/** Whether the Client advertised `clientCapabilities.session.notices`. Agents
 *  MUST NOT send `notice` updates otherwise; the alternative is a bold-label
 *  transcript line, which was the only way to flag these before. */
export declare function clientSupportsNotices(capabilities?: ClientCapabilities | null): boolean;
export declare function noticeUpdate(notice: SessionNotice): SessionNotification["update"];
/** The transcript rendering of a notice for clients without the capability. */
export declare function noticeTranscriptText(notice: SessionNotice): string;
/** The update to send for `notice`: a `notice` when the client can present
 *  one, else an agent message carrying `transcriptText` (by default the
 *  bold-label rendering of the notice) and `transcriptMeta`, so clients
 *  without the capability can still tell the line apart from Claude's reply. */
export declare function noticeOrTranscriptUpdate(notice: SessionNotice, supportsNotices: boolean, transcriptText?: string, transcriptMeta?: Record<string, unknown>): SessionNotification["update"];
/** Fragments that read on after a bold label stand alone as a notice
 *  description, so start them with a capital. */
export declare function sentenceCase(text: string): string;
/** Collapses whitespace so a text shown as a notice can be recognized when
 *  the SDK repeats it elsewhere (a hook-blocked turn's result, for one). */
export declare function normalizeNoticeText(text: string): string;
/** Notice fields are plain text. Free-form SDK/hook output may carry light
 *  markdown that a transcript would render; drop the inline markers rather
 *  than show literal asterisks and backticks in a toast. */
export declare function noticePlainText(text: string): string;
/** Shapes free-form text into a notice title plus optional description: the
 *  first line stands as the title when it is short enough, otherwise the whole
 *  text becomes the description under `fallbackTitle`. */
export declare function splitNoticeText(text: string, fallbackTitle: string): Pick<SessionNotice, "title" | "description">;
//# sourceMappingURL=session-notices.d.ts.map
