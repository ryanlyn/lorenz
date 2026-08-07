import { test, vi } from "vitest";
import { assert } from "@lorenz/test-utils";

import { parseSlackConfig } from "./helpers.js";

import {
  executeSlackTool,
  InMemorySlackTransport,
  slackToolSpecs,
  TRACKING_METADATA_EVENT,
  WORKPAD_METADATA_EVENT,
} from "@lorenz/slack-tracker";

function settings() {
  return parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"], bot_user_id: "U1" } },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
}

test("slack toolSpecs lists the status, comment, read, query, and context tools", () => {
  assert.deepEqual(
    slackToolSpecs().map((t) => t.name),
    [
      "slack_update_status",
      "slack_prepare_file_upload",
      "slack_comment",
      "slack_workpad",
      "slack_read_thread",
      "slack_query",
      "slack_user_info",
      "slack_channel_context",
    ],
  );
});

test("slack upload tools expose the bounded signed-upload contract", () => {
  const prepare = slackToolSpecs().find((tool) => tool.name === "slack_prepare_file_upload")!;
  const comment = slackToolSpecs().find((tool) => tool.name === "slack_comment")!;

  assert.deepEqual(prepare.inputSchema.required, ["issueId", "filename", "length"]);
  assert.equal(prepare.inputSchema.additionalProperties, false);
  const commentProperties = comment.inputSchema.properties as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(commentProperties.fileIds!.maxItems, 10);
});

test("slack_query lists bot-mention issues with derived state and labels", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      { ts: "1.1", text: "<@U1> fix the build #backend", reactions: ["eyes"] },
      { ts: "1.2", text: "<@U1> ship docs", reactions: ["white_check_mark"] },
      { ts: "1.3", text: "just chatter, no mention", reactions: [] },
    ],
  });

  const res = await executeSlackTool("slack_query", {}, settings(), transport);
  assert.equal(res.success, true);
  const result = res.result as {
    rows: Array<{ issueId: string; title: string; state: string; labels: string[] }>;
    total: number;
  };
  // The non-mention message is excluded by listMentions.
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.rows.map((r) => r.issueId),
    ["C1:1.1", "C1:1.2"],
  );
  assert.deepEqual(
    result.rows.map((r) => r.state),
    ["In Progress", "Done"],
  );
  assert.deepEqual(result.rows[0]!.labels, ["backend"]);
  // Default projection only: no text, reactions, or thread unless requested.
  assert.deepEqual(Object.keys(result.rows[0]!).sort(), ["issueId", "labels", "state", "title"]);
});

test("slack_query filters by state, then expands thread and reactions", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      {
        ts: "1.1",
        text: "<@U1> alpha",
        reactions: ["eyes"],
        replies: [{ ts: "1.1a", text: "working", user: "U2" }],
      },
      { ts: "1.2", text: "<@U1> beta", reactions: ["white_check_mark"] },
    ],
  });

  const res = await executeSlackTool(
    "slack_query",
    {
      where: { field: "state", op: "eq", value: "In Progress" },
      select: ["issueId", "text"],
      expand: ["thread", "reactions"],
    },
    settings(),
    transport,
  );
  assert.equal(res.success, true);
  const result = res.result as {
    rows: Array<{
      issueId: string;
      text: string;
      reactions: string[];
      thread: Array<{ text: string }>;
    }>;
    total: number;
  };
  assert.equal(result.total, 1);
  const row = result.rows[0]!;
  assert.equal(row.issueId, "C1:1.1");
  assert.equal(row.text, "<@U1> alpha");
  assert.deepEqual(row.reactions, ["eyes"]);
  assert.deepEqual(
    row.thread.map((t) => t.text),
    ["working"],
  );
});

test("slack_query files include attachments from eligible steering replies", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      {
        ts: "1.15",
        text: "<@U1> inspect",
        replies: [
          {
            ts: "1.16",
            text: "supporting evidence",
            user: "U2",
            files: [{ id: "F_REPLY", name: "evidence.txt", mimetype: "text/plain", size: 8 }],
          },
        ],
      },
    ],
  });

  const res = await executeSlackTool(
    "slack_query",
    { select: ["issueId", "files"] },
    settings(),
    transport,
  );
  assert.equal(res.success, true);
  const result = res.result as {
    rows: Array<{ issueId: string; files: Array<Record<string, unknown>> }>;
  };
  assert.deepEqual(result.rows, [
    {
      issueId: "C1:1.15",
      files: [{ id: "F_REPLY", name: "evidence.txt", mimetype: "text/plain", size: 8 }],
    },
  ]);
});

