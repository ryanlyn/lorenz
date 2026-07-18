import { errorMessage, isRecord, type Settings } from "@lorenz/domain";

import { splitIssueId } from "./ids.js";
import { requireTrackedMessage, updateSlackStatus } from "./operations.js";
import { stateFromThread, type ThreadState } from "./threadState.js";
import type { SlackTransport } from "./transport.js";
import type { SlackTrackerLogger } from "./webTransport.js";
import { WORKPAD_CANCEL_ACTION, WORKPAD_DETAILS_ACTION } from "./workpad.js";

/**
 * Block-action handling for the workpad buttons, delivered over the same Socket Mode connection
 * as events (no public HTTP endpoint). Two invariants:
 *
 * - The Cancel button is a SHORTCUT for typing `@bot !cancel`, not a new privilege: it goes
 *   through the exact same authoritative path (a bot `status: Cancelled` reply, folded like any
 *   other event, aborted by the runtime's reconciliation) and is permitted for any human,
 *   matching the `!`-command model where the author allowlist gates issue CREATION only. The
 *   attribution line in the reply keeps the transition auditable to a person.
 * - The Details modal is per-user and ephemeral: it renders the issue's session state (folded
 *   status history, current run surface, artifacts) from reads the daemon already serves
 *   cheaply, and it must be built within the trigger_id's ~3-second validity.
 */

/** `action_id` of the modal's refresh button (lives inside the modal, not the workpad). */
const MODAL_REFRESH_ACTION = "lorenz_modal_refresh";

/** Cap for text rendered into one modal section (Slack's per-section limit is 3000). */
const MODAL_TEXT_MAX = 2_800;
/** How many folded transitions the history section shows (newest last, like the thread). */
const MODAL_HISTORY_MAX = 10;
/** How many artifact links the modal lists. */
const MODAL_LINKS_MAX = 5;

export interface SlackInteractionContext {
  settings: Settings;
  transport: SlackTransport;
  logger: SlackTrackerLogger;
  /**
   * Nudges the runtime to poll now. A button-driven cancel posts the status reply itself, but
   * the ABORT of the running agent happens in the runtime's reconciliation - the nudge collapses
   * that from "next interval" to "now", exactly like a Socket Mode message event would.
   */
  nudge?: (() => void) | undefined;
}

/** Route one `interactive` envelope payload. Never throws: failures log and degrade. */
export async function handleSlackInteraction(
  payload: Record<string, unknown>,
  context: SlackInteractionContext,
): Promise<void> {
  try {
    if (payload.type !== "block_actions") return;
    const action = firstAction(payload);
    if (action === null) return;
    switch (action.actionId) {
      case WORKPAD_CANCEL_ACTION:
        await handleCancel(payload, action.value, context);
        return;
      case WORKPAD_DETAILS_ACTION:
        await handleDetails(payload, action.value, context);
        return;
      case MODAL_REFRESH_ACTION:
        await handleModalRefresh(payload, action.value, context);
        return;
      default:
        return;
    }
  } catch (error) {
    context.logger.warn(`slack interaction handling failed: ${errorMessage(error)}`);
  } finally {
    // Whatever the interaction did (posted a status, or nothing), a poll against the mirror is
    // cheap - and for a cancel it is what turns the posted status into an aborted run.
    context.nudge?.();
  }
}

async function handleCancel(
  payload: Record<string, unknown>,
  issueId: string,
  context: SlackInteractionContext,
): Promise<void> {
  const parts = splitIssueId(issueId);
  if (parts === null) return;
  const [channel, ts] = parts;
  const userId = interactingUser(payload);
  const attribution =
    userId !== null
      ? `(requested by <@${userId}> via the workpad Cancel button)`
      : "(requested via the workpad Cancel button)";
  const outcome = await updateSlackStatus(
    context.settings,
    context.transport,
    channel,
    ts,
    "Cancelled",
    { attribution },
  );
  if (!outcome.ok) {
    context.logger.warn(`slack workpad cancel for ${issueId} failed: ${outcome.message}`);
    if (userId !== null) {
      try {
        await context.transport.postEphemeral(
          channel,
          userId,
          ts,
          `Could not cancel this issue: ${outcome.message}`,
        );
      } catch {
        // The log line above already records the failure; the ephemeral is best-effort.
      }
    }
  }
}

async function handleDetails(
  payload: Record<string, unknown>,
  issueId: string,
  context: SlackInteractionContext,
): Promise<void> {
  const triggerId = typeof payload.trigger_id === "string" ? payload.trigger_id : null;
  if (triggerId === null) return;
  // Consume the short-lived trigger before any tracker reads. The opened loading view gives us a
  // stable view id that can be updated after authoritative Slack reads complete.
  const viewId = await context.transport.openView(triggerId, loadingModalView(issueId));
  if (viewId === null) return;
  await context.transport.updateView(viewId, await buildSessionModalView(issueId, context));
}

