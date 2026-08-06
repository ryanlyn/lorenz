import fs from "node:fs/promises";
import path from "node:path";

import { issueAttachmentRelativePath, type IssueAttachment } from "@lorenz/domain";
import { assert, tempDir } from "@lorenz/test-utils";
import { test, vi } from "vitest";

import {
  materializeWorkspaceIssueAttachments,
  runHook,
  type WorkspaceIssueAttachmentOpener,
} from "../src/index.js";

const generousLimits = {
  maxFiles: 10,
  maxFileBytes: 1_024,
  maxTotalBytes: 4_096,
} as const;

test("materializeWorkspaceIssueAttachments sanitizes names and returns the prompt-visible path", async () => {
  const workspace = await tempDir("ws-attachments-path");
  const attachment: IssueAttachment = {
    id: "../../private/id",
    name: "../../../outside secret.txt",
  };

  const result = await materializeWorkspaceIssueAttachments(
    workspace,
    [attachment],
    async () => ({ body: chunks("safe contents") }),
    undefined,
    generousLimits,
  );

  const expectedRelativePath = issueAttachmentRelativePath(attachment);
  assert.deepEqual(result.failures, []);
  assert.equal(result.materialized[0]?.relativePath, expectedRelativePath);
  assert.equal(result.materialized[0]?.actualSizeBytes, 13);
  assert.equal(
    await fs.readFile(path.join(workspace, expectedRelativePath), "utf8"),
    "safe contents",
  );
  assert.equal((await fs.stat(path.join(workspace, expectedRelativePath))).mode & 0o777, 0o600);
  assert.equal(await fileExists(path.join(workspace, "outside secret.txt")), false);
});

test("materializeWorkspaceIssueAttachments enforces advertised limits before opening", async () => {
  const workspace = await tempDir("ws-attachments-advertised-limits");
  const attachments: IssueAttachment[] = [
    { id: "too-large", name: "large.bin", sizeBytes: 6 },
    { id: "resolved-too-large", name: "resolved-large.bin", sizeBytes: 4 },
    { id: "within-limit", name: "small.bin", sizeBytes: 4 },
  ];
  const openAttachment = vi.fn<WorkspaceIssueAttachmentOpener>(async (attachment) => ({
    body: chunks(attachment.id === "within-limit" ? "four" : "unused"),
    sizeBytes: attachment.id === "resolved-too-large" ? 6 : 4,
  }));

  const result = await materializeWorkspaceIssueAttachments(
    workspace,
    attachments,
    openAttachment,
    null,
    { maxFiles: 3, maxFileBytes: 5, maxTotalBytes: 5 },
  );

  assert.equal(openAttachment.mock.calls.length, 2);
  assert.equal(openAttachment.mock.calls[0]?.[0], attachments[1]);
  assert.equal(openAttachment.mock.calls[0]?.[1].maxBytes, 5);
  assert.equal(openAttachment.mock.calls[1]?.[0], attachments[2]);
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0]?.error.message ?? "", /file_size_limit_exceeded/);
  assert.match(result.failures[1]?.error.message ?? "", /file_size_limit_exceeded/);
  assert.deepEqual(
    result.materialized.map(({ attachment }) => attachment.id),
    ["within-limit"],
  );
});

test("materializeWorkspaceIssueAttachments caps the number of opened files", async () => {
  const workspace = await tempDir("ws-attachments-file-limit");
  const attachments: IssueAttachment[] = [
    { id: "first", name: "first.txt" },
    { id: "second", name: "second.txt" },
  ];
  const openAttachment = vi.fn<WorkspaceIssueAttachmentOpener>(async () => ({
    body: chunks("ok"),
  }));

  const result = await materializeWorkspaceIssueAttachments(
    workspace,
    attachments,
    openAttachment,
    undefined,
    { ...generousLimits, maxFiles: 1 },
  );

  assert.equal(openAttachment.mock.calls.length, 1);
  assert.deepEqual(
    result.materialized.map(({ attachment }) => attachment.id),
    ["first"],
  );
  assert.equal(result.failures[0]?.attachment, attachments[1]);
  assert.match(result.failures[0]?.error.message ?? "", /file_limit_exceeded/);
});

