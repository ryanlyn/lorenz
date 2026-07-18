import { spawn } from "node:child_process";
import { once } from "node:events";

import { test, vi } from "vitest";
import { assert } from "@lorenz/test-utils";

import { stopChild } from "../src/childProcess.js";

test("stopChild waits for SIGKILL close when SIGTERM is handled", async () => {
  const child = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
  ]);
  let closed = false;
  child.once("close", () => {
    closed = true;
  });

  try {
    await once(child.stdout, "data");

    await stopChild(child);

    assert.equal(closed, true);
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    if (!closed) {
      const closePromise = once(child, "close");
      child.kill("SIGKILL");
      await closePromise;
    }
  }
});

test.skipIf(process.platform === "win32")(
  "stopChild terminates a detached process group",
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
          "process.stdout.write(String(descendant.pid));",
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      { detached: true },
    );
    const [chunk] = (await once(child.stdout, "data")) as [Buffer];
    const descendantPid = Number(chunk.toString());

    try {
      await stopChild(child, { processGroup: true });
      await vi.waitFor(() => {
        assert.throws(() => process.kill(descendantPid, 0));
      });
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The process group has exited.
      }
    }
  },
);