async function handleModalRefresh(
  payload: Record<string, unknown>,
  issueId: string,
  context: SlackInteractionContext,
): Promise<void> {
  const view = payload.view;
  const viewId = isRecord(view) && typeof view.id === "string" ? view.id : null;
  if (viewId === null) return;
  await context.transport.updateView(viewId, await buildSessionModalView(issueId, context));
}

/**
 * The in-Slack "view session" surface: the folded status history (the audit trail the thread
 * encodes), the request, the live plan/note from the workpad, and artifact links harvested from
 * the bot's own replies. Everything comes from the same reads the tracker already serves - with
 * the mirror active this builds without touching Slack, comfortably inside the trigger window.
 */
async function buildSessionModalView(
  issueId: string,
  context: SlackInteractionContext,
): Promise<Record<string, unknown>> {
  const parts = splitIssueId(issueId);
  if (parts === null) return errorModalView(`unknown issue id: ${issueId}`);
  const [channel, ts] = parts;
  let thread: ThreadState;
  let rootText: string;
  let links: string[];
  try {
    const root = await requireTrackedMessage(context.settings, context.transport, channel, ts);
    const replies = await context.transport.getThread(channel, ts);
    thread = stateFromThread(root, replies, context.settings);
    rootText = thread.request?.text ?? root.text;
    links = harvestLinks(
      replies.filter((r) => r.user !== undefined && isBotReply(r.user, context.settings)),
    );
  } catch (error) {
    return errorModalView(errorMessage(error));
  }

  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: truncate(`*Status:* ${thread.state}\n*Issue:* ${issueId}`) },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: truncate(`*Request*\n${firstLines(rootText, 6)}`) },
    },
  ];
  if (thread.events.length > 0) {
    const history = thread.events
      .slice(-MODAL_HISTORY_MAX)
      .map((event) => {
        const actor =
          event.actor === undefined
            ? "unknown"
            : isBotReply(event.actor, context.settings)
              ? "lorenz"
              : `<@${event.actor}>`;
        return `• ${formatTs(event.ts)} - *${event.state}* (${actor})`;
      })
      .join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(`*Status history*\n${history}`) },
    });
  }
  if (thread.workpad?.plan !== undefined && thread.workpad.plan.trim() !== "") {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(`*Plan*\n${thread.workpad.plan}`) },
    });
  }
  if (thread.workpad?.note !== undefined && thread.workpad.note.trim() !== "") {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: truncate(thread.workpad.note) }],
    });
  }
  if (links.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(`*Artifacts*\n${links.join("\n")}`) },
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Refresh" },
        action_id: MODAL_REFRESH_ACTION,
        value: issueId,
      },
    ],
  });
  return modalView(blocks);
}

function modalView(blocks: unknown[]): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: "lorenz_session",
    title: { type: "plain_text", text: "Lorenz session" },
    close: { type: "plain_text", text: "Close" },
    blocks,
  };
}

function errorModalView(message: string): Record<string, unknown> {
  return modalView([
    { type: "section", text: { type: "mrkdwn", text: truncate(`:warning: ${message}`) } },
  ]);
}

function loadingModalView(issueId: string): Record<string, unknown> {
  return modalView([
    {
      type: "section",
      text: { type: "mrkdwn", text: `Loading session details for *${issueId}*...` },
    },
  ]);
}

/** URLs from the bot's replies (mrkdwn `<url>` / `<url|label>` tokens), newest-biased, deduped. */
function harvestLinks(botReplies: Array<{ text: string }>): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const reply of botReplies) {
    for (const match of reply.text.matchAll(/<(https?:\/\/[^>|]+)(?:\|[^>]*)?>/g)) {
      const url = match[1]!;
      if (seen.has(url)) continue;
      seen.add(url);
      links.push(`<${url}>`);
    }
  }
  return links.slice(-MODAL_LINKS_MAX);
}

function isBotReply(user: string, settings: Settings): boolean {
  const botUserId = settings.tracker.options.botUserId;
  return typeof botUserId === "string" && user === botUserId;
}

function firstAction(payload: Record<string, unknown>): { actionId: string; value: string } | null {
  const actions = payload.actions;
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const action: unknown = actions[0];
  if (!isRecord(action) || typeof action.action_id !== "string") return null;
  return {
    actionId: action.action_id,
    value: typeof action.value === "string" ? action.value : "",
  };
}

function interactingUser(payload: Record<string, unknown>): string | null {
  const user = payload.user;
  return isRecord(user) && typeof user.id === "string" ? user.id : null;
}

function truncate(text: string): string {
  if (text.length <= MODAL_TEXT_MAX) return text;
  return `${text.slice(0, MODAL_TEXT_MAX - 2)} …`;
}

function firstLines(text: string, lines: number): string {
  const parts = text.split("\n");
  if (parts.length <= lines) return text;
  return `${parts.slice(0, lines).join("\n")}\n…`;
}

function formatTs(ts: string): string {
  const ms = Number.parseFloat(ts) * 1000;
  if (!Number.isFinite(ms)) return ts;
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
