import { errorMessage, isRecord, type Settings } from "@lorenz/domain";
import {
  applyQuery,
  parseQuerySpec,
  parseSelect,
  pickFields,
  toolFailure,
  toolSuccess,
  unsupportedToolFailure,
  type ToolAuthorization,
  type ToolProvider,
  type ToolResult,
  type ToolSpec,
} from "@lorenz/tool-sdk";

import { slackMessageToRow, slackPermalink, splitIssueId, trackedRootsOf } from "./client.js";
import { isAllowedAuthor, isBotMention } from "./mapping.js";
import { requireBotUserId, requireTrackedMessage, updateSlackStatus } from "./operations.js";
import { slackTrackerOptions } from "./options.js";
import { resolveThreadState, stateFromObservedThread } from "./threadState.js";
import { slackRuntimeKey, slackRuntimeTransport } from "./toolTransport.js";
import {
  isBotMarked,
  type SlackFileUploadCompletion,
  type SlackFileUploadRequest,
  type SlackTransport,
} from "./transport.js";
import { SlackWebTransport } from "./webTransport.js";
import { upsertWorkpad } from "./workpad.js";

const TOOL_NAMES = [
  "slack_update_status",
  "slack_prepare_file_upload",
  "slack_comment",
  "slack_workpad",
  "slack_read_thread",
  "slack_query",
  "slack_user_info",
  "slack_channel_context",
] as const;

/** Default projection for `slack_query` when `select` is omitted. */
const DEFAULT_SLACK_SELECT = ["issueId", "title", "state", "labels"];
/** The only fields `expand` may request beyond the base row. */
const SLACK_EXPAND_FIELDS = new Set(["thread", "reactions"]);
/** Bounds for the `slack_channel_context` window. */
const CONTEXT_DEFAULT = 10;
const CONTEXT_MAX = 50;
const OUTBOUND_UPLOAD_MAX_FILES = 10;
const OUTBOUND_UPLOAD_MAX_FILE_BYTES = 25 * 1024 * 1024;
const OUTBOUND_UPLOAD_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const OUTBOUND_UPLOAD_TICKET_TTL_MS = 15 * 60_000;
const OUTBOUND_UPLOAD_MAX_PENDING = 256;
/** Per-runtime queues protecting each workpad's read-modify-write operation. */
const workpadQueues = new Map<string, Map<string, Promise<void>>>();
/** Short-lived reservations and Slack file ids, bounded globally and scoped to one run. */
const pendingUploads = new Set<PendingSlackFileUpload>();

interface PendingSlackFileUpload {
  ownerKey: string;
  runtimeKey: string;
  runKey?: string | undefined;
  issueId: string;
  length: number;
  expiresAt: number;
  fileId?: string | undefined;
  uploadUrl?: string | undefined;
}