test("slack_query only scans allow-listed channels (a requested channel is intersected)", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> allowed", reactions: [] }],
    C9: [{ ts: "9.1", text: "<@U1> off-limits", reactions: [] }],
  });

  // Requesting C9 (not in tracker.channels=["C1"]) yields nothing - it is dropped, never fetched.
  const offLimits = await executeSlackTool(
    "slack_query",
    { channels: ["C9"] },
    settings(),
    transport,
  );
  assert.equal((offLimits.result as { total: number }).total, 0);

  // The default (no channels arg) scans the allow-list only, never C9.
  const def = await executeSlackTool("slack_query", { select: ["issueId"] }, settings(), transport);
  assert.deepEqual(
    (def.result as { rows: Array<{ issueId: string }> }).rows.map((r) => r.issueId),
    ["C1:1.1"],
  );
});

test("slack_query rejects a malformed expand value", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> x", reactions: [] }],
  });

  const res = await executeSlackTool("slack_query", { expand: ["bogus"] }, settings(), transport);
  assert.equal(res.success, false);
  assert.match(res.error ?? "", /expand items/);
});

test("slack_read_thread returns text, derived status, reactions, and the thread replies", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      {
        ts: "1.1",
        text: "<@U1> do the thing",
        reactions: ["eyes"],
        replies: [
          { ts: "1.2", text: "on it", user: "U2" },
          {
            ts: "1.3",
            text: "Lorenz workpad",
            user: "U1",
            metadata: {
              eventType: WORKPAD_METADATA_EVENT,
              payload: { issue: "C1:1.1", seq: "workpad", plan: "- [ ] test", note: "running" },
            },
          },
        ],
      },
    ],
  });

  const result = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:1.1" },
    settings(),
    transport,
  );

  assert.equal(result.success, true);
  assert.deepEqual(result.result, {
    issueId: "C1:1.1",
    status: "In Progress",
    // Reaction-derived state: no `status:`/command events in the thread, so the audit trail is
    // empty and the state falls back to the bot's own reaction reading.
    statusEvents: [],
    text: "<@U1> do the thing",
    workpad: { ts: "1.3", plan: "- [ ] test", note: "running" },
    reactions: ["eyes"],
    permalink: "https://example.slack.com/archives/C1/p11",
    replies: [
      { ts: "1.2", text: "on it", user: "U2" },
      {
        ts: "1.3",
        text: "Lorenz workpad",
        user: "U1",
        metadata: {
          eventType: WORKPAD_METADATA_EVENT,
          payload: { issue: "C1:1.1", seq: "workpad", plan: "- [ ] test", note: "running" },
        },
      },
    ],
  });
});

test("slack_read_thread reads back a reply posted via slack_comment", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["white_check_mark"] }],
  });

  const replied = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "all done" },
    settings(),
    transport,
  );
  assert.equal(replied.success, true);

  const read = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:1.1" },
    settings(),
    transport,
  );
  assert.equal(read.success, true);
  const result = read.result as {
    status: string;
    reactions: string[];
    replies: Array<{ text: string }>;
  };
  assert.equal(result.status, "Done");
  assert.deepEqual(result.reactions, ["white_check_mark"]);
  assert.deepEqual(
    result.replies.map((r) => r.text),
    ["all done"],
  );
});

test("worker-prepared files complete as one Slack thread reply and read back safely", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.1", text: "<@U1> generate the reports", reactions: ["eyes"] }] },
    { botUserId: "U1" },
  );

  const first = await executeSlackTool(
    "slack_prepare_file_upload",
    {
      issueId: "C1:1.1",
      filename: "report.pdf",
      length: 123,
    },
    settings(),
    transport,
  );
  const second = await executeSlackTool(
    "slack_prepare_file_upload",
    { issueId: "C1:1.1", filename: "trace.log", length: 45 },
    settings(),
    transport,
  );
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  const firstUpload = first.result as { fileId: string; uploadUrl: string };
  const secondUpload = second.result as { fileId: string; uploadUrl: string };
  assert.match(firstUpload.uploadUrl, /^https:\/\/files\.slack\.com\/upload\/v1\//);
  assert.deepEqual(transport.preparedUploads[0]!.request, {
    filename: "report.pdf",
    length: 123,
  });

  const commented = await executeSlackTool(
    "slack_comment",
    {
      issueId: "C1:1.1",
      body: "Generated files for <!channel>",
      fileIds: [firstUpload.fileId, secondUpload.fileId],
    },
    settings(),
    transport,
  );
  assert.equal(commented.success, true);
  assert.deepEqual(transport.completedUploads[0], {
    channel: "C1",
    threadTs: "1.1",
    body: "Generated files for @channel",
    files: [{ fileId: firstUpload.fileId }, { fileId: secondUpload.fileId }],
  });

  const read = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:1.1" },
    settings(),
    transport,
  );
  const replies = (read.result as { replies: Array<{ text: string; files?: unknown[] }> }).replies;
  assert.equal(replies.at(-1)!.text, "Generated files for @channel");
  assert.deepEqual(replies.at(-1)!.files, [
    { id: firstUpload.fileId, name: "report.pdf", size: 123 },
    { id: secondUpload.fileId, name: "trace.log", size: 45 },
  ]);
});

