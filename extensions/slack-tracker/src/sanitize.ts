/**
 * Outbound-text sanitization for every message the tracker writes into Slack.
 *
 * The one non-negotiable rule is broadcast protection: an agent-authored (or even
 * runtime-authored) body must never be able to page a channel. Slack only triggers a broadcast
 * when the text carries the angle-bracket command token (`<!channel>`, `<!here>`, `<!everyone>`,
 * `<!subteam^S…>`); the same words WITHOUT the token render as inert plain text. So the
 * sanitizer rewrites the token into its human-readable name and drops the brackets - the reader
 * still sees "@channel", nobody gets pinged, and there is no configuration knob to get wrong.
 *
 * Ordinary user mentions (`<@U…>`) are deliberately left intact: the tracker posts only into
 * issue threads, where addressing a participant is the point, and a user mention notifies one
 * person rather than a channel.
 */

/** `<!channel>` / `<!here>` / `<!everyone>`, with or without a `|label` pipe. */
const BROADCAST_COMMAND_RE = /<!(channel|here|everyone)(?:\|([^>]*))?>/gi;

/** `<!subteam^S123ABC>` or `<!subteam^S123ABC|@eng>`: a user-group broadcast. */
const SUBTEAM_COMMAND_RE = /<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/gi;

/**
 * Rewrite every Slack broadcast token in `text` into inert plain text. Unconditional by design:
 * there is no legitimate reason for the tracker to broadcast, so this is not policy - it is a
 * property of the write path.
 */
export function stripBroadcastMentions(text: string): string {
  return text
    .replace(BROADCAST_COMMAND_RE, (_match, name: string) => `@${name.toLowerCase()}`)
    .replace(SUBTEAM_COMMAND_RE, (_match, label: string | undefined) => {
      // The pipe label is Slack's own display text for the group (e.g. `@eng`); reuse it when
      // present so the message still reads naturally, minus the ping.
      const display = label?.trim();
      return display !== undefined && display !== "" ? display : "@group";
    });
}