export function slackToolSpecs(): ToolSpec[] {
  return [
    {
      name: "slack_update_status",
      description:
        "Set a Slack issue's status by posting the bot's authoritative `status:` thread reply " +
        "(reactions are only a visibility mirror). Args: issueId, status (a configured " +
        "active/terminal state name).",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" }, status: { type: "string" } },
        required: ["issueId", "status"],
      },
    },
    {
      name: "slack_prepare_file_upload",
      description:
        "Prepare a local file for a Slack issue reply. Returns a signed uploadUrl and fileId. " +
        "POST exactly length bytes to that URL without an Authorization header or redirects, " +
        "using a bounded request (for curl: --connect-timeout 10 --max-time 300), then pass " +
        "fileId in slack_comment.fileIds. Never include uploadUrl in Slack text. If completion " +
        "has an unknown outcome, read the thread before preparing another upload. Args: " +
        "issueId, filename, length.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          issueId: { type: "string" },
          filename: { type: "string" },
          length: { type: "number" },
        },
        required: ["issueId", "filename", "length"],
      },
    },
    {
      name: "slack_comment",
      description:
        "Reply in the Slack issue's thread. Use for milestone updates and findings that " +
        "SHOULD notify the thread (replies notify; workpad edits do not). To attach prepared " +
        "files, pass their single-use ids in fileIds. Args: issueId, body, fileIds?.",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          body: { type: "string" },
          fileIds: {
            type: "array",
            maxItems: OUTBOUND_UPLOAD_MAX_FILES,
            items: { type: "string" },
          },
        },
        required: ["issueId", "body"],
      },
    },
    {
      name: "slack_workpad",
      description:
        "Create or update the issue's workpad: one bot message in the thread, edited in place, " +
        "carrying the live plan checklist and latest note. Socket Mode adds Cancel/Details " +
        "buttons. Use it " +
        "for the continuously-changing checklist instead of posting new comments - edits do not " +
        "notify the thread. Omitting plan/note keeps the existing section. Args: issueId, " +
        "plan? (mrkdwn checklist), note? (short status line).",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          plan: { type: "string" },
          note: { type: "string" },
        },
        required: ["issueId"],
      },
    },
    {
      name: "slack_read_thread",
      description:
        "Read a Slack issue's authoritative state: its source message, thread-derived status " +
        "(human `@bot !` commands and bot `status:` replies, latest wins), status audit trail, " +
        "workpad, reactions, permalink, and thread replies. Args: issueId.",
      inputSchema: {
        type: "object",
        properties: { issueId: { type: "string" } },
        required: ["issueId"],
      },
    },
    {
      name: "slack_query",
      description:
        "Query tracked Slack issues (read-only): bot-mention roots plus bot-marked " +
        "reply-tracked threads in the configured channels, with thread-derived state. Filter " +
        "with a JSON predicate DSL, project fields, order, and page. Row fields: issueId, " +
        "channel, ts, title, state, stateType, labels, text, files, url. Use expand for 'thread' " +
        "(replies) and 'reactions'. Args: channels? (intersected with the allow-list), where?, " +
        "select?, expand?, order_by?, limit?, offset?.",
      inputSchema: {
        type: "object",
        properties: {
          channels: { type: "array", items: { type: "string" } },
          where: { type: "object" },
          select: { type: "array", items: { type: "string" } },
          expand: { type: "array", items: { type: "string", enum: ["thread", "reactions"] } },
          order_by: { type: "array", items: { type: "object" } },
          limit: { type: "number" },
          offset: { type: "number" },
        },
      },
    },
    {
      name: "slack_user_info",
      description:
        "Resolve a Slack user id (e.g. from a <@U...> mention or a thread reply's user field) " +
        "to its profile: name, real name, display name, bot flag. Args: userId.",
      inputSchema: {
        type: "object",
        properties: { userId: { type: "string" } },
        required: ["userId"],
      },
    },
    {
      name: "slack_channel_context",
      description:
        "Read the channel conversation around a tracked issue's source message (read-only): " +
        "up to `before` messages at-or-before it and `after` messages after it, ascending. " +
        "Args: issueId, before? (default 10, max 50), after? (default 10, max 50).",
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          before: { type: "number" },
          after: { type: "number" },
        },
        required: ["issueId"],
      },
    },
  ];
}

