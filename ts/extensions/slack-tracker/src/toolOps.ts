import type { Issue, Settings } from "@symphony/domain";
import type { TrackerOpsContext, TrackerToolOps } from "@symphony/tracker-sdk";

import { slackMessageToIssue, SlackTrackerClient, splitIssueId } from "./client.js";
import { requireTrackedMessage, updateSlackStatus } from "./operations.js";
import type { SlackTransport } from "./transport.js";
import { SlackWebTransport } from "./webTransport.js";

/**
 * Normalized issue operations behind the provider-neutral `tracker_*` pack, implemented over
 * the same transport, trust boundary, and transactional status swap as the `slack_*` tools.
 * `createIssue` is intentionally absent: Slack issues are created by humans @-mentioning the
 * bot, never by an agent.
 */
export function slackToolOps(settings: Settings, context: TrackerOpsContext): TrackerToolOps {
  return slackToolOpsWith(settings, new SlackWebTransport(settings, context.fetchImpl));
}

/** Like {@link slackToolOps} with an injected transport (tests use the in-memory one). */
export function slackToolOpsWith(settings: Settings, transport: SlackTransport): TrackerToolOps {
  return {
    readIssue: async (issueId) => {
      const [channel, ts] = requireIssueIdParts(issueId);
      const message = await requireTrackedMessage(settings, transport, channel, ts);
      return slackMessageToIssue(message, settings, await transport.teamUrl());
    },
    queryIssues: async (args) => querySlackIssues(settings, transport, args),
    updateStatus: async (issueId, status) => {
      const [channel, ts] = requireIssueIdParts(issueId);
      const outcome = await updateSlackStatus(settings, transport, channel, ts, status);
      if (!outcome.ok) throw new Error(outcome.message);
      const message = await requireTrackedMessage(settings, transport, channel, ts);
      return slackMessageToIssue(message, settings, await transport.teamUrl());
    },
    addComment: async (issueId, body) => {
      const [channel, ts] = requireIssueIdParts(issueId);
      await requireTrackedMessage(settings, transport, channel, ts);
      await transport.postReply(channel, ts, body);
    },
  };
}

async function querySlackIssues(
  settings: Settings,
  transport: SlackTransport,
  args: Record<string, unknown>,
): Promise<Issue[]> {
  if (typeof args.jql === "string" && args.jql.trim() !== "") {
    // Reject rather than silently ignore: a "filtered" result that ignored the filter would
    // hand the agent terminal/stale issues presented as matches.
    throw new Error("'jql' is not supported by the slack tracker; filter with 'where' instead");
  }
  const client = new SlackTrackerClient(settings, transport);
  const issueIds = stringArray(args.issueIds);
  if (issueIds) return client.fetchIssuesByIds(issueIds);
  const states = stringArray(args.states);
  if (states) return client.fetchIssuesByStates(states);
  // Match the other trackers' default scope: candidates, not the full mention history.
  return client.fetchCandidateIssues();
}

function requireIssueIdParts(issueId: string): [string, string] {
  const parts = splitIssueId(issueId);
  if (!parts) throw new Error("issueId must be in '<channel>:<ts>' form");
  return parts;
}

function stringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("expected an array of strings");
  }
  return value;
}
