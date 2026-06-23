import path from "node:path";
import fs, { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { test, vi } from "vitest";
import { assert } from "@lorenz/test-utils";

import {
  acquireDaemonLock,
  createDaemonIdentity,
  daemonLockIsStale,
  daemonLockPath,
  LocalFileDaemonLeadershipStore,
  readDaemonLock,
} from "../src/daemonLock.js";
import { daemonStatusPayload } from "../src/daemonStatus.js";

test("daemon lock records owner identity and rejects a second live owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-lock-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    const lockPath = daemonLockPath(root, workflowPath);
    const firstIdentity = createDaemonIdentity({
      workflowPath,
      workspaceRoot: root,
      ownerId: "owner-a",
      pid: 101,
      hostname: "host-a",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const first = await acquireDaemonLock({
      lockPath,
      identity: firstIdentity,
      endpoint: { kind: "socket", address: "/tmp/lorenz.sock" },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(first.status, "acquired");
    if (first.status !== "acquired") throw new Error("first lock should be acquired");

    const second = await acquireDaemonLock({
      lockPath,
      identity: createDaemonIdentity({
        workflowPath,
        workspaceRoot: root,
        ownerId: "owner-b",
        pid: 202,
        now: new Date("2026-01-01T00:00:10.000Z"),
      }),
      endpoint: { kind: "socket", address: "/tmp/other.sock" },
      now: new Date("2026-01-01T00:00:10.000Z"),
    });

    assert.equal(second.status, "conflict");
    if (second.status !== "conflict") throw new Error("second lock should conflict");
    assert.equal(second.stale, false);
    assert.equal(second.record?.ownerId, "owner-a");
    assert.equal(second.record?.endpoint.address, "/tmp/lorenz.sock");

    assert.equal(await first.lock.release(), true);
    assert.equal(await readDaemonLock(lockPath), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon heartbeat updates only the owning lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-heartbeat-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    const lockPath = daemonLockPath(root, workflowPath);
    const acquired = await acquireDaemonLock({
      lockPath,
      identity: createDaemonIdentity({
        workflowPath,
        workspaceRoot: root,
        ownerId: "owner-a",
        now: new Date("2026-01-01T00:00:00.000Z"),
      }),
      endpoint: { kind: "http", address: "http://127.0.0.1:4040" },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") throw new Error("lock should be acquired");

    const heartbeat = await acquired.lock.heartbeat(new Date("2026-01-01T00:00:30.000Z"));
    assert.equal(heartbeat.heartbeatAt, "2026-01-01T00:00:30.000Z");
    assert.equal((await readDaemonLock(lockPath))?.heartbeatAt, "2026-01-01T00:00:30.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local file daemon leadership store exposes lease operations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-leadership-store-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    const lockPath = daemonLockPath(root, workflowPath);
    const store = new LocalFileDaemonLeadershipStore();
    const acquired = await store.acquire({
      lockPath,
      identity: createDaemonIdentity({
        workflowPath,
        workspaceRoot: root,
        ownerId: "owner-a",
        pid: 101,
        hostname: "host-a",
        now: new Date("2026-01-01T00:00:00.000Z"),
      }),
      endpoint: { kind: "socket", address: "/tmp/lorenz.sock" },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") throw new Error("leadership should be acquired");

    const heartbeat = await acquired.lease.heartbeat(new Date("2026-01-01T00:00:30.000Z"));
    assert.equal(heartbeat.heartbeatAt, "2026-01-01T00:00:30.000Z");

    const record = await store.read(lockPath);
    assert.equal(record?.ownerId, "owner-a");
    assert.equal(
      record ? store.isStale(record, new Date("2026-01-01T00:00:31.000Z"), 60_000) : null,
      false,
    );
    assert.equal(await acquired.lease.release(), true);
    assert.equal(await store.read(lockPath), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon heartbeat does not replace a successor lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-successor-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    const lockPath = daemonLockPath(root, workflowPath);
    const first = await acquireDaemonLock({
      lockPath,
      identity: createDaemonIdentity({
        workflowPath,
        workspaceRoot: root,
        ownerId: "owner-a",
        now: new Date("2026-01-01T00:00:00.000Z"),
      }),
      endpoint: { kind: "http", address: "http://127.0.0.1:4040" },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(first.status, "acquired");
    if (first.status !== "acquired") throw new Error("first lock should be acquired");
    assert.equal(await first.lock.release(), true);

    const second = await acquireDaemonLock({
      lockPath,
      identity: createDaemonIdentity({
        workflowPath,
        workspaceRoot: root,
        ownerId: "owner-b",
        now: new Date("2026-01-01T00:00:10.000Z"),
      }),
      endpoint: { kind: "http", address: "http://127.0.0.1:5050" },
      now: new Date("2026-01-01T00:00:10.000Z"),
    });
    assert.equal(second.status, "acquired");
    if (second.status !== "acquired") throw new Error("second lock should be acquired");

    await assert.rejects(
      () => first.lock.heartbeat(new Date("2026-01-01T00:00:30.000Z")),
      "daemon_lock_lost",
    );
    assert.equal((await readDaemonLock(lockPath))?.ownerId, "owner-b");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon lock reports stale owners without stealing by default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-stale-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    const lockPath = daemonLockPath(root, workflowPath);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerId: "owner-a",
        pid: 101,
        hostname: "host-a",
        startedAt: "2026-01-01T00:00:00.000Z",
        workflowPath,
        workspaceRoot: root,
        endpoint: { kind: "socket", address: "/tmp/lorenz.sock" },
        heartbeatAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );

    const record = await readDaemonLock(lockPath);
    assert.ok(record);
    assert.equal(daemonLockIsStale(record!, new Date("2026-01-01T00:02:00.000Z"), 60_000), true);

    const result = await acquireDaemonLock({
      lockPath,
      identity: createDaemonIdentity({
        workflowPath,
        workspaceRoot: root,
        ownerId: "owner-b",
        now: new Date("2026-01-01T00:02:00.000Z"),
      }),
      endpoint: { kind: "socket", address: "/tmp/other.sock" },
      now: new Date("2026-01-01T00:02:00.000Z"),
      staleAfterMs: 60_000,
    });

    assert.equal(result.status, "conflict");
    if (result.status !== "conflict") throw new Error("stale owner should still conflict");
    assert.equal(result.stale, true);
    assert.equal((await readDaemonLock(lockPath))?.ownerId, "owner-a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon lock treats unreadable contents as a stale conflict", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-malformed-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    const lockPath = daemonLockPath(root, workflowPath);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "", "utf8");
    assert.equal(await readDaemonLock(lockPath), null);

    await writeFile(lockPath, "null", "utf8");
    assert.equal(await readDaemonLock(lockPath), null);

    const result = await acquireDaemonLock({
      lockPath,
      identity: createDaemonIdentity({
        workflowPath,
        workspaceRoot: root,
        ownerId: "owner-b",
        now: new Date("2026-01-01T00:02:00.000Z"),
      }),
      endpoint: { kind: "socket", address: "/tmp/other.sock" },
      now: new Date("2026-01-01T00:02:00.000Z"),
      staleAfterMs: 60_000,
    });

    assert.equal(result.status, "conflict");
    if (result.status !== "conflict") throw new Error("malformed owner should still conflict");
    assert.equal(result.record, null);
    assert.equal(result.stale, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon lock removes a just-created file when initial write fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-write-failure-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    const lockPath = daemonLockPath(root, workflowPath);
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      if (String(file) !== lockPath) return handle;
      const failingHandle = Object.create(handle) as typeof handle;
      failingHandle.writeFile = async () => {
        throw new Error("synthetic_write_failure");
      };
      failingHandle.close = handle.close.bind(handle);
      return failingHandle;
    });

    try {
      await assert.rejects(
        () =>
          acquireDaemonLock({
            lockPath,
            identity: createDaemonIdentity({
              workflowPath,
              workspaceRoot: root,
              ownerId: "owner-a",
              now: new Date("2026-01-01T00:00:00.000Z"),
            }),
            endpoint: { kind: "socket", address: "/tmp/lorenz.sock" },
            now: new Date("2026-01-01T00:00:00.000Z"),
          }),
        "synthetic_write_failure",
      );
    } finally {
      openSpy.mockRestore();
    }

    await assert.rejects(() => readFile(lockPath, "utf8"), "ENOENT");

    const result = await acquireDaemonLock({
      lockPath,
      identity: createDaemonIdentity({
        workflowPath,
        workspaceRoot: root,
        ownerId: "owner-b",
        now: new Date("2026-01-01T00:00:01.000Z"),
      }),
      endpoint: { kind: "socket", address: "/tmp/other.sock" },
      now: new Date("2026-01-01T00:00:01.000Z"),
    });
    assert.equal(result.status, "acquired");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon lock recovers a stale mutation guard", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-stale-mutation-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    const lockPath = daemonLockPath(root, workflowPath);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      `${lockPath}.mutation`,
      JSON.stringify({
        token: "stale-token",
        pid: 101,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf8",
    );

    const result = await acquireDaemonLock({
      lockPath,
      identity: createDaemonIdentity({
        workflowPath,
        workspaceRoot: root,
        ownerId: "owner-a",
        now: new Date("2026-01-01T00:02:00.000Z"),
      }),
      endpoint: { kind: "socket", address: "/tmp/lorenz.sock" },
      now: new Date("2026-01-01T00:02:00.000Z"),
    });

    assert.equal(result.status, "acquired");
    const record = await readDaemonLock(lockPath);
    assert.equal(record?.ownerId, "owner-a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon lock path uses a fixed-size workflow key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-long-path-"));
  try {
    const workflowPath = path.join(
      root,
      "very",
      "deep",
      "workspace",
      "segments".repeat(40),
      "WORKFLOW.md",
    );
    const lockPath = daemonLockPath(root, workflowPath);

    assert.equal(path.basename(path.dirname(lockPath)), "daemon");
    assert.equal(path.basename(path.dirname(path.dirname(lockPath))), ".lorenz");
    assert.match(path.basename(lockPath), /^[a-f0-9]{64}\.lock\.json$/);
    assert.ok(path.basename(lockPath).length < 255);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon lock path canonicalizes symlinked workflow aliases", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-symlink-"));
  try {
    const workspaceRoot = path.join(root, "workspace");
    const workspaceAlias = path.join(root, "workspace-link");
    await mkdir(workspaceRoot);
    await symlink(workspaceRoot, workspaceAlias, "dir");
    const workflowPath = path.join(workspaceRoot, "WORKFLOW.md");
    const workflowAlias = path.join(workspaceAlias, "WORKFLOW.md");
    await writeFile(workflowPath, "workflow", "utf8");

    assert.equal(
      daemonLockPath(workspaceRoot, workflowPath),
      daemonLockPath(workspaceAlias, workflowAlias),
    );

    const canonicalIdentity = createDaemonIdentity({ workspaceRoot, workflowPath });
    const aliasIdentity = createDaemonIdentity({
      workspaceRoot: workspaceAlias,
      workflowPath: workflowAlias,
    });
    assert.equal(aliasIdentity.workflowPath, canonicalIdentity.workflowPath);
    assert.equal(aliasIdentity.workspaceRoot, canonicalIdentity.workspaceRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon status payload exposes endpoint and heartbeat age", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-status-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    const lockPath = daemonLockPath(root, workflowPath);
    const acquired = await acquireDaemonLock({
      lockPath,
      identity: createDaemonIdentity({
        workflowPath,
        workspaceRoot: root,
        ownerId: "owner-a",
        pid: 101,
        hostname: "host-a",
        now: new Date("2026-01-01T00:00:00.000Z"),
      }),
      endpoint: { kind: "socket", address: "/tmp/lorenz.sock" },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") throw new Error("lock should be acquired");

    const snapshot = acquired.lock.snapshot();
    assert.deepEqual(daemonStatusPayload(snapshot, new Date("2026-01-01T00:00:30.000Z"), 60_000), {
      owner_id: "owner-a",
      pid: 101,
      hostname: "host-a",
      started_at: "2026-01-01T00:00:00.000Z",
      workflow_path: snapshot.workflowPath,
      workspace_root: snapshot.workspaceRoot,
      lock_path: lockPath,
      endpoint: { kind: "socket", address: "/tmp/lorenz.sock" },
      heartbeat_at: "2026-01-01T00:00:00.000Z",
      heartbeat_age_ms: 30_000,
      stale: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon status payload encodes malformed heartbeat age as null", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lorenz-daemon-status-malformed-"));
  try {
    const workflowPath = path.join(root, "WORKFLOW.md");
    const lockPath = daemonLockPath(root, workflowPath);
    const acquired = await acquireDaemonLock({
      lockPath,
      identity: createDaemonIdentity({
        workflowPath,
        workspaceRoot: root,
        ownerId: "owner-a",
        pid: 101,
        hostname: "host-a",
        now: new Date("2026-01-01T00:00:00.000Z"),
      }),
      endpoint: { kind: "socket", address: "/tmp/lorenz.sock" },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") throw new Error("lock should be acquired");

    const payload = daemonStatusPayload(
      { ...acquired.lock.snapshot(), heartbeatAt: "not-a-date" },
      new Date("2026-01-01T00:00:30.000Z"),
      60_000,
    );

    assert.equal(payload.heartbeat_age_ms, null);
    assert.equal(payload.stale, true);
    assert.match(JSON.stringify(payload), /"heartbeat_age_ms":null/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
