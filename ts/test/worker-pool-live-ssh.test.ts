import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { assert, sampleIssue, tempDir } from "@symphony/test-utils";
import { test, vi } from "vitest";
import { systemClock, withDerivedMaxInFlight } from "@symphony/domain";
import type { WorkerDriverKind, WorkerPoolSettings } from "@symphony/domain";
import { createWorkspaceForIssue, parseConfig, runSsh, shellEscape } from "@symphony/cli";
import type { Issue } from "@symphony/cli";

// The pool engine barrel has NO side effects (no driver is registered on import);
// this test registers its OWN live-SSH driver - one that talks to a real loopback
// sshd - into a LOCAL `WorkerDriverRegistry` threaded to `createWorkerPool` via
// `deps.drivers`, exercising the REAL pool (acquire/lease/release/fail/drain/
// snapshot/affinity) and the REAL runner workspace-over-SSH path. The engine and
// SDK packages are not root dependencies, so they are reached through their
// compiled barrels by relative path - the same pattern the package's own
// root-relative `test/assert.js` import uses.
import {
  WorkerDriverRegistry,
  createWorkerPool,
  type WorkerDescriptor,
  type WorkerDriver,
  type WorkerHealth,
  type WorkerLease,
  type WorkerPool,
  type DriverDeps,
  type TeardownReason,
} from "../packages/worker-pool/dist/index.js";
import type { DriverCapabilities, ProvisionRequest } from "../packages/worker-sdk/dist/index.js";

const execFileAsync = promisify(execFile);
const runLiveSsh = process.env.SYMPHONY_TS_RUN_LIVE_SSH_E2E === "1";

// The kind the live adapter registers under in this test's LOCAL registry. The
// name mirrors the SSH-addressable extension kind; the driver itself declares
// `sshAddressable: true`, so the pool treats the yielded `workerHost` as a real
// SSH target.
const LIVE_KIND: WorkerDriverKind = "static-ssh";
const SSH_TIMEOUT_MS = 60_000;

