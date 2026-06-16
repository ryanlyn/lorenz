import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, test } from "vitest";
import { WorkerDriverRegistry, POOL_OWNED_LABEL } from "@lorenz/worker-sdk";
import type { DriverDeps, ProvisionRequest, SshRunOptions, SshRunResult } from "@lorenz/worker-sdk";
import { runDriverConformanceSuite } from "@lorenz/worker-sdk/conformance";
import { assert, writeExecutable } from "@lorenz/test-utils";

import {
  DockerWorkerDriver,
  dockerWorkerDriverFactory,
  registerDockerWorkerDriver,
  type DockerCommandResult,
  type DockerDriverOverrides,
} from "../src/index.js";

// A deterministic clock so `createdAtMs` is reproducible. The driver owns no
// timers (it shells out to `docker` and delegates the probe to `runSsh`).
function fixedClock(initial: Date): DriverDeps["clock"] {
  return {
    now: () => initial,
    setTimeout: () => ({ unref: undefined }),
    clearTimeout: () => undefined,
  };
}

const okRunSsh: DriverDeps["runSsh"] = async () =>
  Promise.resolve({ stdout: "ready\n", stderr: "", status: 0 });

function makeDeps(runSsh: DriverDeps["runSsh"] = okRunSsh): DriverDeps {
  return {
    clock: fixedClock(new Date("2026-05-29T10:00:00.000Z")),
    logEvent: () => undefined,
    runSsh,
  };
}

const IMAGE = "ghcr.io/org/worker:latest";

const LABEL_POOL = "lorenz.worker-pool";
const LABEL_ID = "lorenz.worker-id";

// ---------------------------------------------------------------------------
// A scripted fake `docker` CLI seam. It records every argv it is handed and
// returns canned results keyed on the subcommand, modeling a tiny container
// daemon: `run` mints a container id and remembers it under its worker-id label
// and an assigned host port; `port` reports the published port; `rm` removes
// it; `ps` lists the survivors filtered by the pool label.
// ---------------------------------------------------------------------------
interface FakeDocker {
  override: DockerDriverOverrides;
  calls: string[][];
  containers: Map<string, { workerId: string; hostPort: number }>;
}

function fakeDocker(opts: { startPort?: number } = {}): FakeDocker {
  const calls: string[][] = [];
  const containers = new Map<string, { workerId: string; hostPort: number }>();
  let nextId = 1;
  let nextPort = opts.startPort ?? 32_768;

  const runDocker = async (
    args: readonly string[],
    _options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<DockerCommandResult> => {
    calls.push([...args]);
    const sub = args[0];
    if (sub === "run") {
      const workerId = labelValue(args, LABEL_ID);
      const id = `c${nextId++}${"0".repeat(60)}`.slice(0, 64);
      const hostPort = nextPort++;
      containers.set(id, { workerId: workerId ?? "", hostPort });
      return { stdout: `${id}\n`, stderr: "", status: 0 };
    }
    if (sub === "port") {
      const id = args[1] ?? "";
      const c = containers.get(id);
      if (!c) return { stdout: "", stderr: "no such container", status: 1 };
      return { stdout: `0.0.0.0:${c.hostPort}\n[::]:${c.hostPort}\n`, stderr: "", status: 0 };
    }
    if (sub === "rm") {
      const id = args[args.length - 1] ?? "";
      if (!containers.has(id)) {
        // Mirror docker's exit-1 "No such container" so the driver's
        // idempotent destroy must tolerate it.
        return { stdout: "", stderr: `Error: No such container: ${id}`, status: 1 };
      }
      containers.delete(id);
      return { stdout: `${id}\n`, stderr: "", status: 0 };
    }
    if (sub === "ps") {
      const lines = [...containers.entries()].map(
        ([id, c]) => `${id}\t${c.workerId}\t0.0.0.0:${c.hostPort}->22/tcp`,
      );
      return { stdout: lines.length ? `${lines.join("\n")}\n` : "", stderr: "", status: 0 };
    }
    return { stdout: "", stderr: `unexpected docker subcommand: ${sub}`, status: 127 };
  };

  return { override: { runDocker }, calls, containers };
}

// Reads the value of the Nth `--label <key>=<value>` pair for `key`.
function labelValue(args: readonly string[], key: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--label" && args[i + 1]?.startsWith(`${key}=`)) {
      return args[i + 1]!.slice(key.length + 1);
    }
  }
  return undefined;
}

