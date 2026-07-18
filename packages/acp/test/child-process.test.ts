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
  "stopChild waits for a guardian to terminate descendants",
  async () => {
    const child = spawn(
      "bash",
      [
        "-lc",
        [
          "set -m",
          `"$NODE_BINARY" -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)' &`,
          "bridge_pid=$!",
          "cleanup() {",
          "  trap - HUP INT TERM EXIT",
          '  kill -TERM -- "-$bridge_pid" 2>/dev/null || true',
          '  (sleep 1; kill -KILL -- "-$bridge_pid" 2>/dev/null || true) &',
          "  force_pid=$!",
          '  wait "$bridge_pid" 2>/dev/null || true',
          '  wait "$force_pid" 2>/dev/null || true',
          "}",
          "trap cleanup HUP INT TERM EXIT",
          'printf "%s\\n" "$bridge_pid"',
          'wait "$bridge_pid"',
          "status=$?",
          "cleanup",
          'exit "$status"',
        ].join("\n"),
      ],
      { detached: true, env: { ...process.env, NODE_BINARY: process.execPath } },
    );
    const [chunk] = (await once(child.stdout, "data")) as [Buffer];
    const descendantPid = Number(chunk.toString());
    let descendantStopped = false;

    try {
      await stopChild(child);
      await vi.waitFor(() => {
        assert.throws(() => process.kill(descendantPid, 0));
      });
      descendantStopped = true;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (!descendantStopped) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // The descendant has exited.
        }
      }
    }
  },
);