test(
  "live SSH worker pool: acquire over loopback sshd, runner workspace, fail recycle, retry affinity, drain",
  { timeout: 900_000, skip: !runLiveSsh },
  async (t) => {
    const setup = await setupWorkers();
    if (setup.status === "skip") {
      t.skip(setup.reason);
      return;
    }

    const recorder = new LiveSshDriverRecorder(setup.hosts);
    const drivers = new WorkerDriverRegistry();
    drivers.register({
      kind: LIVE_KIND,
      create: (options, deps) => recorder.create(options, deps, setup.runRoot),
    });

    const settings = parseConfig({
      workspace: { root: setup.workspaceRoot },
      worker: { ssh_hosts: setup.hosts, ssh_timeout_ms: SSH_TIMEOUT_MS },
      hooks: { after_create: initWorkspaceHook(), timeout_ms: 60_000 },
    });

    const pool = createWorkerPool(poolSettings({ driver: LIVE_KIND, max: 1, warm: 0 }), {
      clock: systemClock,
      logEvent: () => undefined,
      drivers,
    });

    const issue: Issue = {
      ...sampleIssue,
      id: "issue-live-worker",
      identifier: "TS-LIVE-WORKER",
      title: "Live SSH worker pool canary",
      state: "Todo",
      stateType: "unstarted",
    };

    try {
      // --- probe via runSsh printf-ready succeeds against the live sshd ---------
      // Drive the registered live driver's probe (the same `printf ready` the
      // pool's reaper health-check uses) directly so the live readiness check is
      // asserted end-to-end against the real sshd.
      const probed = await recorder.probeHost(setup.hosts[0]!);
      assert.deepEqual(probed, { ok: true });

      // --- real acquire over loopback sshd returns a leased worker with a real host -
      const first = await pool.acquire(acquireReq(issue.id, 0));
      assert.equal(first.status, "leased");
      if (first.status !== "leased") return;
      const firstLease = first.lease;
      const firstHost = firstLease.workerHost;
      const firstWorkerId = firstLease.workerId;
      // The host is a REAL SSH destination (a configured loopback worker), not a
      // pool-internal sentinel.
      assert.equal(setup.hosts.includes(firstHost), true);
      // The pool actually provisioned the worker over real SSH (a marker dir exists).
      assert.equal(recorder.provisionedWorkerIds.includes(firstWorkerId), true);
      assert.equal(pool.snapshot().total, 1);
      assert.equal(pool.snapshot().leased, 1);

      // --- the RUNNER (not the pool) creates the workspace over SSH -------------
      // The pool never touches workspaces; the caller threads the leased host into
      // createWorkspaceForIssue, which mkdirs + runs after_create over SSH.
      assert.equal(recorder.workspaceMkdirs.length, 0);
      const workspace = await createWorkspaceForIssue(settings, issue, { workerHost: firstHost });
      assert.equal(await remoteDirExists(firstHost, workspace), true);
      // README.md proves the runner's after_create hook ran in the remote workspace.
      assert.equal(
        await remoteFileContents(firstHost, path.posix.join(workspace, "README.md")),
        "# live worker\n",
      );

      // --- run executes and lease.release returns the worker ----------------------
      const marker = `TS_LIVE_WORKER_${Date.now()}`;
      const markerPath = path.posix.join(workspace, "RUN.txt");
      const writeRun = await runSsh(
        firstHost,
        `printf ${shellEscape(`${marker}\n`)} > ${shellEscape(markerPath)}`,
        { timeoutMs: SSH_TIMEOUT_MS, stderrToStdout: true },
      );
      assert.equal(writeRun.status, 0);
      await firstLease.release("healthy");
      // Released healthy: the worker returns to the warm pool, nothing destroyed.
      const afterRelease = pool.snapshot();
      assert.equal(afterRelease.total, 1);
      assert.equal(afterRelease.warmIdle, 1);
      assert.equal(afterRelease.leased, 0);
      assert.equal(recorder.destroyedWorkerIds.includes(firstWorkerId), false);

      // --- retry re-leases the SAME workerId; resume state preserved (affinity not vacuous)
      // The retry threads the prior host as the affinity key. It must be a REAL,
      // non-null host (not a vacuous null) AND must re-land on the same worker so the
      // remote resume state written above is still present.
      assert.ok(firstHost);
      assert.notEqual(firstHost, "");
      const retry = await pool.acquire(acquireReq(issue.id, 0, firstHost));
      assert.equal(retry.status, "leased");
      if (retry.status !== "leased") return;
      assert.equal(retry.lease.workerId, firstWorkerId);
      assert.equal(retry.lease.workerHost, firstHost);
      // Resume continuity: the file written in the first lease survives on the worker.
      assert.equal(await remoteFileContents(retry.lease.workerHost, markerPath), `${marker}\n`);

      // --- lease.fail force-recycles a poisoned worker ----------------------------
      const recycledWorkerId = retry.lease.workerId;
      await retry.lease.fail("simulated_worker_transport_fault");
      // The poisoned worker is destroyed (real SSH teardown) and dropped from inventory.
      assert.equal(recorder.destroyedWorkerIds.includes(recycledWorkerId), true);
      assert.equal(recorder.destroyReasons.includes("failed"), true);
      const afterFail = pool.snapshot();
      assert.equal(afterFail.total, 0);
      // A fresh acquire provisions a NEW worker (the poisoned id is gone).
      const fresh = await pool.acquire(acquireReq(issue.id, 0));
      assert.equal(fresh.status, "leased");
      if (fresh.status !== "leased") return;
      assert.notEqual(fresh.lease.workerId, recycledWorkerId);

      // --- drain force-destroys remaining workers (no leak) ----------------------
      // Drain after settling the in-flight lease; every worker the pool still owns
      // must be torn down over SSH so no paid/remote worker leaks.
      const leakedWorkerId = fresh.lease.workerId;
      await fresh.lease.release("healthy");
      await pool.drain({ deadlineMs: 30_000 });
      const drained = pool.snapshot();
      assert.equal(drained.total, 0);
      assert.equal(recorder.destroyedWorkerIds.includes(leakedWorkerId), true);
      // Every worker the recorder ever provisioned has a matching teardown (no leak).
      for (const workerId of recorder.provisionedWorkerIds) {
        assert.equal(recorder.destroyedWorkerIds.includes(workerId), true);
      }
    } finally {
      await pool.drain({ deadlineMs: 30_000 }).catch(() => undefined);
      await setup.cleanup();
    }
  },
);