export async function executeSlackTool(
  name: string,
  input: unknown,
  settings: Settings,
  transport: SlackTransport,
  authorization?: ToolAuthorization,
): Promise<ToolResult> {
  const args = isRecord(input) ? input : {};
  try {
    // slack_query scans the configured channels rather than acting on a single issueId, so it
    // is handled before the per-issue id split below. slack_user_info takes a user id.
    if (name === "slack_query") {
      return await executeSlackQuery(args, settings, transport);
    }
    if (name === "slack_user_info") {
      requireBotUserId(settings);
      const userId = requireStr(args, "userId");
      const user = await transport.getUser(userId);
      if (!user) return toolFailure(`unknown slack user: ${userId}`);
      return toolSuccess({ user });
    }
    if (!(TOOL_NAMES as readonly string[]).includes(name)) {
      return unsupportedToolFailure(name, TOOL_NAMES);
    }
    // Every remaining tool acts on one issue, so the id is parsed once here.
    const requestedIssueId = requireStr(args, "issueId").trim();
    if (authorization !== undefined && requestedIssueId !== authorization.issueId) {
      throw new Error(`this run is authorized only for Slack issue ${authorization.issueId}`);
    }
    const parts = splitIssueId(requestedIssueId);
    if (!parts) throw new Error("issueId must be in '<channel>:<ts>' form");
    const [channel, ts] = parts;
    switch (name) {
      case "slack_update_status": {
        const status = requireStr(args, "status");
        const outcome = await updateSlackStatus(settings, transport, channel, ts, status);
        if (outcome.ok) return toolSuccess({ ok: true, status: outcome.status });
        return toolFailure(outcome.message);
      }
      case "slack_prepare_file_upload": {
        // Allocate upload URLs only for watched, tracked threads; otherwise this could become a
        // generic file-hosting capability over the configured Slack workspace.
        await requireTrackedMessage(settings, transport, channel, ts);
        const issueId = `${channel}:${ts}`;
        const request = outboundUploadRequest(args);
        const scope = outboundUploadScope(settings, authorization);
        const reservation = reservePendingUpload(scope, issueId, request);
        const uploadRequest: SlackFileUploadRequest = {
          filename: request.filename,
          length: request.length,
        };
        try {
          const prepared = await transport.prepareFileUpload(uploadRequest);
          activatePendingUpload(reservation, prepared.fileId, prepared.uploadUrl);
          return toolSuccess({
            ok: true,
            fileId: reservation.fileId,
            uploadUrl: prepared.uploadUrl,
            expiresAt: new Date(reservation.expiresAt).toISOString(),
            upload: {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              followRedirects: false,
              timeoutSeconds: 300,
            },
          });
        } catch (error) {
          pendingUploads.delete(reservation);
          throw error;
        }
      }
      case "slack_comment": {
        // Same trust-boundary check as update_status: only reply on a watched, tracked issue.
        await requireTrackedMessage(settings, transport, channel, ts);
        const body = requireStr(args, "body");
        assertNoSlackUploadUrl(body);
        const fileIds = outboundUploadFileIds(args.fileIds);
        if (fileIds.length === 0) {
          await transport.postReply(channel, ts, body);
          return toolSuccess({ ok: true });
        }
        // Consume before the single-use completion request. A network/5xx outcome may have
        // completed in Slack, so restoring the ids would authorize an unsafe second attempt.
        const files = consumePendingUploads(
          outboundUploadScope(settings, authorization),
          `${channel}:${ts}`,
          fileIds,
        );
        try {
          const completed = await transport.completeFileUploads(channel, ts, body, files);
          return toolSuccess({ ok: true, files: completed });
        } catch (error) {
          throw new Error(
            `${errorMessage(error)}; upload file ids were consumed - read the thread to reconcile ` +
              `the outcome before preparing replacement uploads`,
            { cause: error },
          );
        }
      }
      case "slack_workpad": {
        const issueId = `${channel}:${ts}`;
        const requestedPlan = optionalStr(args, "plan");
        const requestedNote = optionalStr(args, "note");
        assertNoSlackUploadUrl(requestedPlan, requestedNote);
        return await serializeWorkpadUpdate(settings, issueId, async () => {
          const root = await requireTrackedMessage(settings, transport, channel, ts);
          const replies = await transport.getThread(channel, ts);
          const thread = stateFromObservedThread(root, replies, settings, transport);
          // A partial update keeps the other section: the workpad metadata round-trips both, so
          // an agent refreshing its note between milestones does not blank the plan.
          const plan = requestedPlan ?? thread.workpad?.plan;
          const note = requestedNote ?? thread.workpad?.note;
          const workpadTs = await upsertWorkpad(
            settings,
            transport,
            channel,
            ts,
            {
              issueId,
              ...(plan !== undefined ? { plan } : {}),
              ...(note !== undefined ? { note } : {}),
            },
            thread.workpad,
          );
          return toolSuccess({ ok: true, workpadTs });
        });
      }
      case "slack_read_thread": {
        // Same trust-boundary check as the write tools: only read a watched, tracked issue.
        const root = await requireTrackedMessage(settings, transport, channel, ts);
        const replies = await transport.getThread(channel, ts);
        const thread = stateFromObservedThread(root, replies, settings, transport);
        const base = await transport.teamUrl();
        return toolSuccess({
          issueId: `${channel}:${ts}`,
          status: thread.state,
          // The folded transition history (who moved the issue where, and when): the audit
          // trail an agent needs to distinguish "human cancelled" from "I finished".
          statusEvents: thread.events,
          text: root.text,
          ...(root.files && root.files.length > 0 ? { files: root.files } : {}),
          ...(thread.request !== undefined ? { request: thread.request } : {}),
          ...(thread.workpad !== undefined ? { workpad: thread.workpad } : {}),
          reactions: root.reactions,
          ...(base ? { permalink: slackPermalink(base, channel, ts) } : {}),
          replies,
        });
      }
      case "slack_channel_context": {
        // Context reads are scoped: anchored to a TRACKED issue in a watched channel, never a
        // free-roaming channel read.
        await requireTrackedMessage(settings, transport, channel, ts);
        const before = windowArg(args.before, "before");
        const after = windowArg(args.after, "after");
        const messages = await transport.listAround(channel, ts, { before, after });
        return toolSuccess({
          anchor: `${channel}:${ts}`,
          messages: messages.map((m) => ({
            ts: m.ts,
            ...(m.user !== undefined ? { user: m.user } : {}),
            text: m.text,
            ...(m.files && m.files.length > 0 ? { files: m.files } : {}),
          })),
        });
      }
      default:
        return unsupportedToolFailure(name, TOOL_NAMES);
    }
  } catch (error) {
    return toolFailure(errorMessage(error));
  }
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function outboundUploadRequest(args: Record<string, unknown>): SlackFileUploadRequest {
  const filename = requireStr(args, "filename").trim();
  if (
    filename.length > 255 ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    containsAsciiControl(filename)
  ) {
    throw new Error("'filename' must be a safe basename of at most 255 characters");
  }
  const length = args.length;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    length > OUTBOUND_UPLOAD_MAX_FILE_BYTES
  ) {
    throw new Error(
      `'length' must be a positive integer no greater than ${OUTBOUND_UPLOAD_MAX_FILE_BYTES}`,
    );
  }
  return { filename, length };
}

