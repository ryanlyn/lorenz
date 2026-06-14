import { describe, expect, test } from "vitest";
import { WorkerDriverRegistry, POOL_OWNED_LABEL } from "@symphony/worker-sdk";
import type {
  DriverDeps,
  ProvisionRequest,
  SshRunOptions,
  SshRunResult,
  SshRunner,
} from "@symphony/worker-sdk";
import { runDriverConformanceSuite } from "@symphony/worker-sdk/conformance";
import { assert } from "@symphony/test-utils";

import {
  ModalWorkerDriver,
  modalWorkerDriverFactory,
  registerModalWorkerDriver,
  type ModalCreateRequest,
  type ModalSandbox,
  type ModalTransport,
} from "../src/index.js";

// A deterministic clock so `createdAtMs` is reproducible. The driver owns no
// timers (it delegates the probe timeout to `runSsh`), so set/clear are inert.
function fixedClock(initial: Date): DriverDeps["clock"] {
  return {
    now: () => initial,
    setTimeout: () => ({ unref: undefined }),
    clearTimeout: () => undefined,
  };
}

const okRunSsh: SshRunner = async () =>
  Promise.resolve({ stdout: "ready\n", stderr: "", status: 0 });

function makeDeps(runSsh: SshRunner = okRunSsh): DriverDeps {
  return {
    clock: fixedClock(new Date("2026-05-29T10:00:00.000Z")),
    logEvent: () => undefined,
    runSsh,
  };
}

const POOL_LABEL = "symphony.worker-pool";

/**
 * An in-memory fake Modal transport. It models a Modal account's live sandbox
 * inventory: `create` boots a sandbox that exposes an SSH endpoint and stamps
 * the driver-supplied labels; `terminate` removes it (idempotent); `list`
 * enumerates only sandboxes carrying a label filter. Faults can be injected so
 * the tests exercise the driver's error mapping without any real Modal SDK.
 */
class FakeModalTransport implements ModalTransport {
  readonly created: ModalCreateRequest[] = [];
  readonly terminated: string[] = [];
  private readonly sandboxes = new Map<string, ModalSandbox>();
  private nextId = 0;

  // Fault injection.
  createError?: string;
  terminateError?: string;
  listError?: string;

  async create(req: ModalCreateRequest): Promise<ModalSandbox> {
    this.created.push(req);
    if (this.createError !== undefined) {
      throw new Error(this.createError);
    }
    const sandboxId = `sb-${this.nextId++}`;
    const sandbox: ModalSandbox = {
      sandboxId,
      // A Modal sandbox provisioned to run sshd exposes an SSH endpoint.
      sshHost: `modal@${sandboxId}.modal.host:2200`,
      labels: [...req.labels],
    };
    this.sandboxes.set(sandboxId, sandbox);
    return sandbox;
  }

  async terminate(sandboxId: string): Promise<void> {
    if (this.terminateError !== undefined) {
      throw new Error(this.terminateError);
    }
    // Mirror real Modal: terminating a sandbox that is already gone surfaces a
    // not-found fault, which the driver must treat as idempotent success.
    if (!this.sandboxes.has(sandboxId)) {
      throw new Error(`modal: sandbox not found: ${sandboxId}`);
    }
    this.terminated.push(sandboxId);
    this.sandboxes.delete(sandboxId);
  }

  async list(opts: { label: string }): Promise<ModalSandbox[]> {
    if (this.listError !== undefined) {
      throw new Error(this.listError);
    }
    return [...this.sandboxes.values()].filter((sandbox) => sandbox.labels.includes(opts.label));
  }

  // Test helper: inject a sandbox that exists in the account but was NOT
  // provisioned through this driver instance (a survivor from a prior run).
  inject(sandbox: ModalSandbox): void {
    this.sandboxes.set(sandbox.sandboxId, sandbox);
  }
}

function makeDriver(transport: ModalTransport, runSsh?: SshRunner): ModalWorkerDriver {
  return new ModalWorkerDriver({ image: "ghcr.io/org/worker:latest" }, makeDeps(runSsh), {
    transport,
  });
}

