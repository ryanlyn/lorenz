import { assert } from "../../../test/assert.js";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import type { Message } from "vscode-jsonrpc";
import { CodexNdjsonMessageReader, CodexNdjsonMessageWriter } from "@symphony/codex";

test("Codex NDJSON reader preserves UTF-8 chunks and reports malformed lines", async () => {
  const input = new PassThrough();
  const messages: Message[] = [];
  const malformed: string[] = [];
  const notifications: Record<string, unknown>[] = [];
  const requests: Array<Record<string, unknown> & { method: string }> = [];
  const reader = new CodexNdjsonMessageReader(input, {
    onMalformedLine: (line) => malformed.push(line),
    onNotification: (message) => notifications.push(message),
    onRequest: (message) => requests.push(message),
  });

  const closed = new Promise<void>((resolve) => {
    reader.onClose(() => resolve());
  });
  reader.listen((message) => messages.push(message));

  const payload = Buffer.from(`${JSON.stringify({ id: 1, result: { text: "hello 🙂 世界" } })}\n`);
  input.write(payload.subarray(0, payload.length - 4));
  input.write(payload.subarray(payload.length - 4));
  input.write(`${JSON.stringify({ method: "turn/completed" })}\n`);
  input.write(`${JSON.stringify({ id: "tool-1", method: "item/tool/call", params: {} })}\n`);
  input.write('{"method":"turn/failed"\n');
  input.end();
  await closed;

  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0], { jsonrpc: "2.0", id: 1, result: { text: "hello 🙂 世界" } });
  assert.deepEqual(notifications, [{ method: "turn/completed" }]);
  assert.deepEqual(requests, [{ id: "tool-1", method: "item/tool/call", params: {} }]);
  assert.deepEqual(malformed, ['{"method":"turn/failed"']);
});

test("Codex NDJSON writer strips JSON-RPC headers from wire messages", async () => {
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  const writer = new CodexNdjsonMessageWriter(output);

  await writer.write({
    jsonrpc: "2.0",
    id: 7,
    method: "initialize",
    params: { capabilities: {} },
  } as Message);

  assert.equal(chunks.join(""), '{"id":7,"method":"initialize","params":{"capabilities":{}}}\n');
});

test("Codex NDJSON transport preserves one-based wire request ids", async () => {
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  const writer = new CodexNdjsonMessageWriter(output, { requestIdOffset: 1 });

  await writer.write({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {},
  } as Message);
  assert.equal(chunks.join(""), '{"id":1,"method":"initialize","params":{}}\n');

  const input = new PassThrough();
  const messages: Message[] = [];
  const reader = new CodexNdjsonMessageReader(input, { requestIdOffset: 1 });
  const closed = new Promise<void>((resolve) => reader.onClose(() => resolve()));
  reader.listen((message) => messages.push(message));
  input.end('{"id":1,"result":{}}\n');
  await closed;

  assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 0, result: {} }]);
});