function outboundUploadFileIds(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("'fileIds' must be an array of strings");
  if (input.length > OUTBOUND_UPLOAD_MAX_FILES) {
    throw new Error(`'fileIds' may contain at most ${OUTBOUND_UPLOAD_MAX_FILES} items`);
  }
  const fileIds: string[] = [];
  for (const item of input) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error("'fileIds' must be an array of non-empty strings");
    }
    const fileId = item.trim();
    if (fileIds.includes(fileId)) throw new Error(`duplicate Slack upload file id: ${fileId}`);
    fileIds.push(fileId);
  }
  return fileIds;
}

interface OutboundUploadScope {
  ownerKey: string;
  runtimeKey: string;
  runKey?: string | undefined;
}

function outboundUploadScope(
  settings: Settings,
  authorization: ToolAuthorization | undefined,
): OutboundUploadScope {
  const runtimeKey = slackRuntimeKey(settings);
  return {
    ownerKey: authorization?.claimId ?? runtimeKey,
    runtimeKey,
    ...(authorization ? { runKey: authorization.runKey } : {}),
  };
}

function reservePendingUpload(
  scope: OutboundUploadScope,
  issueId: string,
  request: SlackFileUploadRequest,
): PendingSlackFileUpload {
  prunePendingUploads();
  if (scope.runKey !== undefined) {
    for (const upload of pendingUploads) {
      if (
        upload.runtimeKey === scope.runtimeKey &&
        upload.runKey === scope.runKey &&
        upload.ownerKey !== scope.ownerKey
      ) {
        pendingUploads.delete(upload);
      }
    }
  }
  if (pendingUploads.size >= OUTBOUND_UPLOAD_MAX_PENDING) {
    throw new Error(`Slack upload ticket capacity reached (${OUTBOUND_UPLOAD_MAX_PENDING})`);
  }
  const issueUploads = [...pendingUploads].filter(
    (upload) => upload.runtimeKey === scope.runtimeKey && upload.issueId === issueId,
  );
  if (issueUploads.length >= OUTBOUND_UPLOAD_MAX_FILES) {
    throw new Error(`Slack issue may have at most ${OUTBOUND_UPLOAD_MAX_FILES} pending uploads`);
  }
  const pendingBytes = issueUploads.reduce((total, upload) => total + upload.length, 0);
  if (pendingBytes + request.length > OUTBOUND_UPLOAD_MAX_TOTAL_BYTES) {
    throw new Error(
      `Slack issue pending uploads exceed ${OUTBOUND_UPLOAD_MAX_TOTAL_BYTES} total bytes`,
    );
  }
  const reservation: PendingSlackFileUpload = {
    ownerKey: scope.ownerKey,
    runtimeKey: scope.runtimeKey,
    ...(scope.runKey !== undefined ? { runKey: scope.runKey } : {}),
    issueId,
    length: request.length,
    expiresAt: Date.now() + OUTBOUND_UPLOAD_TICKET_TTL_MS,
  };
  // This synchronous insertion is the capacity reservation. No await may occur between the
  // checks above and this write, so concurrent prepare calls cannot over-allocate Slack tickets.
  pendingUploads.add(reservation);
  return reservation;
}

