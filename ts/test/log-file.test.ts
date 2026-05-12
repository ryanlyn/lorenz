import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { appendLogEvent, configureLogFile, defaultLogFile } from "../src/index.js";
import { tempDir } from "./helpers.js";

test("log file configuration uses Elixir-compatible default path and rotates old files", async () => {
  const root = await tempDir("symphony-ts-log-file");
  const logFile = defaultLogFile(root);
  assert.equal(logFile, path.join(root, "log", "symphony.log"));

  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.writeFile(logFile, "0123456789");
  await fs.writeFile(`${logFile}.1`, "old-one");

  await configureLogFile(logFile, {
    maxBytes: 5,
    maxFiles: 2,
    now: () => new Date("2026-05-06T00:00:00.000Z"),
  });

  assert.equal(await fs.readFile(`${logFile}.1`, "utf8"), "0123456789");
  assert.equal(await fs.readFile(`${logFile}.2`, "utf8"), "old-one");
  const started = JSON.parse(await fs.readFile(logFile, "utf8"));
  assert.deepEqual(started, {
    at: "2026-05-06T00:00:00.000Z",
    event: "symphony_ts_started",
  });

  await appendLogEvent(logFile, {
    at: "2026-05-06T00:00:01.000Z",
    event: "poll",
    message: "ok",
  });
  const [, event] = (await fs.readFile(logFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(event, {
    at: "2026-05-06T00:00:01.000Z",
    event: "poll",
    message: "ok",
  });
});

test("log file configuration warns without crashing when the sink is unavailable", async () => {
  const root = await tempDir("symphony-ts-log-file-blocked");
  const blocker = path.join(root, "blocked");
  await fs.writeFile(blocker, "not a directory");

  await configureLogFile(path.join(blocker, "symphony.log"));
});