test("prepared Slack file ids are issue-bound and remain usable after a mismatched attempt", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      { ts: "1.1", text: "<@U1> first", reactions: ["eyes"] },
      { ts: "1.2", text: "<@U1> second", reactions: ["eyes"] },
    ],
  });
  const prepared = await executeSlackTool(
    "slack_prepare_file_upload",
    { issueId: "C1:1.1", filename: "result.txt", length: 6 },
    settings(),
    transport,
  );
  const fileId = (prepared.result as { fileId: string }).fileId;

  const wrongIssue = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.2", body: "wrong", fileIds: [fileId] },
    settings(),
    transport,
  );
  assert.equal(wrongIssue.success, false);
  assert.match(wrongIssue.error!, /belongs to a different issue/);

  const correctIssue = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "right", fileIds: [fileId] },
    settings(),
    transport,
  );
  assert.equal(correctIssue.success, true);
});

test("verified run authorization scopes issue tools and prepared file ids", async () => {
  const transport = new InMemorySlackTransport({
    C1: [
      { ts: "1.1", text: "<@U1> first", reactions: ["eyes"] },
      { ts: "1.2", text: "<@U1> second", reactions: ["eyes"] },
    ],
  });
  const runA = { claimId: "claim-a", runKey: "run-a", issueId: "C1:1.1" };

  const wrongIssue = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.2", body: "cross-issue reply" },
    settings(),
    transport,
    runA,
  );
  assert.equal(wrongIssue.success, false);
  assert.match(wrongIssue.error!, /authorized only.*C1:1\.1/);

  const prepared = await executeSlackTool(
    "slack_prepare_file_upload",
    { issueId: "C1:1.1", filename: "result.txt", length: 6 },
    settings(),
    transport,
    runA,
  );
  const fileId = (prepared.result as { fileId: string }).fileId;
  const wrongRun = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "wrong run", fileIds: [fileId] },
    settings(),
    transport,
    { claimId: "claim-b", runKey: "run-a", issueId: "C1:1.1" },
  );
  assert.equal(wrongRun.success, false);
  assert.match(wrongRun.error!, /unknown or expired/);

  const correctRun = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "right run", fileIds: [fileId] },
    settings(),
    transport,
    runA,
  );
  assert.equal(correctRun.success, true);
});

test("a replacement run claim discards stale upload tickets from the same slot", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> upload", reactions: ["eyes"] }],
  });
  const oldClaim = { claimId: "claim-old", runKey: "slot-a", issueId: "C1:1.1" };
  const newClaim = { claimId: "claim-new", runKey: "slot-a", issueId: "C1:1.1" };
  const stale = await executeSlackTool(
    "slack_prepare_file_upload",
    { issueId: "C1:1.1", filename: "stale.txt", length: 1 },
    settings(),
    transport,
    oldClaim,
  );
  const replacement = await executeSlackTool(
    "slack_prepare_file_upload",
    { issueId: "C1:1.1", filename: "replacement.txt", length: 1 },
    settings(),
    transport,
    newClaim,
  );

  const staleResult = await executeSlackTool(
    "slack_comment",
    {
      issueId: "C1:1.1",
      body: "stale",
      fileIds: [(stale.result as { fileId: string }).fileId],
    },
    settings(),
    transport,
    oldClaim,
  );
  assert.equal(staleResult.success, false);
  assert.match(staleResult.error!, /unknown or expired/);

  const replacementResult = await executeSlackTool(
    "slack_comment",
    {
      issueId: "C1:1.1",
      body: "replacement",
      fileIds: [(replacement.result as { fileId: string }).fileId],
    },
    settings(),
    transport,
    newClaim,
  );
  assert.equal(replacementResult.success, true);
});

