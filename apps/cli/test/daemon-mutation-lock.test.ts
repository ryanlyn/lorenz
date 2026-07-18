import path from "node:path";
import fs, { readFile, rm, stat, writeFile } from "node:fs/promises";

import { test, vi } from "vitest";
import { assert, tempDir } from "@lorenz/test-utils";

import { withDaemonLockMutation } from "../src/daemonMutationLock.js";

test("daemon mutation lock serializes concurrent contenders", async () => {
  const root = await tempDir("lorenz-daemon-mutation-contention");
  const lockPath = path.join(root, "daemon.lock.json");
  const mutationPath = `${lockPath}.mutation`;
  let releaseFirst = () => {};
  let markFirstEntered = () => {};
  let markSecondAttempted = () => {};
  const firstMayExit = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstEntered = new Promise<void>((resolve) => {
    markFirstEntered = resolve;
  });
  const secondAttempted = new Promise<void>((resolve) => {
    markSecondAttempted = resolve;
  });
  const order: string[] = [];
  const originalOpen = fs.open.bind(fs);
  let mutationOpenAttempts = 0;
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (String(file) === mutationPath) {
      mutationOpenAttempts += 1;
      if (mutationOpenAttempts === 2) markSecondAttempted();
    }
    return originalOpen(file, flags, mode);
  });

  try {
    const first = withDaemonLockMutation(lockPath, async () => {
      order.push("first entered");
      markFirstEntered();
      await firstMayExit;
      order.push("first exited");
    });
    await firstEntered;

    const second = withDaemonLockMutation(lockPath, async () => {
      order.push("second entered");
    });
    await secondAttempted;
    const orderWhileContended = [...order];
    releaseFirst();
    await Promise.all([first, second]);

    assert.deepEqual(orderWhileContended, ["first entered"]);
    assert.deepEqual(order, ["first entered", "first exited", "second entered"]);
  } finally {
    releaseFirst();
    openSpy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon mutation lock serializes contenders racing to recover a stale guard", async () => {
  const root = await tempDir("lorenz-daemon-mutation-race");
  const lockPath = path.join(root, "daemon.lock.json");
  const mutationPath = `${lockPath}.mutation`;
  let releaseFirst = () => {};
  let markFirstEntered = () => {};
  const firstMayExit = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstEntered = new Promise<void>((resolve) => {
    markFirstEntered = resolve;
  });
  const originalOpen = fs.open.bind(fs);
  let mutationOpenAttempts = 0;
  const openSpy = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (String(file) === mutationPath) mutationOpenAttempts += 1;
    return originalOpen(file, flags, mode);
  });

  try {
    await writeFile(
      mutationPath,
      JSON.stringify({
        token: "stale-token",
        pid: 101,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      "utf8",
    );

    let active = 0;
    let maximumActive = 0;
    let firstOperation = true;
    let attemptsAtFirstEntry = 0;
    const operations = Array.from({ length: 4 }, (_, index) =>
      withDaemonLockMutation(lockPath, async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (firstOperation) {
          firstOperation = false;
          attemptsAtFirstEntry = mutationOpenAttempts;
          markFirstEntered();
          await firstMayExit;
        }
        active -= 1;
        return index;
      }),
    );
    await firstEntered;
    await vi.waitFor(() => {
      assert.ok(mutationOpenAttempts > attemptsAtFirstEntry);
    });
    releaseFirst();
    const completed = await Promise.all(operations);

    assert.deepEqual(completed.toSorted(), [0, 1, 2, 3]);
    assert.equal(maximumActive, 1);
    const leftover = await fs.readdir(root);
    assert.equal(
      leftover.some((name) => name.endsWith(".mutation") || name.endsWith(".recovery")),
      false,
    );
  } finally {
    releaseFirst();
    openSpy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon mutation lock recovers a stale malformed guard", async () => {
  const root = await tempDir("lorenz-daemon-mutation-malformed");
  const lockPath = path.join(root, "daemon.lock.json");
  const mutationPath = `${lockPath}.mutation`;

  try {
    await writeFile(mutationPath, "{", "utf8");
    const staleTime = new Date(Date.now() - 60_000);
    await fs.utimes(mutationPath, staleTime, staleTime);

    assert.equal(await withDaemonLockMutation(lockPath, async () => "acquired"), "acquired");
    await assert.rejects(() => readFile(mutationPath, "utf8"), "ENOENT");
    await assert.rejects(() => readFile(`${mutationPath}.recovery`, "utf8"), "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon mutation lock release does not unlink a foreign ownership token", async () => {
  const root = await tempDir("lorenz-daemon-mutation-token");
  const lockPath = path.join(root, "daemon.lock.json");
  const mutationPath = `${lockPath}.mutation`;

  try {
    await withDaemonLockMutation(lockPath, async () => {
      const current = JSON.parse(await readFile(mutationPath, "utf8")) as Record<string, unknown>;
      await writeFile(
        mutationPath,
        `${JSON.stringify({ ...current, token: "successor-token" }, null, 2)}\n`,
        "utf8",
      );
    });

    const remaining = JSON.parse(await readFile(mutationPath, "utf8")) as {
      token?: unknown;
    };
    assert.equal(remaining.token, "successor-token");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon mutation lock creates private lock files and directories", async () => {
  const root = await tempDir("lorenz-daemon-mutation-mode");
  const lockDirectory = path.join(root, "nested");
  const lockPath = path.join(lockDirectory, "daemon.lock.json");
  const mutationPath = `${lockPath}.mutation`;

  try {
    const modes = await withDaemonLockMutation(lockPath, async () => ({
      directory: (await stat(lockDirectory)).mode & 0o777,
      mutation: (await stat(mutationPath)).mode & 0o777,
    }));

    assert.deepEqual(modes, { directory: 0o700, mutation: 0o600 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
