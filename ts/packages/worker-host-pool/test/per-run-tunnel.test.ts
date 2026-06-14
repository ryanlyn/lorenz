import EventEmitter from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { beforeEach, test, vi } from "vitest";
import { startReverseTunnel } from "@symphony/ssh";
import { assert } from "@symphony/test-utils";

import { WorkerHostPool } from "@symphony/worker-host-pool";

vi.mock("@symphony/ssh", () => ({
  startReverseTunnel: vi.fn(),
  // The pool awaits remote-port readiness before returning a lease; the fake
  // resolves immediately so these tests exercise allocation and lifecycle,
  // not the readiness probe.
  waitForRemoteTcpPort: vi.fn(async () => {}),
}));

const mockStartReverseTunnel = vi.mocked(startReverseTunnel);

interface FakeProcess extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeProcess(processes: FakeProcess[]): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter() as FakeProcess;
  // Port recycling is deferred until the ssh child actually ends, so the fake
  // child ends (emits close) as soon as it is killed.
  emitter.kill = vi.fn(() => {
    emitter.emit("close", null, "SIGTERM");
    return true;
  });
  (emitter as unknown as Record<string, unknown>).pid = 12345;
  processes.push(emitter);
  return emitter as unknown as ChildProcessWithoutNullStreams;
}

beforeEach(() => {
  mockStartReverseTunnel.mockReset();
});

test("openForRun gives two runs on one host DISTINCT remote ports", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = new WorkerHostPool();

  const a = await pool.openForRun("worker-1", "0", "127.0.0.1", 3000);
  const b = await pool.openForRun("worker-1", "1", "127.0.0.1", 3000);

  assert.equal(a.workerHost, "worker-1");
  assert.equal(b.workerHost, "worker-1");
  assert.ok(a.remotePort !== b.remotePort);
  assert.equal(a.remotePort, 46_000);
  assert.equal(b.remotePort, 46_001);
  // Two distinct tunnel processes — NOT host-coalesced.
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
});

test("openForRun is per-run keyed: re-opening the SAME run reuses its entry", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = new WorkerHostPool();

  const a1 = await pool.openForRun("worker-1", "0", "127.0.0.1", 3000);
  const a2 = await pool.openForRun("worker-1", "0", "127.0.0.1", 3000);

  assert.equal(a1.remotePort, a2.remotePort);
  // Same run + same local endpoint reuses the single tunnel.
  assert.equal(mockStartReverseTunnel.mock.calls.length, 1);
});

test("closeForRun(A) leaves run B alive on the same host", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = new WorkerHostPool();

  await pool.openForRun("worker-1", "A", "127.0.0.1", 3000);
  const b = await pool.openForRun("worker-1", "B", "127.0.0.1", 3000);

  pool.closeForRun("worker-1", "A");

  // Run A's process was killed; run B's process untouched.
  assert.equal(processes[0]!.kill.mock.calls.length, 1);
  assert.equal(processes[1]!.kill.mock.calls.length, 0);

  // Re-opening run B reuses its still-alive entry (no new process).
  const b2 = await pool.openForRun("worker-1", "B", "127.0.0.1", 3000);
  assert.equal(b2.remotePort, b.remotePort);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
});

test("a localPort change for run A never replaces run B's per-run entry", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = new WorkerHostPool();

  const a = await pool.openForRun("worker-1", "A", "127.0.0.1", 3000);
  const b = await pool.openForRun("worker-1", "B", "127.0.0.1", 3000);

  // Run A's local endpoint changes (e.g. on reload) — replaces ONLY A's entry.
  const a2 = await pool.openForRun("worker-1", "A", "127.0.0.1", 4000);

  // A's old process killed; B's process untouched by A's change.
  assert.equal(processes[0]!.kill.mock.calls.length, 1);
  assert.equal(processes[1]!.kill.mock.calls.length, 0);

  // Run B still holds its OWN distinct port and entry.
  const bStill = await pool.openForRun("worker-1", "B", "127.0.0.1", 3000);
  assert.equal(bStill.remotePort, b.remotePort);
  assert.ok(a2.remotePort !== b.remotePort);
  // A's recycled port (46000) was reused for A's replacement, NOT B's.
  assert.equal(a2.remotePort, a.remotePort);
  // No new process for B's re-open.
  assert.equal(mockStartReverseTunnel.mock.calls.length, 3);
});