test("Slack write tools reject an issued upload URL", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> upload", reactions: ["eyes"] }],
  });
  const prepared = await executeSlackTool(
    "slack_prepare_file_upload",
    { issueId: "C1:1.1", filename: "result.txt", length: 6 },
    settings(),
    transport,
  );
  const upload = prepared.result as { fileId: string; uploadUrl: string };

  for (const [tool, input] of [
    ["slack_comment", { issueId: "C1:1.1", body: `upload here: ${upload.uploadUrl}` }],
    ["slack_workpad", { issueId: "C1:1.1", plan: `- [ ] POST ${upload.uploadUrl}` }],
  ] as const) {
    const result = await executeSlackTool(tool, input, settings(), transport);
    assert.equal(result.success, false);
    assert.match(result.error!, /upload URLs cannot be included/);
  }

  const completed = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "safe result", fileIds: [upload.fileId] },
    settings(),
    transport,
  );
  assert.equal(completed.success, true);
  assert.equal(
    (await transport.getThread("C1", "1.1")).some((reply) => reply.text.includes(upload.uploadUrl)),
    false,
  );
});

test("Slack upload file ids are consumed before an ambiguous completion attempt", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> upload", reactions: ["eyes"] }],
  });
  const prepared = await executeSlackTool(
    "slack_prepare_file_upload",
    { issueId: "C1:1.1", filename: "result.txt", length: 6 },
    settings(),
    transport,
  );
  const fileId = (prepared.result as { fileId: string }).fileId;
  transport.completeFileUploads = async () => {
    throw new Error("slack files.completeUploadExternal outcome unknown");
  };

  const first = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "result", fileIds: [fileId] },
    settings(),
    transport,
  );
  assert.equal(first.success, false);
  assert.match(first.error!, /file ids were consumed/);
  assert.match(first.error!, /read the thread to reconcile/);

  const retried = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "result", fileIds: [fileId] },
    settings(),
    transport,
  );
  assert.equal(retried.success, false);
  assert.match(retried.error!, /unknown or expired/);
});

test("Slack upload ids expire and mixed validation does not partially consume them", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> upload", reactions: ["eyes"] }],
  });
  const prepared = await executeSlackTool(
    "slack_prepare_file_upload",
    { issueId: "C1:1.1", filename: "atomic.txt", length: 6 },
    settings(),
    transport,
  );
  const fileId = (prepared.result as { fileId: string }).fileId;

  const mixed = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "mixed", fileIds: [fileId, "F_UNKNOWN"] },
    settings(),
    transport,
  );
  assert.equal(mixed.success, false);
  assert.match(mixed.error!, /unknown or expired/);

  const valid = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "valid", fileIds: [fileId] },
    settings(),
    transport,
  );
  assert.equal(valid.success, true);

  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const expiring = await executeSlackTool(
      "slack_prepare_file_upload",
      { issueId: "C1:1.1", filename: "expires.txt", length: 7 },
      settings(),
      transport,
    );
    const expiringId = (expiring.result as { fileId: string }).fileId;
    vi.advanceTimersByTime(15 * 60_000);

    const expired = await executeSlackTool(
      "slack_comment",
      { issueId: "C1:1.1", body: "late", fileIds: [expiringId] },
      settings(),
      transport,
    );
    assert.equal(expired.success, false);
    assert.match(expired.error!, /unknown or expired/);
  } finally {
    vi.useRealTimers();
  }
});

test("Slack upload preparation enforces per-issue file and total-byte caps", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> upload", reactions: ["eyes"] }],
  });
  const runs = [
    { claimId: "claim-cap-a", runKey: "slot-cap-a", issueId: "C1:1.1" },
    { claimId: "claim-cap-b", runKey: "slot-cap-b", issueId: "C1:1.1" },
  ];
  const tinyIds: string[][] = [[], []];
  for (let index = 0; index < 10; index += 1) {
    const runIndex = index % runs.length;
    const prepared = await executeSlackTool(
      "slack_prepare_file_upload",
      { issueId: "C1:1.1", filename: `tiny-${index}.txt`, length: 1 },
      settings(),
      transport,
      runs[runIndex],
    );
    assert.equal(prepared.success, true);
    tinyIds[runIndex]!.push((prepared.result as { fileId: string }).fileId);
  }
  const eleventh = await executeSlackTool(
    "slack_prepare_file_upload",
    { issueId: "C1:1.1", filename: "tiny-10.txt", length: 1 },
    settings(),
    transport,
    runs[0],
  );
  assert.equal(eleventh.success, false);
  assert.match(eleventh.error!, /at most 10 pending uploads/);
  for (const [index, fileIds] of tinyIds.entries()) {
    const completed = await executeSlackTool(
      "slack_comment",
      { issueId: "C1:1.1", body: "tiny files", fileIds },
      settings(),
      transport,
      runs[index],
    );
    assert.equal(completed.success, true);
  }

  const largeIds: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const prepared = await executeSlackTool(
      "slack_prepare_file_upload",
      { issueId: "C1:1.1", filename: `large-${index}.bin`, length: 25 * 1024 * 1024 },
      settings(),
      transport,
    );
    assert.equal(prepared.success, true);
    largeIds.push((prepared.result as { fileId: string }).fileId);
  }
  const overTotal = await executeSlackTool(
    "slack_prepare_file_upload",
    { issueId: "C1:1.1", filename: "large-4.bin", length: 1 },
    settings(),
    transport,
  );
  assert.equal(overTotal.success, false);
  assert.match(overTotal.error!, /100 MiB|104857600 total bytes/);
  assert.equal(
    (
      await executeSlackTool(
        "slack_comment",
        { issueId: "C1:1.1", body: "large files", fileIds: largeIds },
        settings(),
        transport,
      )
    ).success,
    true,
  );
});