test(
  "live SSH worker pool: multi-worker across real hosts, per-worker isolation, sticky re-acquire across retry",
  { timeout: 900_000, skip: !(runLiveSsh && multiHostsConfigured()) },
  async (t) => {
    const setup = await setupWorkers();
    if (setup.status === "skip") {
      t.skip(setup.reason);
      return;
    }
    if (setup.hosts.length < 2) {
      t.skip("multi-worker case requires SYMPHONY_LIVE_SSH_WORKER_HOSTS with >1 host");
      await setup.cleanup();
      return;
    }

    const recorder = new LiveSshDriverRecorder(setup.hosts);
    const drivers = new WorkerDriverRegistry();
    drivers.register({
      kind: LIVE_KIND,
      create: (options, deps) => recorder.create(options, deps, setup.runRoot),
    });

    const settings = parseConfig({
      workspace: { root: setup.workspaceRoot },
      worker: { ssh_hosts: setup.hosts, ssh_timeout_ms: SSH_TIMEOUT_MS },
      hooks: { after_create: initWorkspaceHook(), timeout_ms: 60_000 },
    });

    const pool = createWorkerPool(
      poolSettings({ driver: LIVE_KIND, max: setup.hosts.length, warm: 0, maxInFlight: 1 }),
      { clock: systemClock, logEvent: () => undefined, drivers },
    );

    try {
      // --- multi-worker allocation across >1 real host ----------------------------
      const leaseA = await acquireLeased(pool, "issue-a", 0);
      const leaseB = await acquireLeased(pool, "issue-b", 0);
      assert.equal(pool.snapshot().total, setup.hosts.length);
      // Distinct workers landed on distinct real hosts.
      assert.notEqual(leaseA.workerId, leaseB.workerId);
      assert.notEqual(leaseA.workerHost, leaseB.workerHost);
      assert.equal(setup.hosts.includes(leaseA.workerHost), true);
      assert.equal(setup.hosts.includes(leaseB.workerHost), true);

      // --- per-worker workspace isolation on distinct hosts -----------------------
      const issueA: Issue = {
        ...sampleIssue,
        id: "issue-a",
        identifier: "TS-LIVE-A",
        state: "Todo",
        stateType: "unstarted",
      };
      const issueB: Issue = {
        ...sampleIssue,
        id: "issue-b",
        identifier: "TS-LIVE-B",
        state: "Todo",
        stateType: "unstarted",
      };
      const wsA = await createWorkspaceForIssue(settings, issueA, {
        workerHost: leaseA.workerHost,
      });
      const wsB = await createWorkspaceForIssue(settings, issueB, {
        workerHost: leaseB.workerHost,
      });
      const tokenA = `TS_ISO_A_${Date.now()}`;
      await writeRemote(leaseA.workerHost, path.posix.join(wsA, "ISO.txt"), `${tokenA}\n`);
      // Host B has no ISO.txt (different machine + different workspace path): isolated.
      assert.equal(
        await remoteDirExists(leaseB.workerHost, path.posix.join(wsB, "ISO.txt")),
        false,
      );
      assert.equal(
        await remoteFileContents(leaseA.workerHost, path.posix.join(wsA, "ISO.txt")),
        `${tokenA}\n`,
      );

      // --- sticky re-acquire returns the same host across a retry ---------------
      await leaseA.release("healthy");
      const retryA = await acquireLeased(pool, "issue-a", 0, leaseA.workerHost);
      assert.equal(retryA.workerId, leaseA.workerId);
      assert.equal(retryA.workerHost, leaseA.workerHost);

      // --- resume continuity preserved when same workerId re-acquired -------------
      assert.equal(
        await remoteFileContents(retryA.workerHost, path.posix.join(wsA, "ISO.txt")),
        `${tokenA}\n`,
      );

      await retryA.release("healthy");
      await leaseB.release("healthy");
    } finally {
      await pool.drain({ deadlineMs: 30_000 }).catch(() => undefined);
      // Every provisioned worker must be torn down on drain (no leak across hosts).
      for (const workerId of recorder.provisionedWorkerIds) {
        assert.equal(recorder.destroyedWorkerIds.includes(workerId), true);
      }
      await setup.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Live-SSH driver adapter: a real WorkerDriver over the configured loopback /
// BYO hosts. It maps the pool's `worker-N` idempotency key onto a real SSH host
// (round-robin, affinity-aware), probes with `printf ready`, and tears down each
// worker with a real `rm -rf` over SSH so drain/fail teardown is observable.
// ---------------------------------------------------------------------------

const CAPABILITIES: DriverCapabilities = {
  sshAddressable: true,
  ephemeral: true,
  usesLedger: false,
};

class LiveSshDriverRecorder {
  readonly provisionedWorkerIds: string[] = [];
  readonly destroyedWorkerIds: string[] = [];
  readonly destroyReasons: string[] = [];
  readonly probeHosts: string[] = [];
  readonly workspaceMkdirs: string[] = [];
  // workerId -> the host it is bound to, so destroy targets the same machine.
  private readonly bound = new Map<string, string>();
  // Hosts currently occupied by a live worker (so a second worker lands on a fresh host).
  private readonly occupied = new Set<string>();

  constructor(private readonly hosts: readonly string[]) {}

  // The same readiness check the driver's `probe` performs, exposed so the test
  // can assert the live `printf ready` probe end-to-end against the real sshd.
  async probeHost(host: string): Promise<WorkerHealth> {
    this.probeHosts.push(host);
    try {
      const result = await runSsh(host, "printf ready", {
        timeoutMs: SSH_TIMEOUT_MS,
        stderrToStdout: true,
      });
      if (result.status !== 0 || result.stdout !== "ready")
        return { ok: false, reason: `live_ssh_probe_exit_${result.status}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // An arrow class field so the returned driver's arrow methods close over the
  // recorder instance via lexical `this` (no `this` aliasing).
  create = (
    _options: Readonly<Record<string, unknown>>,
    deps: DriverDeps,
    runRoot: string,
  ): WorkerDriver => ({
    kind: LIVE_KIND,
    capabilities: CAPABILITIES,
    provision: async (req: ProvisionRequest): Promise<WorkerDescriptor> => {
      const host = this.pickHost(req.workerId, req.affinityKey ?? null);
      this.bound.set(req.workerId, host);
      this.occupied.add(host);
      this.provisionedWorkerIds.push(req.workerId);
      // A real marker dir on the worker, removed by destroy, so a leak is observable.
      const markerDir = path.posix.join(runRoot, "workers", req.workerId);
      const made = await runSsh(host, `mkdir -p ${shellEscape(markerDir)}`, {
        timeoutMs: req.timeoutMs,
        stderrToStdout: true,
      });
      if (made.status !== 0)
        throw new Error(`live_ssh_provision_failed: ${host} ${made.status} ${made.stdout}`);
      return {
        workerId: req.workerId,
        workerHost: host,
        driverRef: `${host}#${req.workerId}`,
        createdAtMs: deps.clock.now().getTime(),
        labels: [...req.labels],
        metadata: { markerDir },
      };
    },
    probe: async (worker: WorkerDescriptor): Promise<WorkerHealth> =>
      this.probeHost(worker.workerHost),
    destroy: async (
      worker: WorkerDescriptor,
      opts: { timeoutMs: number; reason: TeardownReason },
    ): Promise<void> => {
      const host = this.bound.get(worker.workerId) ?? worker.workerHost;
      const markerDir =
        typeof worker.metadata.markerDir === "string"
          ? worker.metadata.markerDir
          : path.posix.join(runRoot, "workers", worker.workerId);
      await runSsh(host, `rm -rf ${shellEscape(markerDir)}`, {
        timeoutMs: opts.timeoutMs,
        stderrToStdout: true,
      }).catch(() => undefined);
      this.destroyedWorkerIds.push(worker.workerId);
      this.destroyReasons.push(opts.reason);
      this.bound.delete(worker.workerId);
      this.occupied.delete(host);
    },
    list: async (): Promise<WorkerDescriptor[]> =>
      [...this.bound.entries()].map(([workerId, host]) => ({
        workerId,
        workerHost: host,
        driverRef: `${host}#${workerId}`,
        createdAtMs: deps.clock.now().getTime(),
        labels: [],
        metadata: { markerDir: path.posix.join(runRoot, "workers", workerId) },
      })),
  });

  // Prefer the affinity host when free; otherwise the first un-occupied host;
  // otherwise fall back to a stable host so a single-host loopback still works.
  private pickHost(workerId: string, affinityKey: string | null): string {
    const existing = this.bound.get(workerId);
    if (existing) return existing;
    if (affinityKey && this.hosts.includes(affinityKey) && !this.occupied.has(affinityKey))
      return affinityKey;
    const free = this.hosts.find((host) => !this.occupied.has(host));
    return free ?? this.hosts[0]!;
  }
}

// ---------------------------------------------------------------------------
// Pool/request helpers.
// ---------------------------------------------------------------------------

function poolSettings(overrides: Partial<WorkerPoolSettings> = {}): WorkerPoolSettings {
  // `slotsPerMachine` is the canonical own field; `maxInFlight` is a derived
  // read-only getter installed by `withDerivedMaxInFlight`. Accept either spelling
  // from a caller's overrides but only ever set `slotsPerMachine`.
  const { maxInFlight, slotsPerMachine, ...rest } = overrides;
  return withDerivedMaxInFlight({
    enabled: true,
    driver: LIVE_KIND,
    min: 0,
    max: 1,
    warm: 0,
    slotsPerMachine: slotsPerMachine ?? maxInFlight ?? 1,
    ttlMs: 3_600_000,
    idleReapMs: 300_000,
    acquireTimeoutMs: 30_000,
    reapIntervalMs: 3_600_000,
    staleHeartbeatMs: 600_000,
    drainDeadlineMs: 30_000,
    ...rest,
  });
}

function acquireReq(issueId: string, slotIndex: number, affinityKey?: string | null) {
  return {
    issueId,
    slotIndex,
    labels: [`symphony.issue=${issueId}`],
    timeoutMs: 60_000,
    ...(affinityKey ? { affinityKey } : {}),
  };
}

async function acquireLeased(
  pool: WorkerPool,
  issueId: string,
  slotIndex: number,
  affinityKey?: string | null,
): Promise<WorkerLease> {
  const result = await pool.acquire(acquireReq(issueId, slotIndex, affinityKey));
  assert.equal(result.status, "leased");
  if (result.status !== "leased") throw new Error(`acquire_failed: ${JSON.stringify(result)}`);
  return result.lease;
}

// ---------------------------------------------------------------------------
// Worker setup: a real native sshd over loopback by default, or BYO hosts when
// SYMPHONY_LIVE_SSH_WORKER_HOSTS is set. Mirrors live-ssh.test.ts so this test
// is collected-but-skipped without SYMPHONY_TS_RUN_LIVE_SSH_E2E=1.
// ---------------------------------------------------------------------------

interface WorkerSetup {
  status: "ok";
  hosts: string[];
  workspaceRoot: string;
  runRoot: string;
  runId: string;
  cleanup(): Promise<void>;
}

type WorkerSetupResult = WorkerSetup | { status: "skip"; reason: string };

function multiHostsConfigured(): boolean {
  return configuredHosts().length > 1;
}

function configuredHosts(): string[] {
  return (process.env.SYMPHONY_LIVE_SSH_WORKER_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

async function setupWorkers(): Promise<WorkerSetupResult> {
  const runId = `symphony-ts-worker-live-ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const byo = configuredHosts();
  if (byo.length > 0) {
    const runRoot = `~/.${runId}`;
    return {
      status: "ok",
      hosts: byo,
      workspaceRoot: `${runRoot}/workspaces`,
      runRoot,
      runId,
      cleanup: async () => {
        await cleanupRemoteRoot(byo, runRoot);
      },
    };
  }

  const native = await setupNativeSshdWorker(runId).catch(() => null);
  if (native) return native;

  return {
    status: "skip",
    reason: "local sshd is unavailable and SYMPHONY_LIVE_SSH_WORKER_HOSTS is unset",
  };
}

// Replicated from live-ssh.test.ts (~line 195): a throwaway native sshd on
// loopback authorized with a generated keypair, wired via SYMPHONY_SSH_CONFIG so
// runSsh(host, ...) resolves the loopback worker.
async function setupNativeSshdWorker(runId: string): Promise<WorkerSetup> {
  if (!(await fileExists("/usr/sbin/sshd"))) throw new Error("local sshd is unavailable");
  if (!(await commandExists("ssh-keygen"))) throw new Error("ssh-keygen is unavailable");

  const root = await tempDir("symphony-ts-worker-live-native-sshd");
  const keyPath = path.join(root, "id_ed25519");
  const hostKeyPath = path.join(root, "ssh_host_ed25519_key");
  const configPath = path.join(root, "sshd_config");
  const clientConfigPath = path.join(root, "ssh_config");
  const authorizedKeysPath = path.join(root, "authorized_keys");
  const logPath = path.join(root, "sshd.log");
  const pidPath = path.join(root, "sshd.pid");
  const port = await reserveTcpPort();
  const host = `localhost:${port}`;
  const runRoot = `~/.${runId}`;
  const previousSshConfig = process.env.SYMPHONY_SSH_CONFIG;
  const user = os.userInfo().username;

  await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKeyPath]);
  await fs.copyFile(`${keyPath}.pub`, authorizedKeysPath);
  await fs.chmod(root, 0o700);
  await fs.chmod(keyPath, 0o600);
  await fs.chmod(authorizedKeysPath, 0o600);
  await fs.writeFile(
    configPath,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${hostKeyPath}`,
      `AuthorizedKeysFile ${authorizedKeysPath}`,
      `PidFile ${pidPath}`,
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "ChallengeResponseAuthentication no",
      "PubkeyAuthentication yes",
      "StrictModes no",
      "UsePAM no",
      "PermitRootLogin no",
      `AllowUsers ${user}`,
      "LogLevel ERROR",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    clientConfigPath,
    [
      "Host localhost 127.0.0.1",
      `  User ${user}`,
      `  IdentityFile ${keyPath}`,
      "  IdentitiesOnly yes",
      "  StrictHostKeyChecking no",
      "  UserKnownHostsFile /dev/null",
      "  LogLevel ERROR",
      "",
    ].join("\n"),
  );

  await execFileAsync("/usr/sbin/sshd", ["-t", "-f", configPath]);
  await execFileAsync("/usr/sbin/sshd", ["-f", configPath, "-E", logPath]);
  process.env.SYMPHONY_SSH_CONFIG = clientConfigPath;

  const cleanup = async () => {
    if (previousSshConfig === undefined) delete process.env.SYMPHONY_SSH_CONFIG;
    else process.env.SYMPHONY_SSH_CONFIG = previousSshConfig;
    await cleanupRemoteRoot([host], runRoot);
    const pid = await fs.readFile(pidPath, "utf8").catch(() => "");
    if (pid.trim()) {
      try {
        process.kill(Number(pid.trim()), "SIGTERM");
      } catch {
        // best effort
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  };

  try {
    await waitForSshHosts([host]);
  } catch (error) {
    await cleanup();
    const log = await fs.readFile(logPath, "utf8").catch(() => "");
    throw new Error(
      `native_sshd_unavailable: ${error instanceof Error ? error.message : String(error)} ${log}`,
      { cause: error },
    );
  }

  return {
    status: "ok",
    hosts: [host],
    workspaceRoot: `${runRoot}/workspaces`,
    runRoot,
    runId,
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// Remote helpers.
// ---------------------------------------------------------------------------

function initWorkspaceHook(): string {
  return "printf '# live worker\\n' > README.md";
}

async function remoteDirExists(host: string, remotePath: string): Promise<boolean> {
  const result = await runSsh(
    host,
    `test -e ${shellEscape(remotePath)} && printf yes || printf no`,
    { timeoutMs: SSH_TIMEOUT_MS, stderrToStdout: true },
  );
  return result.status === 0 && result.stdout === "yes";
}

async function remoteFileContents(host: string, remotePath: string): Promise<string> {
  const result = await runSsh(host, `cat ${shellEscape(remotePath)}`, {
    timeoutMs: SSH_TIMEOUT_MS,
    stderrToStdout: true,
  });
  assert.equal(result.status, 0);
  return result.stdout;
}

async function writeRemote(host: string, remotePath: string, contents: string): Promise<void> {
  const result = await runSsh(
    host,
    `printf ${shellEscape(contents)} > ${shellEscape(remotePath)}`,
    { timeoutMs: SSH_TIMEOUT_MS, stderrToStdout: true },
  );
  assert.equal(result.status, 0);
}

async function waitForSshHosts(hosts: string[]): Promise<void> {
  for (const host of hosts) {
    await vi.waitFor(
      async () => {
        const result = await runSsh(host, "printf ready", {
          timeoutMs: 5_000,
          stderrToStdout: true,
        }).catch(() => null);
        if (result?.status !== 0 || result.stdout !== "ready")
          throw new Error(`SSH worker ${host} not ready`);
      },
      { timeout: 60_000, interval: 1_000 },
    );
  }
}

async function cleanupRemoteRoot(hosts: string[], remoteRoot: string): Promise<void> {
  await Promise.all(
    hosts.map((host) =>
      runSsh(host, `rm -rf ${shellEscape(remoteRoot)}`, {
        timeoutMs: 30_000,
        stderrToStdout: true,
      }).catch(() => undefined),
    ),
  );
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("sh", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function reserveTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error("failed to reserve tcp port"));
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}