function makeDriver(over?: DockerDriverOverrides): DockerWorkerDriver {
  const fake = fakeDocker();
  return new DockerWorkerDriver({ image: IMAGE }, makeDeps(), {
    ...fake.override,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Conformance suite over the scripted fake docker (always-on, zero network).
// `workerIds` are arbitrary pool idempotency keys; the driver derives the host
// port and the container id from the fake. The unreachable variant forces the
// SSH probe to fail so the worker gates to ok:false.
// ---------------------------------------------------------------------------
runDriverConformanceSuite(
  () => {
    const fake = fakeDocker();
    return new DockerWorkerDriver({ image: IMAGE }, makeDeps(), fake.override);
  },
  {
    suiteName: "DockerWorkerDriver (fake docker CLI)",
    workerIds: ["worker-a", "worker-b"],
    makeProvisionRequest: (workerId): ProvisionRequest => ({
      workerId,
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    }),
    makeUnreachable: () => {
      const fake = fakeDocker();
      const driver = new DockerWorkerDriver(
        { image: IMAGE },
        makeDeps(async () => {
          throw new Error("ssh_timeout: 127.0.0.1 5000");
        }),
        fake.override,
      );
      return { driver, workerId: "worker-down" };
    },
  },
);

describe("DockerWorkerDriver command construction", () => {
  test("provision: docker run -d publishes 22, labels the pool + worker id + image", async () => {
    const fake = fakeDocker({ startPort: 40_000 });
    const driver = new DockerWorkerDriver({ image: IMAGE }, makeDeps(), fake.override);

    const worker = await driver.provision({
      workerId: "worker-a",
      labels: [LABEL_POOL, "ensemble:0"],
      timeoutMs: 30_000,
    });

    // The container id from `docker run` is the driverRef used by destroy/list.
    assert.equal(worker.workerId, "worker-a");
    assert.match(worker.driverRef, /^c1/);

    // workerHost is the published loopback endpoint `user@127.0.0.1:<port>`.
    assert.equal(worker.workerHost, "root@127.0.0.1:40000");

    // Exact `docker run` argv: detached, publish container 22, all labels, image last.
    const runCall = fake.calls.find((c) => c[0] === "run");
    assert.ok(runCall);
    assert.equal(runCall![0], "run");
    assert.equal(runCall!.includes("-d"), true);
    // Publishes a host port mapped to the container's sshd port 22.
    const pubIdx = runCall!.indexOf("-p");
    assert.ok(pubIdx >= 0);
    assert.match(runCall![pubIdx + 1] ?? "", /:22$/);
    // The pool label (so list/reconcile can adopt survivors) and the worker-id label.
    assert.equal(labelValue(runCall!, LABEL_POOL), "");
    assert.equal(labelValue(runCall!, LABEL_ID), "worker-a");
    // Caller-supplied labels are forwarded too.
    assert.ok(runCall!.includes("ensemble:0"));
    // The image (from the `image` driver option) is the final positional argument.
    assert.equal(runCall![runCall!.length - 1], IMAGE);
  });

  test("provision: a custom user from the driver options is used in workerHost", async () => {
    const fake = fakeDocker({ startPort: 50_000 });
    const driver = new DockerWorkerDriver(
      { image: IMAGE, user: "agent" },
      makeDeps(),
      fake.override,
    );
    const worker = await driver.provision({
      workerId: "worker-u",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });
    assert.equal(worker.workerHost, "agent@127.0.0.1:50000");
  });

  test("provision: reads sshUser (camelCase) as well as user", async () => {
    const fake = fakeDocker({ startPort: 50_500 });
    const driver = new DockerWorkerDriver(
      { image: IMAGE, sshUser: "dev" },
      makeDeps(),
      fake.override,
    );
    const worker = await driver.provision({
      workerId: "worker-c",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });
    assert.equal(worker.workerHost, "dev@127.0.0.1:50500");
  });

  test("provision: rejects when the image driver option is missing", async () => {
    const fake = fakeDocker();
    const driver = new DockerWorkerDriver({}, makeDeps(), fake.override);
    await assert.rejects(
      () => driver.provision({ workerId: "worker-a", labels: [LABEL_POOL], timeoutMs: 30_000 }),
      /docker_image_required/,
    );
  });

  test("provision: maps a non-zero `docker run` exit to a thrown driver error", async () => {
    const driver = new DockerWorkerDriver({ image: IMAGE }, makeDeps(), {
      runDocker: async (args) => {
        if (args[0] === "run") return { stdout: "", stderr: "Unable to find image", status: 125 };
        return { stdout: "", stderr: "", status: 0 };
      },
    });
    await assert.rejects(
      () => driver.provision({ workerId: "worker-a", labels: [LABEL_POOL], timeoutMs: 30_000 }),
      /docker_run_failed/,
    );
  });

  test("provision: a post-create `docker port` failure force-removes the container (no leak)", async () => {
    const fake = fakeDocker({ startPort: 41_000 });
    const innerRunDocker = fake.override.runDocker!;
    // `docker run` succeeds (a container now exists on the daemon) but resolving its
    // published port fails. Without cleanup the container would leak: the pool writes
    // no inventory record, so drain/reaper can never see it.
    const driver = new DockerWorkerDriver({ image: IMAGE }, makeDeps(), {
      runDocker: async (args, options) => {
        if (args[0] === "port") return { stdout: "", stderr: "boom", status: 1 };
        return innerRunDocker(args, options);
      },
    });

    await assert.rejects(
      () => driver.provision({ workerId: "worker-leak", labels: [LABEL_POOL], timeoutMs: 30_000 }),
      /docker_port_failed/,
    );

    // The created container was force-removed: the fake daemon holds none...
    assert.equal(fake.containers.size, 0);
    // ...via `docker rm -f <containerId>`.
    const rmCall = fake.calls.find((c) => c[0] === "rm");
    assert.ok(rmCall, "expected a docker rm -f cleanup call");
    assert.equal(rmCall?.includes("-f"), true);
  });

  test("provision is idempotent across instances via the pool label on the live daemon", async () => {
    // Two driver instances share one fake daemon: a second provision of the
    // same workerId must adopt the surviving container (no duplicate `docker run`),
    // because idempotency is keyed on the lorenz.worker-id label, not in-memory.
    const fake = fakeDocker({ startPort: 41_000 });
    const a = new DockerWorkerDriver({ image: IMAGE }, makeDeps(), fake.override);
    const first = await a.provision({
      workerId: "worker-keep",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });

    const b = new DockerWorkerDriver({ image: IMAGE }, makeDeps(), fake.override);
    const second = await b.provision({
      workerId: "worker-keep",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });

    assert.equal(second.workerId, first.workerId);
    assert.equal(second.driverRef, first.driverRef);
    assert.equal(second.workerHost, first.workerHost);

    // Exactly ONE container exists for worker-keep (the second provision adopted it).
    const runCount = fake.calls.filter((c) => c[0] === "run").length;
    assert.equal(runCount, 1);
    const listed = (await b.list()).filter((worker) => worker.workerId === "worker-keep");
    assert.equal(listed.length, 1);
  });
});

describe("DockerWorkerDriver list/destroy/probe", () => {
  test("list: docker ps filters by the pool label and parses the worker-id label + port", async () => {
    const fake = fakeDocker({ startPort: 33_000 });
    const driver = new DockerWorkerDriver({ image: IMAGE }, makeDeps(), fake.override);
    await driver.provision({ workerId: "worker-1", labels: [LABEL_POOL], timeoutMs: 30_000 });
    await driver.provision({ workerId: "worker-2", labels: [LABEL_POOL], timeoutMs: 30_000 });

    const listed = await driver.list();
    const byId = new Map(listed.map((worker) => [worker.workerId, worker]));
    assert.deepEqual([...byId.keys()].sort(), ["worker-1", "worker-2"]);
    // The parsed workerHost carries the published loopback port from `docker ps`.
    assert.equal(byId.get("worker-1")!.workerHost, "root@127.0.0.1:33000");
    assert.equal(byId.get("worker-2")!.workerHost, "root@127.0.0.1:33001");

    // `docker ps` was filtered by the pool label (so unlabeled containers are
    // never adopted) and asked for the worker-id label + ports in its format.
    const psCall = fake.calls.find((c) => c[0] === "ps");
    assert.ok(psCall);
    const filterIdx = psCall!.indexOf("--filter");
    assert.ok(filterIdx >= 0);
    assert.equal(psCall![filterIdx + 1], `label=${LABEL_POOL}`);

    // Every listed descriptor surfaces POOL_OWNED_LABEL so the pool's
    // hydrate/reconcile ownership gate re-adopts (and can later clean up) these
    // survivors. Without it a crash-leaked container is a permanent orphan.
    for (const worker of listed) {
      assert.equal(worker.labels.includes(POOL_OWNED_LABEL), true);
    }
  });

  test("destroy: docker rm -f on the driverRef (container id), idempotent on already-gone", async () => {
    const fake = fakeDocker({ startPort: 34_000 });
    const driver = new DockerWorkerDriver({ image: IMAGE }, makeDeps(), fake.override);
    const worker = await driver.provision({
      workerId: "worker-x",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });

    await driver.destroy(worker, { timeoutMs: 5_000, reason: "shrink" });

    const rmCall = fake.calls.find((c) => c[0] === "rm");
    assert.ok(rmCall);
    assert.equal(rmCall!.includes("-f"), true);
    // The driverRef (container id), NOT the workerId, is what `docker rm` targets.
    assert.equal(rmCall![rmCall!.length - 1], worker.driverRef);

    // The container is gone from the daemon.
    assert.equal(
      (await driver.list()).some((b) => b.workerId === "worker-x"),
      false,
    );

    // A second destroy (now "No such container", exit 1) must NOT throw.
    await driver.destroy(worker, { timeoutMs: 5_000, reason: "shrink" });
  });

  test("destroy: a genuine docker error (not 'no such container') is surfaced", async () => {
    const driver = new DockerWorkerDriver({ image: IMAGE }, makeDeps(), {
      runDocker: async (args) => {
        if (args[0] === "rm")
          return { stdout: "", stderr: "Cannot connect to the Docker daemon", status: 1 };
        return { stdout: "", stderr: "", status: 0 };
      },
    });
    await assert.rejects(
      () =>
        driver.destroy(
          {
            workerId: "worker-a",
            workerHost: "root@127.0.0.1:9999",
            driverRef: "deadbeef",
            createdAtMs: 0,
            labels: [LABEL_POOL],
            metadata: {},
          },
          { timeoutMs: 5_000, reason: "drain" },
        ),
      /docker_rm_failed/,
    );
  });

  test("probe: runs deps.runSsh printf-ready against the published workerHost with opts.timeoutMs", async () => {
    const fake = fakeDocker({ startPort: 35_000 });
    const calls: Array<{ host: string; command: string; options: SshRunOptions }> = [];
    const driver = new DockerWorkerDriver(
      { image: IMAGE },
      makeDeps(async (host, command, options = {}): Promise<SshRunResult> => {
        calls.push({ host, command, options });
        return { stdout: "ready\n", stderr: "", status: 0 };
      }),
      fake.override,
    );
    const worker = await driver.provision({
      workerId: "worker-p",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });

    const health = await driver.probe(worker, { timeoutMs: 7_000 });
    assert.equal(health.ok, true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.host, "root@127.0.0.1:35000");
    assert.equal(calls[0]?.command, "printf ready");
    assert.equal(calls[0]?.options.timeoutMs, 7_000);
  });

  test("probe: a non-zero ssh exit gates the worker to ok:false (does not throw)", async () => {
    const fake = fakeDocker();
    const driver = new DockerWorkerDriver(
      { image: IMAGE },
      makeDeps(async (): Promise<SshRunResult> => ({ stdout: "", stderr: "boom", status: 255 })),
      fake.override,
    );
    const worker = await driver.provision({
      workerId: "worker-p",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });
    const health = await driver.probe(worker, { timeoutMs: 5_000 });
    assert.equal(health.ok, false);
    if (!health.ok) assert.match(health.reason, /255/);
  });

  test("capabilities are { sshAddressable:true, ephemeral:true, usesLedger:true }", () => {
    const driver = makeDriver();
    assert.deepEqual(driver.capabilities, {
      sshAddressable: true,
      ephemeral: true,
      usesLedger: true,
    });
    assert.equal(driver.kind, "docker");
  });

  test("registerDockerWorkerDriver registers the factory idempotently", () => {
    const registry = new WorkerDriverRegistry();
    registerDockerWorkerDriver({ workerDrivers: registry });
    // A second registration is a no-op (the kind is already registered).
    registerDockerWorkerDriver({ workerDrivers: registry });

    const factory = registry.require("docker");
    assert.equal(factory, dockerWorkerDriverFactory);
    assert.equal(factory.create({ image: IMAGE }, makeDeps()).kind, "docker");
  });
});

// ---------------------------------------------------------------------------
// Real code-path integration: a PATH-shimmed fake `docker` binary so the
// driver's default subprocess transport (`execFile`-style) is exercised with
// zero network. This proves the driver actually shells out to `docker`.
// ---------------------------------------------------------------------------
describe("DockerWorkerDriver over a PATH-shimmed fake docker binary", () => {
  let oldPath: string | undefined;
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lorenz-docker-"));
    oldPath = process.env.PATH;
    const bin = path.join(root, "bin");
    const state = path.join(root, "state");
    await fs.mkdir(state, { recursive: true });
    // A tiny POSIX-sh docker: `run` mints an id and a port and records them;
    // `port` echoes the published mapping; `rm` deletes the record; `ps` lists
    // survivors as ID<TAB>worker-id<TAB>ports. It is the same daemon model as the
    // injected fake, but exercised through the driver's REAL subprocess seam.
    await writeExecutable(
      path.join(bin, "docker"),
      `#!/bin/sh
state='${state}'
sub="$1"; shift
case "$sub" in
  run)
    workerid=""
    for a in "$@"; do
      case "$a" in lorenz.worker-id=*) workerid="\${a#lorenz.worker-id=}";; esac
    done
    n=$(ls "$state" | wc -l | tr -d ' ')
    id="c$((n+1))$(printf '%0.sf' 1 2 3 4 5 6 7 8 9)"
    port=$((36000 + n))
    printf '%s\\t%s\\n' "$workerid" "$port" > "$state/$id"
    printf '%s\\n' "$id"
    ;;
  port)
    id="$1"
    if [ -f "$state/$id" ]; then
      port=$(cut -f2 "$state/$id")
      printf '0.0.0.0:%s\\n' "$port"
    else
      echo "no such container" 1>&2; exit 1
    fi
    ;;
  rm)
    id=""
    for a in "$@"; do id="$a"; done
    if [ -f "$state/$id" ]; then rm -f "$state/$id"; printf '%s\\n' "$id";
    else echo "Error: No such container: $id" 1>&2; exit 1; fi
    ;;
  ps)
    for f in "$state"/*; do
      [ -f "$f" ] || continue
      id=$(basename "$f")
      workerid=$(cut -f1 "$f"); port=$(cut -f2 "$f")
      printf '%s\\t%s\\t0.0.0.0:%s->22/tcp\\n' "$id" "$workerid" "$port"
    done
    ;;
  *) echo "unexpected: $sub" 1>&2; exit 127;;
esac
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  });

  afterEach(async () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await fs.rm(root, { recursive: true, force: true });
  });

  test("provision -> list -> destroy round-trips through the real docker subprocess seam", async () => {
    // No runDocker override: the driver uses its default execFile transport,
    // which resolves the PATH-shimmed `docker` and runs the real code path.
    const driver = new DockerWorkerDriver({ image: IMAGE }, makeDeps());

    const worker = await driver.provision({
      workerId: "real-1",
      labels: [LABEL_POOL],
      timeoutMs: 30_000,
    });
    assert.equal(worker.workerId, "real-1");
    assert.match(worker.workerHost, /^root@127\.0\.0\.1:\d+$/);

    const listed = await driver.list();
    assert.equal(
      listed.some((b) => b.workerId === "real-1"),
      true,
    );

    await driver.destroy(worker, { timeoutMs: 5_000, reason: "shrink" });
    assert.equal(
      (await driver.list()).some((b) => b.workerId === "real-1"),
      false,
    );
    // Idempotent destroy through the real seam (now exit-1 "No such container").
    await driver.destroy(worker, { timeoutMs: 5_000, reason: "shrink" });
  });
});

// ---------------------------------------------------------------------------
// Gated live slice: runs the shared conformance suite against the REAL docker
// daemon. Collected-but-skipped unless LORENZ_TS_RUN_LIVE_DOCKER_E2E=1.
// ---------------------------------------------------------------------------
const LIVE = process.env.LORENZ_TS_RUN_LIVE_DOCKER_E2E === "1";
const liveImage =
  process.env.LORENZ_TS_DOCKER_E2E_IMAGE ?? "lscr.io/linuxserver/openssh-server:latest";

describe.skipIf(!LIVE)(
  "DockerWorkerDriver live conformance (LORENZ_TS_RUN_LIVE_DOCKER_E2E=1)",
  () => {
    runDriverConformanceSuite(
      () =>
        new DockerWorkerDriver(
          { image: liveImage },
          // The live suite exercises provision/list/destroy only (no
          // makeUnreachable, so probe is never invoked); the pool injects the
          // real engine SSH runner in production.
          makeDeps(async () => {
            throw new Error("live docker conformance does not wire an ssh runner");
          }),
        ),
      {
        suiteName: "DockerWorkerDriver (live docker)",
        workerIds: ["lorenz-live-a", "lorenz-live-b"],
        provisionTimeoutMs: 120_000,
        probeTimeoutMs: 30_000,
        destroyTimeoutMs: 30_000,
        makeProvisionRequest: (workerId): ProvisionRequest => ({
          workerId,
          labels: [LABEL_POOL],
          timeoutMs: 120_000,
        }),
      },
    );
  },
);