test("concurrent Slack upload preparation atomically reserves the per-issue file cap", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> upload", reactions: ["eyes"] }],
  });
  const prepare = transport.prepareFileUpload.bind(transport);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  transport.prepareFileUpload = async (request) => {
    calls += 1;
    await gate;
    return prepare(request);
  };

  const attempts = Array.from({ length: 11 }, (_, index) =>
    executeSlackTool(
      "slack_prepare_file_upload",
      { issueId: "C1:1.1", filename: `concurrent-${index}.txt`, length: 1 },
      settings(),
      transport,
    ),
  );
  try {
    await vi.waitFor(() => assert.equal(calls, 10));
  } finally {
    release();
  }
  const results = await Promise.all(attempts);
  assert.equal(results.filter((result) => result.success).length, 10);
  assert.match(results.find((result) => !result.success)!.error!, /at most 10 pending uploads/);

  const fileIds = results
    .filter((result) => result.success)
    .map((result) => (result.result as { fileId: string }).fileId);
  await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "done", fileIds },
    settings(),
    transport,
  );
});

test("concurrent Slack upload preparation atomically reserves the byte cap", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> upload", reactions: ["eyes"] }],
  });
  const prepare = transport.prepareFileUpload.bind(transport);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  transport.prepareFileUpload = async (request) => {
    calls += 1;
    await gate;
    return prepare(request);
  };

  const attempts = [
    ...Array.from({ length: 4 }, (_, index) =>
      executeSlackTool(
        "slack_prepare_file_upload",
        { issueId: "C1:1.1", filename: `large-${index}.bin`, length: 25 * 1024 * 1024 },
        settings(),
        transport,
      ),
    ),
    executeSlackTool(
      "slack_prepare_file_upload",
      { issueId: "C1:1.1", filename: "over.bin", length: 1 },
      settings(),
      transport,
    ),
  ];
  try {
    await vi.waitFor(() => assert.equal(calls, 4));
  } finally {
    release();
  }
  const results = await Promise.all(attempts);
  assert.equal(results.filter((result) => result.success).length, 4);
  assert.match(results.find((result) => !result.success)!.error!, /total bytes/);

  const fileIds = results
    .filter((result) => result.success)
    .map((result) => (result.result as { fileId: string }).fileId);
  await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "done", fileIds },
    settings(),
    transport,
  );
});

test("a failed Slack prepare releases its capacity reservation", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> upload", reactions: ["eyes"] }],
  });
  const prepare = transport.prepareFileUpload.bind(transport);
  let fail = true;
  transport.prepareFileUpload = async (request) => {
    if (fail) {
      fail = false;
      throw new Error("prepare failed");
    }
    return prepare(request);
  };

  const failed = await executeSlackTool(
    "slack_prepare_file_upload",
    { issueId: "C1:1.1", filename: "failed.txt", length: 1 },
    settings(),
    transport,
  );
  assert.equal(failed.success, false);

  const prepared = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      executeSlackTool(
        "slack_prepare_file_upload",
        { issueId: "C1:1.1", filename: `replacement-${index}.txt`, length: 1 },
        settings(),
        transport,
      ),
    ),
  );
  assert.equal(
    prepared.every((result) => result.success),
    true,
  );
  const fileIds = prepared.map((result) => (result.result as { fileId: string }).fileId);
  await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "done", fileIds },
    settings(),
    transport,
  );
});