test("materializeWorkspaceIssueAttachments enforces actual streamed per-file and total caps", async () => {
  const workspace = await tempDir("ws-attachments-streamed-limits");
  const attachments: IssueAttachment[] = [
    { id: "per-file", name: "per-file.bin" },
    { id: "first", name: "first.bin" },
    { id: "total", name: "total.bin" },
    { id: "last", name: "last.bin" },
  ];
  const bodies = new Map<string, AsyncIterable<Uint8Array>>([
    ["first", chunks("1234")],
    ["per-file", chunks("123", "456")],
    ["total", chunks("123")],
    ["last", chunks("12")],
  ]);

  const result = await materializeWorkspaceIssueAttachments(
    workspace,
    attachments,
    async (attachment) => ({ body: bodies.get(attachment.id)! }),
    undefined,
    { maxFiles: 4, maxFileBytes: 5, maxTotalBytes: 6 },
  );

  assert.deepEqual(
    result.materialized.map(({ attachment, actualSizeBytes }) => [attachment.id, actualSizeBytes]),
    [
      ["first", 4],
      ["last", 2],
    ],
  );
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0]?.error.message ?? "", /file_size_limit_exceeded/);
  assert.match(result.failures[1]?.error.message ?? "", /total_size_limit_exceeded/);
  assert.equal(
    await fileExists(path.join(workspace, issueAttachmentRelativePath(attachments[0]!))),
    false,
  );
  assert.equal(
    await fileExists(path.join(workspace, issueAttachmentRelativePath(attachments[2]!))),
    false,
  );
});

test("materializeWorkspaceIssueAttachments isolates opener and stream failures", async () => {
  const workspace = await tempDir("ws-attachments-isolation");
  const attachments: IssueAttachment[] = [
    { id: "open-fails", name: "one.txt" },
    { id: "stream-fails", name: "two.txt" },
    { id: "works", name: "three.txt" },
  ];
  const openError = new Error("provider refused download");
  const streamError = new Error("provider stream disconnected");

  const result = await materializeWorkspaceIssueAttachments(
    workspace,
    attachments,
    async (attachment) => {
      if (attachment.id === "open-fails") throw openError;
      if (attachment.id === "stream-fails") return { body: failingChunks(streamError) };
      return { body: chunks("available") };
    },
    undefined,
    generousLimits,
  );

  assert.deepEqual(
    result.failures.map(({ attachment, error }) => [attachment.id, error]),
    [
      ["open-fails", openError],
      ["stream-fails", streamError],
    ],
  );
  assert.deepEqual(
    result.materialized.map(({ attachment }) => attachment.id),
    ["works"],
  );
  assert.equal(
    await fs.readFile(path.join(workspace, issueAttachmentRelativePath(attachments[2]!)), "utf8"),
    "available",
  );
});

test("materializeWorkspaceIssueAttachments clears stale managed files when every download fails", async () => {
  const workspace = await tempDir("ws-attachments-replace");
  const managedRoot = path.join(workspace, ".lorenz", "attachments");
  await fs.mkdir(managedRoot, { recursive: true });
  await fs.writeFile(path.join(managedRoot, "stale.txt"), "stale");
  await fs.writeFile(path.join(workspace, ".lorenz", ".gitignore"), "keep-me\n");
  const attachment: IssueAttachment = { id: "new", name: "new.txt" };

  const result = await materializeWorkspaceIssueAttachments(
    workspace,
    [attachment],
    async () => {
      throw new Error("download unavailable");
    },
    undefined,
    generousLimits,
  );

  assert.equal(result.materialized.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(await fileExists(path.join(managedRoot, "stale.txt")), false);
  assert.deepEqual(await fs.readdir(managedRoot), []);
  assert.equal(
    await fs.readFile(path.join(workspace, ".lorenz", ".gitignore"), "utf8"),
    "keep-me\n",
  );
});

test("materializeWorkspaceIssueAttachments throws guarded filesystem failures", async () => {
  const workspace = await tempDir("ws-attachments-filesystem-failure");
  const outside = await tempDir("ws-attachments-filesystem-outside");
  await fs.symlink(outside, path.join(workspace, ".lorenz"));

  await assert.rejects(
    () =>
      materializeWorkspaceIssueAttachments(
        workspace,
        [{ id: "file", name: "file.txt" }],
        async () => ({ body: chunks("contents") }),
        undefined,
        generousLimits,
      ),
    /unsafe symlink/,
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test("hook attachment paths match materialized prompt paths", async () => {
  const workspace = await tempDir("ws-attachments-hook-path");
  const output = path.join(workspace, "hook-path.txt");
  const attachment: IssueAttachment = { id: "slack/file", name: "screen shot.png" };
  const result = await materializeWorkspaceIssueAttachments(
    workspace,
    [attachment],
    async () => ({ body: chunks("image") }),
    undefined,
    generousLimits,
  );

  await runHook(
    `printf '%s' {% for attachment in issue.attachments %}{{ attachment.relative_path }}{% endfor %} > ${JSON.stringify(output)}`,
    workspace,
    { timeoutMs: 5_000 },
    undefined,
    {},
    {
      id: "issue-id",
      identifier: "SLACK-1",
      title: "Attachment intake",
      attachments: [attachment],
      state: "Todo",
      stateType: "unstarted",
      blockers: [],
      labels: [],
      raw: {},
    },
  );

  assert.equal(await fs.readFile(output, "utf8"), result.materialized[0]?.relativePath);
});

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

async function* failingChunks(error: Error): AsyncIterable<Uint8Array> {
  yield Buffer.from("partial");
  throw error;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