test("recycled port is not reused while a live entry holds it (N concurrent ports)", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = new WorkerHostPool();

  const a = await pool.openForRun("worker-1", "A", "127.0.0.1", 3000); // 46000
  const b = await pool.openForRun("worker-1", "B", "127.0.0.1", 3000); // 46001
  const c = await pool.openForRun("worker-1", "C", "127.0.0.1", 3000); // 46002
  assert.equal(a.remotePort, 46_000);
  assert.equal(b.remotePort, 46_001);
  assert.equal(c.remotePort, 46_002);

  // Free the middle port; A and C remain live holding 46000 and 46002.
  pool.closeForRun("worker-1", "B");

  // A new run reuses the recycled middle port — and crucially never collides
  // with the still-live A/C ports.
  const d = await pool.openForRun("worker-1", "D", "127.0.0.1", 3000);
  assert.equal(d.remotePort, 46_001);
  assert.ok(d.remotePort !== a.remotePort);
  assert.ok(d.remotePort !== c.remotePort);

  // The next fresh run advances past the high-water mark, never re-using a
  // live port while its entry is held.
  const e = await pool.openForRun("worker-1", "E", "127.0.0.1", 3000);
  assert.equal(e.remotePort, 46_003);
});

test("closeForRun is a no-op for an unknown run key", () => {
  const pool = new WorkerHostPool();
  pool.closeForRun("worker-1", "missing");
  pool.closeForRun("", "");
});

test("two DIFFERENT issues at slotIndex 0 on the SAME host get DISTINCT per-run tunnels (issue-scoped runKey)", async () => {
  // Codex HIGH #2: the coordinator runKey is ISSUE-SCOPED (`${issueId}#${slotIndex}`)
  // so two DIFFERENT issues co-residing at slotIndex 0 on ONE host never collide on
  // the `${workerHost}#${runKey}` tunnel key. With a bare `${slotIndex}` runKey both
  // would key to "worker-1#0" and SHARE one tunnel/remote port (broken isolation);
  // with the issue-scoped key they get distinct entries and distinct remote ports.
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = new WorkerHostPool();

  const a = await pool.openForRun("worker-1", "issue-a#0", "127.0.0.1", 3000);
  const b = await pool.openForRun("worker-1", "issue-b#0", "127.0.0.1", 3000);

  // Distinct per-run tunnels: two ssh children, two distinct remote ports.
  assert.ok(a.remotePort !== b.remotePort);
  assert.equal(a.remotePort, 46_000);
  assert.equal(b.remotePort, 46_001);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);

  // A same-key reopen / localPort change for issue-a NEVER affects issue-b's entry:
  // only issue-a's process is replaced; issue-b keeps its own port and process.
  const a2 = await pool.openForRun("worker-1", "issue-a#0", "127.0.0.1", 4000);
  assert.equal(processes[0]!.kill.mock.calls.length, 1); // issue-a's old child killed
  assert.equal(processes[1]!.kill.mock.calls.length, 0); // issue-b untouched

  const bStill = await pool.openForRun("worker-1", "issue-b#0", "127.0.0.1", 3000);
  assert.equal(bStill.remotePort, b.remotePort); // issue-b still holds its own port
  assert.equal(a2.remotePort, a.remotePort); // issue-a reused its OWN recycled port
  assert.ok(a2.remotePort !== b.remotePort);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 3); // no new child for b's re-open
});

test("per-run and host-keyed tunnels coexist without colliding ports", async () => {
  const processes: FakeProcess[] = [];
  mockStartReverseTunnel.mockImplementation(() => makeFakeProcess(processes));
  const pool = new WorkerHostPool();

  const host = await pool.acquireRemoteMcpTunnel("worker-1", "127.0.0.1", 3000);
  const run = await pool.openForRun("worker-1", "R", "127.0.0.1", 3000);

  assert.ok(host.remotePort !== run.remotePort);
  assert.equal(host.remotePort, 46_000);
  assert.equal(run.remotePort, 46_001);
  assert.equal(mockStartReverseTunnel.mock.calls.length, 2);
});