test("Slack upload tickets are globally bounded and stale tickets are pruned", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const issueIds = Array.from({ length: 26 }, (_, index) => `C1:${index + 1}.1`);
    const transport = new InMemorySlackTransport({
      C1: issueIds.map((ts) => ({ ts: ts.slice(3), text: "<@U1> upload", reactions: ["eyes"] })),
    });
    const stale = await executeSlackTool(
      "slack_prepare_file_upload",
      { issueId: issueIds[0], filename: "stale.txt", length: 1 },
      settings(),
      transport,
      { claimId: "stale-claim", runKey: "stale-run", issueId: issueIds[0]! },
    );
    assert.equal(stale.success, true);
    vi.advanceTimersByTime(15 * 60_000);

    const prepared: Array<{ issueId: string; fileId: string }> = [];
    for (let index = 0; index < 256; index += 1) {
      const issueId = issueIds[Math.floor(index / 10)]!;
      const result = await executeSlackTool(
        "slack_prepare_file_upload",
        { issueId, filename: `bounded-${index}.txt`, length: 1 },
        settings(),
        transport,
      );
      assert.equal(result.success, true);
      prepared.push({ issueId, fileId: (result.result as { fileId: string }).fileId });
    }
    const full = await executeSlackTool(
      "slack_prepare_file_upload",
      { issueId: issueIds.at(-1), filename: "one-too-many.txt", length: 1 },
      settings(),
      transport,
    );
    assert.equal(full.success, false);
    assert.match(full.error!, /capacity reached \(256\)/);

    for (const issueId of issueIds) {
      const fileIds = prepared
        .filter((upload) => upload.issueId === issueId)
        .map((upload) => upload.fileId);
      if (fileIds.length === 0) continue;
      const completed = await executeSlackTool(
        "slack_comment",
        { issueId, body: "done", fileIds },
        settings(),
        transport,
      );
      assert.equal(completed.success, true);
    }
  } finally {
    vi.useRealTimers();
  }
});

test("Slack upload preparation rejects unsafe filenames and out-of-bounds lengths", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> upload", reactions: ["eyes"] }],
  });
  for (const input of [
    { filename: "../secret", length: 1 },
    { filename: "subdir\\secret", length: 1 },
    { filename: "empty.txt", length: 0 },
    { filename: "large.bin", length: 25 * 1024 * 1024 + 1 },
  ]) {
    const result = await executeSlackTool(
      "slack_prepare_file_upload",
      { issueId: "C1:1.1", ...input },
      settings(),
      transport,
    );
    assert.equal(result.success, false);
  }
  assert.equal(transport.preparedUploads.length, 0);
});

test("slack_read_thread rejects a channel that is not in tracker.channels", async () => {
  const transport = new InMemorySlackTransport({
    C9: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C9:1.1" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /C9/);
});

test("slack_read_thread fails when no message exists at the issueId", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:9.9" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /no tracked issue/);
});

test("slack_read_thread fails when the message is not a bot mention", async () => {
  // A HUMAN's reaction on random chatter is not the bot's tracking marker.
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "just chatting, no mention here", humanReactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:1.1" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not a tracked bot-mention/);
});

test("slack_update_status posts the authoritative status reply and mirrors the reaction", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }] },
    { botUserId: "U1" },
  );

  const moved = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
  );
  assert.equal(moved.success, true);
  assert.deepEqual(moved.result, { ok: true, status: "Done" });
  // The durable origin record precedes the authoritative status reply.
  assert.deepEqual(
    transport.replies.map((reply) => reply.body),
    ["Lorenz tracking record.", "status: Done"],
  );
  const thread = await transport.getThread("C1", "1.1");
  assert.equal(thread[0]!.metadata?.eventType, TRACKING_METADATA_EVENT);
  assert.deepEqual(thread[0]!.metadata?.payload, { origin: "root" });
  // The bot's reaction mirror tracks the status for glanceability.
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["robot_face", "white_check_mark"]);

  const replied = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "done!" },
    settings(),
    transport,
  );
  assert.equal(replied.success, true);
  assert.deepEqual(transport.replies.at(-1), {
    channel: "C1",
    threadTs: "1.1",
    body: "done!",
  });
});

test("slack_update_status resolves a case-variant status to the canonical name", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: [] }] },
    { botUserId: "U1" },
  );

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "done" },
    settings(),
    transport,
  );

  assert.equal(result.success, true);
  assert.equal((result.result as { status: string }).status, "Done");
  assert.deepEqual(
    transport.replies.map((reply) => reply.body),
    ["Lorenz tracking record.", "status: Done"],
  );
});

test("slack_update_status rejects a status outside the workflow's states", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: [] }] },
    { botUserId: "U1" },
  );

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Shipped" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /unknown status 'Shipped'/);
  assert.deepEqual(transport.replies, []);
});

