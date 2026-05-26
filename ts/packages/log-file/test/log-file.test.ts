import fs from "node:fs/promises";
import path from "node:path";

import { test, vi } from "vitest";
import { appendLogEvent, configureLogFile, defaultLogFile } from "@symphony/cli";

import { assert } from "../../../test/assert.js";
import { tempDir } from "../../../test/helpers.js";

test("log file configuration uses pino-roll with a stable Elixir-compatible path", async () => {
  const root = await tempDir("symphony-ts-log-file");
  const logFile = defaultLogFile(root);
  assert.equal(logFile, path.join(root, "log", "symphony.log"));

  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.writeFile(logFile, "0123456789\n");
  await fs.writeFile(`${logFile}.1`, "old-one");

  await configureLogFile(logFile, {
    maxBytes: 1000,
    maxFiles: 2,
    now: () => new Date("2026-05-06T00:00:00.000Z"),
  });

  assert.equal((await fs.lstat(logFile)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(`${logFile}.1`, "utf8"), "old-one");
  const [previous, startedLine] = (await fs.readFile(logFile, "utf8")).trim().split("\n");
  assert.equal(previous, "0123456789");
  const started = JSON.parse(startedLine ?? "");
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
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(event, {
    at: "2026-05-06T00:00:01.000Z",
    event: "poll",
    message: "ok",
  });
});

test("log file configuration delegates size rotation to pino-roll", async () => {
  const root = await tempDir("symphony-ts-log-file-roll");
  const logFile = defaultLogFile(root);
  const maxFiles = 1;
  const maxBytes = 120;
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.writeFile(`${logFile}.1`, "stale-one");
  await fs.writeFile(`${logFile}.2`, "stale-two");
  await fs.writeFile(`${logFile}.3`, "stale-three");

  await configureLogFile(logFile, {
    maxBytes,
    maxFiles,
    now: () => new Date("2026-05-06T00:00:00.000Z"),
  });
  const logDir = path.dirname(logFile);
  for (let index = 0; index < 3; index += 1) {
    await appendLogEvent(logFile, {
      event: "large",
      index,
      message: "x".repeat(160),
    });
    // Wait for pino to write. After a size-triggered rotation the symlink may
    // already point to a new file (drain fires via process.nextTick), so check
    // all log files in the directory rather than only the symlink target.
    await vi.waitFor(
      async () => {
        const entries = await fs.readdir(logDir);
        const contents = await Promise.all(
          entries.map((entry) => fs.readFile(path.join(logDir, entry), "utf8").catch(() => "")),
        );
        assert.ok(contents.some((c) => c.includes(`"index":${index}`)));
      },
      { timeout: 2_000, interval: 5 },
    );
  }
  await appendLogEvent(logFile, { event: "after_roll", message: "ok" });
  await vi.waitFor(
    async () => {
      assert.match(await fs.readFile(logFile, "utf8"), /"event":"after_roll"/);
    },
    { timeout: 2_000, interval: 5 },
  );

  const files = await fs.readdir(path.dirname(logFile));
  const numberedLogs = files.filter((file) => /^symphony\.log\.\d+$/.test(file));
  assert.ok(numberedLogs.length <= maxFiles + 1); // we always keep one old log + one active log file
  assert.equal(numberedLogs.includes("symphony.log.1"), false);
  assert.equal((await fs.lstat(logFile)).isSymbolicLink(), true);
  assert.match(await fs.readFile(logFile, "utf8"), /"event":"after_roll"/);
});

test("log file configuration warns without crashing when the sink is unavailable", async () => {
  const root = await tempDir("symphony-ts-log-file-blocked");
  const blocker = path.join(root, "blocked");
  await fs.writeFile(blocker, "not a directory");

  await configureLogFile(path.join(blocker, "symphony.log"));
});