function activatePendingUpload(
  reservation: PendingSlackFileUpload,
  rawFileId: string,
  uploadUrl: string,
): void {
  const fileId = rawFileId.trim();
  if (fileId === "" || containsAsciiControl(fileId)) {
    throw new Error("Slack returned an invalid upload file id");
  }
  prunePendingUploads();
  if (!pendingUploads.has(reservation)) {
    throw new Error("Slack upload reservation expired while preparing the upload");
  }
  if ([...pendingUploads].some((upload) => upload !== reservation && upload.fileId === fileId)) {
    throw new Error(`Slack returned a duplicate upload file id: ${fileId}`);
  }
  reservation.fileId = fileId;
  reservation.uploadUrl = uploadUrl;
  reservation.expiresAt = Date.now() + OUTBOUND_UPLOAD_TICKET_TTL_MS;
}

function consumePendingUploads(
  scope: OutboundUploadScope,
  issueId: string,
  fileIds: readonly string[],
): SlackFileUploadCompletion[] {
  prunePendingUploads();
  const uploads = fileIds.map((fileId) => {
    const upload = [...pendingUploads].find((candidate) => candidate.fileId === fileId);
    if (
      upload === undefined ||
      upload.ownerKey !== scope.ownerKey ||
      upload.runtimeKey !== scope.runtimeKey
    ) {
      throw new Error(`Slack upload file id is unknown or expired: ${fileId}`);
    }
    if (upload.issueId !== issueId) {
      throw new Error(`Slack upload file id ${fileId} belongs to a different issue`);
    }
    return upload;
  });
  // Delete only after every id has been validated, then do so synchronously before the caller's
  // first await. Concurrent completions therefore cannot both acquire the same single-use ids.
  for (const upload of uploads) pendingUploads.delete(upload);
  return uploads.map((upload) => ({ fileId: upload.fileId! }));
}

function prunePendingUploads(): void {
  const now = Date.now();
  for (const upload of pendingUploads) {
    if (upload.expiresAt <= now) pendingUploads.delete(upload);
  }
}

function assertNoSlackUploadUrl(...values: Array<string | undefined>): void {
  prunePendingUploads();
  for (const value of values) {
    if (value === undefined) continue;
    const containsIssuedUrl = [...pendingUploads].some(
      (upload) => upload.uploadUrl !== undefined && value.includes(upload.uploadUrl),
    );
    const containsSlackUploadUrl =
      /https:\/\/(?:[a-z0-9-]+\.)*(?:slack\.com|slack-files\.com|slack-gov\.com)\/upload\/v1\//iu.test(
        value,
      );
    if (containsIssuedUrl || containsSlackUploadUrl) {
      throw new Error("Slack upload URLs cannot be included in Slack messages");
    }
  }
}