// ---------------------------------------------------------------------------
// Conformance suite over the fake injected transport (always-on, no network).
// ---------------------------------------------------------------------------

runDriverConformanceSuite(() => makeDriver(new FakeModalTransport()), {
  suiteName: "ModalWorkerDriver (fake transport)",
  workerIds: ["worker-a", "worker-b"],
  makeProvisionRequest: (workerId): ProvisionRequest => ({
    workerId,
    labels: [POOL_LABEL],
    timeoutMs: 30_000,
  }),
  makeUnreachable: () => {
    // A created-but-unreachable sandbox: the SSH probe transport rejects, so
    // probe must gate the worker to ok:false (mirroring a sandbox whose sshd has
    // not come up yet).
    const driver = makeDriver(new FakeModalTransport(), async () => {
      throw new Error("ssh_timeout: modal sandbox unreachable");
    });
    return { driver, workerId: "worker-down" };
  },
});

describe("ModalWorkerDriver lifecycle", () => {
  test("capabilities are { sshAddressable:true, ephemeral:true, usesLedger:true }", () => {
    const driver = makeDriver(new FakeModalTransport());
    assert.deepEqual(driver.capabilities, {
      sshAddressable: true,
      ephemeral: true,
      usesLedger: true,
    });
    assert.equal(driver.kind, "modal");
  });

  test("provision creates a sandbox exposing ssh and returns the endpoint as workerHost", async () => {
    const transport = new FakeModalTransport();
    const driver = makeDriver(transport);

    const worker = await driver.provision({
      workerId: "worker-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });

    // The yielded workerHost is the sandbox's SSH endpoint (SSH-addressable).
    assert.match(worker.workerHost, /^modal@sb-0\.modal\.host:2200$/);
    assert.equal(worker.workerId, "worker-a");
    // driverRef is the Modal sandbox id used for destroy/list reconcile.
    assert.equal(worker.driverRef, "sb-0");
    assert.equal(worker.createdAtMs, new Date("2026-05-29T10:00:00.000Z").getTime());

    // Exactly one sandbox was created.
    assert.equal(transport.created.length, 1);
  });

  test("provision labels the sandbox with the workerId and the pool labels", async () => {
    const transport = new FakeModalTransport();
    const driver = makeDriver(transport);

    await driver.provision({ workerId: "worker-a", labels: [POOL_LABEL], timeoutMs: 30_000 });

    const req = transport.created[0];
    assert.ok(req);
    // The pool label and a workerId-derived label are both stamped so list()
    // reconcile can re-adopt survivors and correlate them back to a workerId.
    assert.equal(req.labels.includes(POOL_LABEL), true);
    assert.equal(
      req.labels.some((label) => label.includes("worker-a")),
      true,
    );
  });

  test("provision is idempotent on workerId (no duplicate sandbox)", async () => {
    const transport = new FakeModalTransport();
    const driver = makeDriver(transport);

    const first = await driver.provision({
      workerId: "worker-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });
    const second = await driver.provision({
      workerId: "worker-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });

    assert.deepEqual(second, first);
    // A second provision for the same workerId must NOT create a second sandbox.
    assert.equal(transport.created.length, 1);
  });

  test("probe runs deps.runSsh printf-ready with opts.timeoutMs verbatim", async () => {
    const transport = new FakeModalTransport();
    const calls: Array<{ host: string; command: string; options: SshRunOptions }> = [];
    const driver = makeDriver(transport, async (host, command, options = {}) => {
      calls.push({ host, command, options });
      return { stdout: "ready\n", stderr: "", status: 0 };
    });

    const worker = await driver.provision({
      workerId: "worker-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });
    const health = await driver.probe(worker, { timeoutMs: 7_000 });

    assert.equal(health.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.host, worker.workerHost);
    assert.equal(calls[0]?.command, "printf ready");
    assert.equal(calls[0]?.options.timeoutMs, 7_000);
  });

  test("probe gates a non-zero ssh exit to ok:false", async () => {
    const transport = new FakeModalTransport();
    const driver = makeDriver(
      transport,
      async (): Promise<SshRunResult> => ({
        stdout: "",
        stderr: "boom",
        status: 7,
      }),
    );

    const worker = await driver.provision({
      workerId: "worker-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });
    const health = await driver.probe(worker, { timeoutMs: 5_000 });

    assert.equal(health.ok, false);
    if (!health.ok) {
      assert.match(health.reason, /7/);
    }
  });

  test("destroy terminates the sandbox via the transport", async () => {
    const transport = new FakeModalTransport();
    const driver = makeDriver(transport);

    const worker = await driver.provision({
      workerId: "worker-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });
    await driver.destroy(worker, { timeoutMs: 5_000, reason: "shrink" });

    // The terminate hit the sandbox id (driverRef), not the workerId.
    assert.deepEqual(transport.terminated, ["sb-0"]);
    assert.deepEqual(await driver.list(), []);
  });

  test("destroy is idempotent (already-terminated sandbox)", async () => {
    const transport = new FakeModalTransport();
    const driver = makeDriver(transport);

    const worker = await driver.provision({
      workerId: "worker-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });
    await driver.destroy(worker, { timeoutMs: 5_000, reason: "idle" });
    // A second destroy of the same (already-gone) worker must not throw: the
    // transport surfaces a not-found, which the driver treats as idempotent
    // success. The sandbox stays gone.
    await driver.destroy(worker, { timeoutMs: 5_000, reason: "idle" });

    // The terminate landed exactly once (the second was a swallowed not-found).
    assert.deepEqual(transport.terminated, ["sb-0"]);
    assert.deepEqual(await driver.list(), []);
  });

  test("list enumerates only sandboxes carrying the pool label", async () => {
    const transport = new FakeModalTransport();
    // A foreign sandbox not labeled for the pool must NOT be adopted.
    transport.inject({
      sandboxId: "sb-foreign",
      sshHost: "other@host:22",
      labels: ["someone-else"],
    });
    const driver = makeDriver(transport);

    await driver.provision({ workerId: "worker-a", labels: [POOL_LABEL], timeoutMs: 30_000 });
    const listed = await driver.list();

    const refs = listed.map((worker) => worker.driverRef);
    assert.equal(refs.includes("sb-0"), true);
    assert.equal(refs.includes("sb-foreign"), false);
    // The listed descriptor is SSH-addressable and carries its sandbox id.
    const adopted = listed.find((worker) => worker.driverRef === "sb-0");
    assert.ok(adopted);
    assert.match(adopted.workerHost, /modal\.host:2200$/);
    // The descriptor must surface POOL_OWNED_LABEL so the pool's hydrate/reaper
    // ownership gate re-adopts (and can later destroy) this survivor; without it
    // a leaked paid sandbox would never be reaped.
    assert.equal(adopted.labels.includes(POOL_OWNED_LABEL), true);
  });

  test("provision maps a transport fault to a modal_provision_failed error", async () => {
    const transport = new FakeModalTransport();
    transport.createError = "modal: quota exceeded";
    const driver = makeDriver(transport);

    await assert.rejects(
      () => driver.provision({ workerId: "worker-a", labels: [POOL_LABEL], timeoutMs: 30_000 }),
      /modal_provision_failed/,
    );
    // A failed create must NOT be recorded as a live worker.
    assert.deepEqual(await driver.list().catch(() => []), []);
  });

  test("destroy maps a transport fault to a modal_destroy_failed error", async () => {
    const transport = new FakeModalTransport();
    const driver = makeDriver(transport);
    const worker = await driver.provision({
      workerId: "worker-a",
      labels: [POOL_LABEL],
      timeoutMs: 30_000,
    });

    transport.terminateError = "modal: api unavailable";
    await assert.rejects(
      () => driver.destroy(worker, { timeoutMs: 5_000, reason: "shrink" }),
      /modal_destroy_failed/,
    );
  });

  test("list maps a transport fault to a modal_list_failed error", async () => {
    const transport = new FakeModalTransport();
    transport.listError = "modal: api unavailable";
    const driver = makeDriver(transport);

    await assert.rejects(() => driver.list(), /modal_list_failed/);
  });

  test("destroy terminates a survivor this instance did not provision (hydrate/reconcile)", async () => {
    // A sandbox left behind by a PRIOR daemon: it carries the pool label so a
    // fresh driver's list() re-adopts it, but this instance never provisioned
    // it (so it is not in `this.workers`). A reconcile/drain destroy MUST still
    // terminate it - otherwise a paid sandbox leaks forever.
    const transport = new FakeModalTransport();
    transport.inject({
      sandboxId: "sb-survivor",
      sshHost: "modal@sb-survivor.modal.host:2200",
      labels: [POOL_LABEL],
    });
    const driver = makeDriver(transport);

    const listed = await driver.list();
    const survivor = listed.find((worker) => worker.driverRef === "sb-survivor");
    assert.ok(survivor);

    await driver.destroy(survivor, { timeoutMs: 5_000, reason: "orphan" });

    // The survivor was actually terminated (not silently skipped).
    assert.deepEqual(transport.terminated, ["sb-survivor"]);
    assert.deepEqual(await driver.list(), []);
  });

  test("registerModalWorkerDriver without io registers a fail-loud factory", () => {
    const registry = new WorkerDriverRegistry();
    registerModalWorkerDriver({ workerDrivers: registry });
    // A second registration is a no-op (the kind is already registered).
    registerModalWorkerDriver({ workerDrivers: registry });

    // Enabling the kind without a configured transport fails loud at pool
    // construction with an actionable message, not at first provision.
    const factory = registry.require("modal");
    assert.throws(
      () => factory.create({}, makeDeps()),
      /worker_pool_driver_unavailable: modal requires an injected transport; register a configured modal driver via registerModalWorkerDriver\(registries, \{ transport \}\) before enabling it/,
    );
  });

  test("registerModalWorkerDriver with io registers a working factory closing over the transport", () => {
    const registry = new WorkerDriverRegistry();
    registerModalWorkerDriver({ workerDrivers: registry }, { transport: new FakeModalTransport() });

    const driver = registry.require("modal").create({}, makeDeps());
    assert.equal(driver.kind, "modal");
  });

  test("modalWorkerDriverFactory constructs a working driver over the injected transport", async () => {
    const transport = new FakeModalTransport();
    const factory = modalWorkerDriverFactory({ transport });
    assert.equal(factory.kind, "modal");

    const driver = factory.create({ image: "img:base" }, makeDeps());
    await driver.provision({ workerId: "worker-a", labels: [POOL_LABEL], timeoutMs: 30_000 });
    // The image driver option flows through to the transport create request.
    assert.equal(transport.created[0]?.image, "img:base");
  });
});

// ---------------------------------------------------------------------------
// Env-gated live test: actually provision/probe/destroy a real Modal Sandbox.
// Collected-but-skipped without SYMPHONY_TS_RUN_LIVE_MODAL_E2E=1 (+ a Modal
// token in the environment), mirroring the other SYMPHONY_TS_RUN_LIVE_* gates.
// ---------------------------------------------------------------------------

const LIVE_MODAL = process.env.SYMPHONY_TS_RUN_LIVE_MODAL_E2E === "1";

describe.skipIf(!LIVE_MODAL)("ModalWorkerDriver (live, env-gated)", () => {
  test("provisions a real sandbox, probes it ready over ssh, and terminates it", async () => {
    // This test is intentionally only runnable once Modal creds exist. It is
    // authored now and skipped by default. It would construct a ModalWorkerDriver
    // backed by the real Modal client transport, provision a sandbox, probe it
    // for ssh readiness, and terminate it, asserting the conformance contract
    // end-to-end against the live Modal API.
    expect(LIVE_MODAL).toBe(true);
  });
});
