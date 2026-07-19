import type { Settings } from "@lorenz/domain";

import { slackTrackerOptions } from "./options.js";
import { stripBroadcastMentions } from "./sanitize.js";
import type { ThreadWorkpad } from "./threadState.js";
import { WORKPAD_METADATA_EVENT } from "./transport.js";
import type { SlackPostOptions, SlackTransport } from "./transport.js";
import { makeMetadataSeq, SlackApiError } from "./webTransport.js";

/**
 * The workpad: one bot message per issue thread, edited in place, that carries the live plan
 * checklist, latest note, and Socket Mode actions. Milestone comments still post as replies
 * because replies notify while edits do not.
 *
 * Like the reaction mirror, the workpad is a DISPLAY surface, never state: the fold recognizes
 * it by its `lorenz_workpad` metadata purely to skip it as a status event and to round-trip the
 * plan/note sections. Losing or failing to edit a workpad never blocks a transition - the
 * fallback is always "post a fresh one and repoint".
 */

/** `action_id`s the interaction handler routes on (see interactions.ts). */
export const WORKPAD_CANCEL_ACTION = "lorenz_cancel";
export const WORKPAD_DETAILS_ACTION = "lorenz_details";

/** Per-block bound; the shared content budget below also keeps fallback and metadata bounded. */
const SECTION_MAX_CHARS = 2_000;
/** Shared plan/note budget, leaving room for metadata keys and the plain-text fallback header. */
const CONTENT_MAX_CHARS = 2_800;
const CLIPPED_SUFFIX = "\n… (clipped)";

export interface WorkpadContent {
  issueId: string;
  plan?: string | undefined;
  note?: string | undefined;
}

/** Clamp a section to the metadata budget, marking the cut so nothing truncates silently. */
function clampWorkpadSection(
  text: string | undefined,
  maxChars = SECTION_MAX_CHARS,
): string | undefined {
  if (text === undefined) return undefined;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - CLIPPED_SUFFIX.length))}${CLIPPED_SUFFIX}`;
}

/** Sanitize and fit both sections into one payload budget, preserving plan space first. */
function normalizeWorkpadContent(content: WorkpadContent): WorkpadContent {
  const rawPlan = content.plan === undefined ? undefined : stripBroadcastMentions(content.plan);
  const rawNote = content.note === undefined ? undefined : stripBroadcastMentions(content.note);
  const plan = clampWorkpadSection(rawPlan);
  const note = clampWorkpadSection(
    rawNote,
    Math.min(SECTION_MAX_CHARS, CONTENT_MAX_CHARS - (plan?.length ?? 0)),
  );
  return {
    ...content,
    ...(plan !== undefined ? { plan } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

/** The workpad's Block Kit body plus its plain-text fallback. */
export function renderWorkpadBlocks(content: WorkpadContent, settings: Settings): SlackPostOptions {
  const safeContent = normalizeWorkpadContent(content);
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: "*Lorenz workpad*" } },
  ];
  if (safeContent.plan !== undefined && safeContent.plan.trim() !== "") {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: safeContent.plan } });
  }
  if (safeContent.note !== undefined && safeContent.note.trim() !== "") {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: safeContent.note }],
    });
  }
  const { appToken } = slackTrackerOptions(settings);
  if (appToken !== undefined && appToken.trim() !== "") {
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
  }
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
  return [
    "Lorenz workpad",
    ...(content.plan !== undefined && content.plan.trim() !== "" ? [content.plan] : []),
    ...(content.note !== undefined && content.note.trim() !== "" ? [content.note] : []),
  ].join("\n\n");
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
  const clamped = normalizeWorkpadContent(content);
  const options = renderWorkpadBlocks(clamped, settings);
  const fallback = workpadFallback(clamped);
  if (existing !== undefined) {
    try {
      await transport.updateMessage(channel, existing.ts, fallback, options);
      return existing.ts;
    } catch (error) {
      if (
        !(error instanceof SlackApiError) ||
        (error.code !== "message_not_found" && error.code !== "cant_update_message")
      ) {
        throw error;
      }
      // Slack definitively rejected the stored message identity, so posting cannot duplicate an
      // update that may already have landed.
    }
  }
  return transport.postReply(channel, rootTs, fallback, options);
}