test("slack_update_status works for custom states with no mapped emoji", async () => {
  // The reaction swap used to fail without an emoji mapping; the thread reply carries the
  // state regardless, so custom states no longer require an emoji_states entry.
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.1", text: "<@U1> ship it", reactions: [] }] },
    { botUserId: "U1" },
  );
  const custom = parseSlackConfig(
    {
      tracker: {
        kind: "slack",
        channels: ["C1"],
        bot_user_id: "U1",
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Shipped"],
      },
    },
    { SLACK_BOT_TOKEN: "xoxb" },
  );

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Shipped" },
    custom,
    transport,
  );

  assert.equal(result.success, true);
  assert.deepEqual(
    transport.replies.map((reply) => reply.body),
    ["Lorenz tracking record.", "status: Shipped"],
  );

  const read = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:1.1" },
    custom,
    transport,
  );
  assert.equal((read.result as { status: string }).status, "Shipped");
});

test("slack_update_status only removes managed reactions present on the root", async () => {
  // The root carries only :eyes:; transitioning to Done must remove exactly that and add
  // :white_check_mark:, not sweep a reactions.remove for every managed emoji (Tier-3 calls).
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }] },
    { botUserId: "U1" },
  );
  const removed: string[] = [];
  const remove = transport.removeReaction.bind(transport);
  transport.removeReaction = async (channel, ts, name) => {
    removed.push(name);
    return remove(channel, ts, name);
  };

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
  );

  assert.equal(result.success, true);
  assert.deepEqual(removed, ["eyes"]);
  assert.deepEqual((await transport.getMessage("C1", "1.1"))!.reactions, [
    "robot_face",
    "white_check_mark",
  ]);
});

test("a failing reaction mirror never fails the status transition", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }] },
    { botUserId: "U1" },
  );
  transport.addReaction = async () => {
    throw new Error("reactions.add exploded");
  };
  transport.removeReaction = async () => {
    throw new Error("reactions.remove exploded");
  };

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
  );

  assert.equal(result.success, true);
  assert.deepEqual(
    transport.replies.map((reply) => reply.body),
    ["Lorenz tracking record.", "status: Done"],
  );
});

test("a human command in the thread overrides the reaction reading", async () => {
  // Reactions are per-author: a human cannot remove the agent's :eyes:. The command thread
  // reply supersedes it.
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1.1",
          text: "<@U1> do the thing",
          reactions: ["eyes"],
          replies: [{ ts: "1.2", text: "<@U1> !done", user: "U_HUMAN" }],
        },
      ],
    },
    { botUserId: "U1" },
  );

  const read = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:1.1" },
    settings(),
    transport,
  );
  assert.equal((read.result as { status: string }).status, "Done");
});

test("a bare re-mention reopens a terminal issue to the default active state", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        {
          ts: "1.1",
          text: "<@U1> do the thing",
          reactions: ["white_check_mark"],
          replies: [
            { ts: "1.3", text: "<@U1> this broke again, take another look", user: "U_HUMAN" },
          ],
        },
      ],
    },
    { botUserId: "U1" },
  );

  const read = await executeSlackTool(
    "slack_read_thread",
    { issueId: "C1:1.1" },
    settings(),
    transport,
  );
  assert.equal((read.result as { status: string }).status, "Todo");
});

test("slack_update_status rejects a channel that is not in tracker.channels", async () => {
  // Seed the disallowed channel with a real bot-mention message so the only failing guard is
  // the channel allow-list, and assert no reaction side effect occurred.
  const transport = new InMemorySlackTransport({
    C9: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C9:1.1", status: "Done" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /C9/);
  const msg = await transport.getMessage("C9", "1.1");
  assert.deepEqual(msg!.reactions, ["eyes"]);
});

test("slack_comment rejects a channel that is not in tracker.channels", async () => {
  const transport = new InMemorySlackTransport({
    C9: [{ ts: "1.1", text: "<@U1> do the thing", reactions: [] }],
  });

  const result = await executeSlackTool(
    "slack_comment",
    { issueId: "C9:1.1", body: "hi" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /C9/);
  assert.deepEqual(transport.replies, []);
});

test("slack_update_status fails when no message exists at the issueId", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:9.9", status: "Done" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /no tracked issue/);
});

test("slack_comment fails when no message exists at the issueId", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> do the thing", reactions: [] }],
  });

  const result = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:9.9", body: "hi" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /no tracked issue/);
  assert.deepEqual(transport.replies, []);
});

test("slack_update_status fails when the message is not a bot mention", async () => {
  // A HUMAN's reaction on random chatter is not the bot's tracking marker.
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "just chatting, no mention here", humanReactions: ["eyes"] }],
  });

  const result = await executeSlackTool(
    "slack_update_status",
    { issueId: "C1:1.1", status: "Done" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not a tracked bot-mention/);
  const msg = await transport.getMessage("C1", "1.1");
  assert.deepEqual(msg!.reactions, ["eyes"]);
});

