import type * as fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, test, vi } from "vitest";
import { appendLogEvent, configureLogFile, defaultLogFile } from "@symphony/cli";

import { assert } from "../../../test/assert.js";
import { tempDir } from "../../../test/helpers.js";

const fsSyncMockState = vi.hoisted(() => ({
  failNextSymlinkSync: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fsSync>();
  const symlinkSync: typeof actual.symlinkSync = (...args) => {
    if (fsSyncMockState.failNextSymlinkSync) {
      fsSyncMockState.failNextSymlinkSync = false;
      throw new Error("synthetic stable symlink failure");
    }
    return actual.symlinkSync(...args);
  };
  return {
    ...actual,
    symlinkSync,
  };
});

afterEach(() => {
  fsSyncMockState.failNextSymlinkSync = false;
});

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
  // pruneRollFilesSync keeps at most maxFiles+1 numbered roll files (keepCount).
  // With maxFiles=1, that means at most 2 numbered files remain.
  assert.equal(
    numberedLogs.length <= maxFiles + 1,
    true,
    `Expected at most ${maxFiles + 1} numbered log files, got ${numberedLogs.length}: ${numberedLogs.join(", ")}`,
  );
  // The stale pre-existing files (symphony.log.1, .2, .3) must have been pruned.
  assert.equal(
    numberedLogs.includes("symphony.log.1"),
    false,
    "stale symphony.log.1 should be pruned",
  );
  assert.equal(
    numberedLogs.includes("symphony.log.2"),
    false,
    "stale symphony.log.2 should be pruned",
  );
  assert.equal(
    numberedLogs.includes("symphony.log.3"),
    false,
    "stale symphony.log.3 should be pruned",
  );
  assert.equal((await fs.lstat(logFile)).isSymbolicLink(), true);
  assert.match(await fs.readFile(logFile, "utf8"), /"event":"after_roll"/);
});

test("rotation filesystem failures warn instead of escaping from the drain callback", async () => {
  const root = await tempDir("symphony-ts-log-file-roll-warning");
  const logFile = defaultLogFile(root);
  await configureLogFile(logFile, {
    maxBytes: 120,
    maxFiles: 1,
    now: () => new Date("2026-05-06T00:00:00.000Z"),
  });

  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const uncaughtErrors: unknown[] = [];
  const uncaughtHandler = (error: Error) => {
    uncaughtErrors.push(error);
  };
  process.once("uncaughtException", uncaughtHandler);
  try {
    fsSyncMockState.failNextSymlinkSync = true;
    await appendLogEvent(logFile, {
      event: "large",
      message: "x".repeat(160),
    });
    await waitForSyntheticSymlinkFailure();

    assert.deepEqual(uncaughtErrors, []);
    assert.ok(
      stderrSpy.mock.calls.some((call) =>
        String(call[0]).includes("synthetic stable symlink failure"),
      ),
      "expected rotation failure to be reported to stderr",
    );
  } finally {
    process.removeListener("uncaughtException", uncaughtHandler);
    stderrSpy.mockRestore();
  }
});

test("stable log path remains available if rotation symlink replacement fails", async () => {
  const root = await tempDir("symphony-ts-log-file-roll-stable");
  const logFile = defaultLogFile(root);
  await configureLogFile(logFile, {
    maxBytes: 120,
    maxFiles: 1,
    now: () => new Date("2026-05-06T00:00:00.000Z"),
  });
  const previousTarget = await fs.readlink(logFile);

  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const uncaughtHandler = () => {};
  process.once("uncaughtException", uncaughtHandler);
  try {
    fsSyncMockState.failNextSymlinkSync = true;
    await appendLogEvent(logFile, {
      event: "large",
      message: "x".repeat(160),
    });
    await waitForSyntheticSymlinkFailure();

    assert.equal((await fs.lstat(logFile)).isSymbolicLink(), true);
    assert.equal(await fs.readlink(logFile), previousTarget);
    assert.ok(
      stderrSpy.mock.calls.some((call) =>
        String(call[0]).includes("synthetic stable symlink failure"),
      ),
      "expected rotation failure to be reported to stderr",
    );
  } finally {
    process.removeListener("uncaughtException", uncaughtHandler);
    stderrSpy.mockRestore();
  }
});

test("log file configuration warns without crashing when the sink is unavailable", async () => {
  const root = await tempDir("symphony-ts-log-file-blocked");
  const blocker = path.join(root, "blocked");
  await fs.writeFile(blocker, "not a directory");

  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await configureLogFile(path.join(blocker, "symphony.log"));
    assert.ok(stderrSpy.mock.calls.length > 0);
    const warning = String(stderrSpy.mock.calls[0]?.[0]);
    assert.match(warning, /log_file_unavailable/);
    assert.match(warning, /blocked/);
  } finally {
    stderrSpy.mockRestore();
  }
});

async function waitForSyntheticSymlinkFailure(): Promise<void> {
  await vi.waitFor(
    () => {
      assert.equal(fsSyncMockState.failNextSymlinkSync, false);
    },
    { timeout: 2_000, interval: 5 },
  );
}

test("appendLogEvent without prior configureLogFile uses default logger path", async () => {
  const root = await tempDir("symphony-ts-log-file-coldstart");
  const logFile = path.join(root, "log", "symphony.log");

  await appendLogEvent(logFile, {
    at: "2026-05-06T12:00:00.000Z",
    event: "cold_start_event",
    message: "hello from cold start",
  });

  await vi.waitFor(
    async () => {
      const content = await fs.readFile(logFile, "utf8");
      assert.match(content, /"event":"cold_start_event"/);
      assert.match(content, /"message":"hello from cold start"/);
    },
    { timeout: 2_000, interval: 5 },
  );

  // Verify the symlink was created as part of the default logger setup
  assert.equal((await fs.lstat(logFile)).isSymbolicLink(), true);
});

test("appendLogEvent emits stderr warning when writing fails after configuration", async () => {
  const root = await tempDir("symphony-ts-log-file-write-fail");
  const logFile = path.join(root, "log", "symphony.log");
  await fs.mkdir(path.dirname(logFile), { recursive: true });

  // Use a path nested under a file (not a directory) to force mkdir to fail
  // when the default logger tries to create the directory.
  const blocker = path.join(root, "nope");
  await fs.writeFile(blocker, "not a directory");
  const badLogFile = path.join(blocker, "sub", "symphony.log");

  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    // appendLogEvent on an impossible path should warn to stderr, not throw
    await appendLogEvent(badLogFile, {
      event: "should_fail",
      message: "cannot write here",
    });
    assert.ok(stderrSpy.mock.calls.length > 0);
    const warning = String(stderrSpy.mock.calls[0]?.[0]);
    assert.match(warning, /log_file_unavailable/);
    assert.match(warning, /nope/);
  } finally {
    stderrSpy.mockRestore();
  }
});