async function serializeWorkpadUpdate<T>(
  settings: Settings,
  issueId: string,
  update: () => Promise<T>,
): Promise<T> {
  const runtimeKey = slackRuntimeKey(settings);
  let queues = workpadQueues.get(runtimeKey);
  if (queues === undefined) {
    queues = new Map();
    workpadQueues.set(runtimeKey, queues);
  }
  const previous = queues.get(issueId) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(async () => turn);
  queues.set(issueId, tail);
  await previous;
  try {
    return await update();
  } finally {
    release();
    if (queues.get(issueId) === tail) {
      queues.delete(issueId);
      if (queues.size === 0) workpadQueues.delete(runtimeKey);
    }
  }
}

/** The Slack tool pack: status, threaded comments, reads, and scoped channel context. */
export const slackToolProvider: ToolProvider = {
  name: "slack",
  toolSpecs: () => slackToolSpecs(),
  executeTool: async (name, input, context) =>
    executeSlackTool(
      name,
      input,
      context.settings,
      slackRuntimeTransport(context.settings) ??
        new SlackWebTransport(context.settings, context.fetchImpl),
      context.authorization,
    ),
};

/**
 * Read-only query over tracked Slack issues. The trust boundary is enforced structurally:
 * rows come only from validated bot-mention roots and marker-bearing threads whose accepted
 * request reply still exists. The scanned channels are always intersected with the configured
 * allow-list, so the query cannot become an oracle for arbitrary messages. Filtering,
 * projection, and paging then run in memory over those rows.
 */
async function executeSlackQuery(
  args: Record<string, unknown>,
  settings: Settings,
  transport: SlackTransport,
): Promise<ToolResult> {
  // Fail loudly on a missing bot user id: the scan would return nothing (fail closed), and a
  // silent empty result would read as "no issues" rather than "misconfigured tracker".
  requireBotUserId(settings);
  const spec = parseQuerySpec(args);
  const select = parseSelect(args.select) ?? DEFAULT_SLACK_SELECT;
  const expand = parseSlackExpand(args.expand);
  const options = slackTrackerOptions(settings);
  const allow = options.channels;
  const markerEmoji = options.markerEmoji ?? "robot_face";
  const requested = parseStringArray(args.channels, "channels");
  const channels = requested ? requested.filter((c) => allow.includes(c)) : allow;
  const [scan, base] = await Promise.all([transport.scanChannels(channels), transport.teamUrl()]);
  const records: Array<Record<string, unknown>> = [];
  for (const root of trackedRootsOf(scan, markerEmoji)) {
    const thread = await resolveThreadState(settings, transport, root);
    const rootMentionIsTracked =
      isBotMention(root.text, options.botUserId) &&
      (isAllowedAuthor(root.user, options.users) || isBotMarked(root, markerEmoji));
    if (!rootMentionIsTracked && thread.request === undefined) continue;
    records.push(
      slackMessageToRow(root, settings, {
        permalinkBase: base,
        state: thread.state,
        request: thread.request,
        files: thread.attachments,
      }) as unknown as Record<string, unknown>,
    );
  }
  const { rows, total } = applyQuery(records, spec);
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const projected = pickFields(row, select);
    if (expand.includes("reactions")) projected.reactions = row.reactions;
    if (expand.includes("thread")) {
      projected.thread = await transport.getThread(String(row.channel), String(row.ts));
    }
    out.push(projected);
  }
  return toolSuccess({ rows: out, total });
}

/** Validate `expand`: an array drawn from {@link SLACK_EXPAND_FIELDS}, deduped; default empty. */
function parseSlackExpand(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("expand must be an array of 'thread' | 'reactions'");
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string" || !SLACK_EXPAND_FIELDS.has(item)) {
      throw new Error("expand items must be 'thread' or 'reactions'");
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function parseStringArray(input: unknown, label: string): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input) || !input.every((s) => typeof s === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return input;
}

function windowArg(value: unknown, label: string): number {
  if (value === undefined || value === null) return CONTEXT_DEFAULT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`'${label}' must be a non-negative integer`);
  }
  return Math.min(value, CONTEXT_MAX);
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`'${key}' is required`);
  return value;
}

function optionalStr(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`'${key}' must be a string`);
  return value;
}
