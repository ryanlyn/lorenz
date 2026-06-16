import { spawn } from "node:child_process";
import { once } from "node:events";

import { test } from "vitest";
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
