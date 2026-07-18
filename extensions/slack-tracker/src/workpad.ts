import type { Settings } from "@lorenz/domain";

import { emojiForState, statusEmojiMap } from "./mapping.js";
import { stripBroadcastMentions } from "./sanitize.js";
import type { ThreadWorkpad } from "./threadState.js";
import { WORKPAD_METADATA_EVENT } from "./transport.js";
import type { SlackPostOptions, SlackTransport } from "./transport.js";
import { makeMetadataSeq } from "./webTransport.js";

/**
 * The workpad: ONE bot message per issue thread, edited in place, that carries the live plan
 * checklist, the latest note, and the Cancel/Details buttons. It replaces the old convention of
 * posting the whole "Lorenz Workpad" template as a stream of comments - milestone comments still
 * post as replies (replies notify; edits do not), while the continuously-changing checklist
 * lives here without spamming the thread.
 *
 * Like the reaction mirror, the workpad is a DISPLAY surface, never state: the fold recognizes
 * it by its `lorenz_workpad` metadata purely to skip it as a status event and to round-trip the
 * plan/note sections. Losing or failing to edit a workpad never blocks a transition - the
 * fallback is always "post a fresh one and repoint".
 */

/** `action_id`s the interaction handler routes on (see interactions.ts). */
export const WORKPAD_CANCEL_ACTION = "lorenz_cancel";
export const WORKPAD_DETAILS_ACTION = "lorenz_details";

/** Bound on the metadata-carried sections; Slack caps message metadata at a few KB. */
const SECTION_MAX_CHARS = 2_000;

export interface WorkpadContent {
  issueId: string;
  state: string;
  plan?: string | undefined;
  note?: string | undefined;
}

/** Clamp a section to the metadata budget, marking the cut so nothing truncates silently. */
function clampWorkpadSection(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (text.length <= SECTION_MAX_CHARS) return text;
  return `${text.slice(0, SECTION_MAX_CHARS - 12)}\n… (clipped)`;
}

/** The workpad's Block Kit body plus its plain-text fallback. */
export function renderWorkpadBlocks(content: WorkpadContent, settings: Settings): SlackPostOptions {
  const safeContent: WorkpadContent = {
    ...content,
    plan: sanitizeWorkpadSection(content.plan),
    note: sanitizeWorkpadSection(content.note),
  };
  const emoji = emojiForState(safeContent.state, statusEmojiMap(settings));
  const statusLine = `*Status:* ${emoji ? `:${emoji}: ` : ""}${safeContent.state}`;
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: statusLine } }];
  if (safeContent.plan !== undefined && safeContent.plan.trim() !== "") {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: safeContent.plan } });
  }
  if (safeContent.note !== undefined && safeContent.note.trim() !== "") {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: safeContent.note }],
    });
  }
  blocks.push({
    type: "actions",
    block_id: "lorenz_workpad_actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Details" },
        action_id: WORKPAD_DETAILS_ACTION,
        value: content.issueId,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Cancel" },
        action_id: WORKPAD_CANCEL_ACTION,
        style: "danger",
        value: content.issueId,
        confirm: {
          title: { type: "plain_text", text: "Cancel this issue?" },
          text: {
            type: "plain_text",
            text: "Posts a Cancelled status; the running agent is stopped by the daemon.",
          },
          confirm: { type: "plain_text", text: "Cancel issue" },
          deny: { type: "plain_text", text: "Keep working" },
        },
      },
    ],
  });
  return {
    blocks,
    metadata: {
      eventType: WORKPAD_METADATA_EVENT,
      payload: {
        issue: content.issueId,
        seq: makeMetadataSeq(),
        ...(safeContent.plan !== undefined ? { plan: safeContent.plan } : {}),
        ...(safeContent.note !== undefined ? { note: safeContent.note } : {}),
      },
    },
  };
}

/** Plain-text fallback shown by clients that do not render blocks. */
function workpadFallback(content: WorkpadContent): string {
  return `Lorenz workpad - status: ${content.state}`;
}

/**
 * Create the issue's workpad, or edit the existing one in place. `existing` is the workpad the
 * fold observed in the thread (see ThreadState.workpad); passing it avoids a re-read. Returns
 * the workpad's ts. An edit that fails because the message is gone (or no longer editable)
 * degrades to posting a fresh workpad - display mirrors never block.
 */
export async function upsertWorkpad(
  settings: Settings,
  transport: SlackTransport,
  channel: string,
  rootTs: string,
  content: WorkpadContent,
  existing: ThreadWorkpad | undefined,
): Promise<string> {
  const clamped: WorkpadContent = {
    ...content,
    plan: sanitizeWorkpadSection(content.plan),
    note: sanitizeWorkpadSection(content.note),
  };
  const options = renderWorkpadBlocks(clamped, settings);
  const fallback = workpadFallback(clamped);
  if (existing !== undefined) {
    try {
      await transport.updateMessage(channel, existing.ts, fallback, options);
      return existing.ts;
    } catch {
      // message_not_found / edit_window_closed / tombstoned - post a fresh workpad below.
    }
  }
  return transport.postReply(channel, rootTs, fallback, options);
}

function sanitizeWorkpadSection(text: string | undefined): string | undefined {
  const clamped = clampWorkpadSection(text);
  return clamped === undefined ? undefined : stripBroadcastMentions(clamped);
}
