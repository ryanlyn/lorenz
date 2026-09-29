/** Longest free-form line that may serve as a notice title on its own. Past
 *  this the text moves to `description` under a generic title. */
export const MAX_NOTICE_TITLE_LENGTH = 256;
/** Whether the Client advertised `clientCapabilities.session.notices`. Agents
 *  MUST NOT send `notice` updates otherwise; the alternative is a bold-label
 *  transcript line, which was the only way to flag these before. */
export function clientSupportsNotices(capabilities) {
    const notices = capabilities?.session?.notices;
    return typeof notices === "object" && notices !== null && !Array.isArray(notices);
}
export function noticeUpdate(notice) {
    return {
        sessionUpdate: "notice",
        severity: notice.severity,
        title: notice.title,
        ...(notice.description ? { description: notice.description } : {}),
    };
}
/** The transcript rendering of a notice for clients without the capability. */
export function noticeTranscriptText(notice) {
    return notice.description ? `**${notice.title}:** ${notice.description}` : `**${notice.title}**`;
}
/** The update to send for `notice`: a `notice` when the client can present
 *  one, else an agent message carrying `transcriptText` (by default the
 *  bold-label rendering of the notice) and `transcriptMeta`, so clients
 *  without the capability can still tell the line apart from Claude's reply. */
export function noticeOrTranscriptUpdate(notice, supportsNotices, transcriptText = noticeTranscriptText(notice), transcriptMeta) {
    if (supportsNotices)
        return noticeUpdate(notice);
    return {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: transcriptText },
        ...(transcriptMeta ? { _meta: transcriptMeta } : {}),
    };
}
/** Fragments that read on after a bold label stand alone as a notice
 *  description, so start them with a capital. */
export function sentenceCase(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}
/** Collapses whitespace so a text shown as a notice can be recognized when
 *  the SDK repeats it elsewhere (a hook-blocked turn's result, for one). */
export function normalizeNoticeText(text) {
    return text.trim().replace(/\s+/g, " ");
}
/** Notice fields are plain text. Free-form SDK/hook output may carry light
 *  markdown that a transcript would render; drop the inline markers rather
 *  than show literal asterisks and backticks in a toast. */
export function noticePlainText(text) {
    return text
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
        .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
        .replace(/(?<![\w`])`([^`\n]+)`(?![\w`])/g, "$1");
}
/** Shapes free-form text into a notice title plus optional description: the
 *  first line stands as the title when it is short enough, otherwise the whole
 *  text becomes the description under `fallbackTitle`. */
export function splitNoticeText(text, fallbackTitle) {
    const trimmed = noticePlainText(text).trim();
    if (!trimmed)
        return { title: fallbackTitle };
    const lineBreak = trimmed.search(/\r?\n/);
    const firstLine = lineBreak === -1 ? trimmed : trimmed.slice(0, lineBreak).trimEnd();
    const rest = lineBreak === -1 ? "" : trimmed.slice(lineBreak).trim();
    if (firstLine.length > MAX_NOTICE_TITLE_LENGTH) {
        return { title: fallbackTitle, description: trimmed };
    }
    return rest ? { title: firstLine, description: rest } : { title: firstLine };
}
