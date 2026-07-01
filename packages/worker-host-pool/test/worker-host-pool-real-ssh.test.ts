import { test } from "vitest";
import { assert } from "@lorenz/test-utils";

import { WorkerHostPool } from "@lorenz/worker-host-pool";

test("acquireRemoteMcpTunnel fails before handing out a lease when ssh cannot be spawned", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const pool = new WorkerHostPool();

    await assert.rejects(
      () => pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000, process.env),
      /ssh_not_found/,
    );
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});