test("slack_comment fails when the message is not a bot mention", async () => {
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "just chatting, no mention here", reactions: [] }],
  });

  const result = await executeSlackTool(
    "slack_comment",
    { issueId: "C1:1.1", body: "hi" },
    settings(),
    transport,
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not a tracked bot-mention/);
  assert.deepEqual(transport.replies, []);
});

test("slack tools fail loudly when bot_user_id is not configured", async () => {
  // Settings can reach a mounted tool pack without dispatch validation. The transport fails
  // closed (scans nothing), so without this guard the agent would see a successful empty
  // result and conclude there is no work rather than a misconfigured tracker.
  const noBot = parseSlackConfig(
    { tracker: { kind: "slack", channels: ["C1"] } },
    { SLACK_BOT_TOKEN: "xoxb" },
  );
  const transport = new InMemorySlackTransport({
    C1: [{ ts: "1.1", text: "<@U1> tracked", reactions: [] }],
  });

  const query = await executeSlackTool("slack_query", {}, noBot, transport);
  assert.equal(query.success, false);
  assert.match(query.error ?? "", /bot_user_id/);

  const read = await executeSlackTool("slack_read_thread", { issueId: "C1:1.1" }, noBot, transport);
  assert.equal(read.success, false);
  assert.match(read.error ?? "", /bot_user_id/);
});

test("slack_user_info resolves a workspace member and fails on unknown ids", async () => {
  const transport = new InMemorySlackTransport(
    { C1: [] },
    {
      botUserId: "U1",
      users: { U_HUMAN: { id: "U_HUMAN", name: "ryan", realName: "Ryan L", isBot: false } },
    },
  );

  const found = await executeSlackTool(
    "slack_user_info",
    { userId: "U_HUMAN" },
    settings(),
    transport,
  );
  assert.equal(found.success, true);
  assert.deepEqual(found.result, {
    user: { id: "U_HUMAN", name: "ryan", realName: "Ryan L", isBot: false },
  });

  const missing = await executeSlackTool(
    "slack_user_info",
    { userId: "U_NOPE" },
    settings(),
    transport,
  );
  assert.equal(missing.success, false);
  assert.match(missing.error ?? "", /unknown slack user/);
});

test("slack_channel_context reads the window around a tracked issue only", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        { ts: "1.0", text: "earlier chatter", user: "U_A", reactions: [] },
        { ts: "2.0", text: "more context", user: "U_B", reactions: [] },
        { ts: "3.0", text: "<@U1> fix the thing", user: "U_B", reactions: [] },
        { ts: "4.0", text: "after the ask", user: "U_A", reactions: [] },
      ],
    },
    { botUserId: "U1" },
  );

  const result = await executeSlackTool(
    "slack_channel_context",
    { issueId: "C1:3.0", before: 2, after: 5 },
    settings(),
    transport,
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.result, {
    anchor: "C1:3.0",
    messages: [
      { ts: "2.0", user: "U_B", text: "more context" },
      { ts: "3.0", user: "U_B", text: "<@U1> fix the thing" },
      { ts: "4.0", user: "U_A", text: "after the ask" },
    ],
  });

  // The anchor must be a tracked issue: surrounding chatter is not a free-roaming read.
  const untracked = await executeSlackTool(
    "slack_channel_context",
    { issueId: "C1:1.0" },
    settings(),
    transport,
  );
  assert.equal(untracked.success, false);
  assert.match(untracked.error ?? "", /not a tracked bot-mention issue/);
});

test("slack_query includes bot-marked reply-tracked threads with thread state", async () => {
  const transport = new InMemorySlackTransport(
    {
      C1: [
        { ts: "1.1", text: "<@U1> mention-tracked", reactions: [] },
        {
          ts: "2.1",
          text: "background discussion",
          reactions: ["robot_face"],
          replies: [
            { ts: "2.2", text: "<@U1> please handle #infra", user: "U_HUMAN" },
            { ts: "2.3", text: "status: In Progress", user: "U1" },
          ],
        },
      ],
    },
    { botUserId: "U1" },
  );

  const res = await executeSlackTool(
    "slack_query",
    { select: ["issueId", "title", "state"] },
    settings(),
    transport,
  );
  assert.equal(res.success, true);
  const rows = (res.result as { rows: Array<Record<string, unknown>> }).rows;
  assert.deepEqual(rows, [
    { issueId: "C1:1.1", title: "mention-tracked", state: "Todo" },
    { issueId: "C1:2.1", title: "please handle #infra", state: "In Progress" },
  ]);
});
