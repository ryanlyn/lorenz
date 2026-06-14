import { execFile } from "node:child_process";

import { describe, expect, test } from "vitest";
import { WorkerDriverRegistry, POOL_OWNED_LABEL } from "@symphony/worker-sdk";
import type {
  WorkerDescriptor,
  DriverDeps,
  ProvisionRequest,
  SshRunOptions,
  SshRunResult,
  SshRunner,
} from "@symphony/worker-sdk";
import { runDriverConformanceSuite } from "@symphony/worker-sdk/conformance";
import { assert } from "@symphony/test-utils";

import {
  FlyWorkerDriver,
  flyWorkerDriverFactory,
  registerFlyWorkerDriver,
  type FlyFetch,
  type FlyFetchResponse,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test scaffolding: a deterministic clock + a fake Fly Machines HTTP transport.
// The driver drives the Machines REST API through an injected `fetch`-shaped
// client, so every always-on test asserts request/arg construction and parsing
// with zero network and zero cost.
// ---------------------------------------------------------------------------

function fixedClock(initial: Date): DriverDeps["clock"] {
  return {
    now: () => initial,
    setTimeout: () => ({ unref: undefined }),
    clearTimeout: () => undefined,
  };
}

const okRunSsh: SshRunner = async () =>
  Promise.resolve({ stdout: "ready\n", stderr: "", status: 0 });

function makeDeps(runSsh: SshRunner = okRunSsh): {
  deps: DriverDeps;
  events: Array<Record<string, unknown>>;
} {
  const events: Array<Record<string, unknown>> = [];
  return {
    deps: {
      clock: fixedClock(new Date("2026-05-29T10:00:00.000Z")),
      logEvent: (event) => events.push(event),
      runSsh,
    },
    events,
  };
}

const APP = "symphony-pool";
const TOKEN = "fly-secret-token";

function options(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app: APP,
    image: "ghcr.io/org/worker-sshd:latest",
    region: "iad",
    api_token: TOKEN,
    ...extra,
  };
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): FlyFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

/**
 * Builds a fake Fly Machines transport whose responses are scripted by an
 * in-memory machine store keyed on machine id. Records every request so tests
 * can assert verb/url/headers/body construction.
 */
function makeFakeFly(
  options: {
    onCreate?: (body: Record<string, unknown>) => FlyFetchResponse;
    listResponse?: () => FlyFetchResponse;
    onDestroy?: (machineId: string) => FlyFetchResponse;
  } = {},
): { fetch: FlyFetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const machines = new Map<string, Record<string, unknown>>();

  const fetch: FlyFetch = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ method, url, headers, body });

    const createMatch = /\/v1\/apps\/([^/]+)\/machines$/.exec(url);
    const itemMatch = /\/v1\/apps\/([^/]+)\/machines\/([^/?]+)(\?.*)?$/.exec(url);

    if (method === "POST" && createMatch) {
      if (options.onCreate) return options.onCreate(body as Record<string, unknown>);
      const id = `91857940a44389-${machines.size}`;
      const config = (body as Record<string, unknown>).config as Record<string, unknown>;
      const created = {
        id,
        name: (body as Record<string, unknown>).name ?? `m-${id}`,
        state: "started",
        region: (body as Record<string, unknown>).region ?? "iad",
        private_ip: `fdaa:0:1::${machines.size + 1}`,
        config,
      };
      machines.set(id, created);
      return jsonResponse(200, created);
    }
    if (method === "GET" && createMatch) {
      if (options.listResponse) return options.listResponse();
      return jsonResponse(200, [...machines.values()]);
    }
    if (method === "DELETE" && itemMatch) {
      const id = itemMatch[2]!;
      if (options.onDestroy) return options.onDestroy(id);
      machines.delete(id);
      return jsonResponse(200, { ok: true });
    }
    return jsonResponse(404, { error: "not found" });
  };

  return { fetch, requests };
}

function driver(
  overrides: {
    fetch?: FlyFetch;
    runSsh?: SshRunner;
    optionsExtra?: Record<string, unknown>;
  } = {},
): FlyWorkerDriver {
  const { fetch } = makeFakeFly();
  const { deps } = makeDeps(overrides.runSsh ?? okRunSsh);
  return new FlyWorkerDriver(options(overrides.optionsExtra), deps, {
    fetch: overrides.fetch ?? fetch,
  });
}

const provisionRequest = (workerId: string): ProvisionRequest => ({
  workerId,
  labels: ["symphony.worker-pool", `symphony.app:${APP}`],
  timeoutMs: 30_000,
  driverOptions: options(),
});

// ---------------------------------------------------------------------------
// Shared conformance suite over the fake Machines transport.
// ---------------------------------------------------------------------------

runDriverConformanceSuite(
  () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    return new FlyWorkerDriver(options(), deps, { fetch });
  },
  {
    suiteName: "FlyWorkerDriver (fake Machines API)",
    workerIds: ["worker-aaa", "worker-bbb"],
    makeProvisionRequest: provisionRequest,
    makeUnreachable: () => {
      const { fetch } = makeFakeFly();
      // A created-but-unreachable machine: probe SSH transport rejects.
      const { deps } = makeDeps(async () => {
        throw new Error("ssh_timeout: fly 5000");
      });
      const drv = new FlyWorkerDriver(options(), deps, { fetch });
      return { driver: drv, workerId: "worker-down" };
    },
  },
);

describe("FlyWorkerDriver", () => {
  test("capabilities are { sshAddressable:true, ephemeral:true, usesLedger:true }", () => {
    assert.deepEqual(driver().capabilities, {
      sshAddressable: true,
      ephemeral: true,
      usesLedger: true,
    });
    assert.equal(driver().kind, "fly");
  });

  test("provision POSTs to the Machines create endpoint with auth + image + region", async () => {
    const { fetch, requests } = makeFakeFly();
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(options(), deps, { fetch });

    await drv.provision(provisionRequest("worker-aaa"));

    const post = requests.find((r) => r.method === "POST");
    assert.ok(post);
    // Default Machines API host, app-scoped create path.
    assert.equal(post!.url, `https://api.machines.dev/v1/apps/${APP}/machines`);
    assert.equal(post!.headers["Authorization"], `Bearer ${TOKEN}`);
    assert.equal(post!.headers["Content-Type"], "application/json");
    const body = post!.body as Record<string, unknown>;
    assert.equal(body.region, "iad");
    const config = body.config as Record<string, unknown>;
    assert.equal(config.image, "ghcr.io/org/worker-sshd:latest");
  });

  test("provision labels the machine via config.metadata (workerId + pool label)", async () => {
    const { fetch, requests } = makeFakeFly();
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(options(), deps, { fetch });

    await drv.provision(provisionRequest("worker-aaa"));

    const post = requests.find((r) => r.method === "POST")!;
    const config = (post.body as Record<string, unknown>).config as Record<string, unknown>;
    const metadata = config.metadata as Record<string, string>;
    // The pool label + the workerId are stamped so list()-reconcile can re-adopt.
    assert.equal(metadata["symphony_worker_pool"], "true");
    assert.equal(metadata["symphony_worker_id"], "worker-aaa");
  });

  test("provision returns an SSH-addressable workerHost using the private_ip + ssh_user/ssh_port", async () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(options({ ssh_user: "agent", ssh_port: 2222 }), deps, {
      fetch,
    });

    const worker = await drv.provision(provisionRequest("worker-aaa"));

    // user@[<private-ipv6>]:port — addressable from the Fly private network.
    // The v6 literal is bracketed so the SSH parser can split off the port.
    assert.equal(worker.workerHost, "agent@[fdaa:0:1::1]:2222");
    assert.equal(worker.driverRef, "91857940a44389-0");
    assert.deepEqual([...worker.labels].sort(), [
      "symphony.app:symphony-pool",
      "symphony.worker-pool",
    ]);
  });

  test("provision defaults ssh_user=root and ssh_port=22 when not configured", async () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(options(), deps, { fetch });

    const worker = await drv.provision(provisionRequest("worker-aaa"));
    assert.equal(worker.workerHost, "root@[fdaa:0:1::1]:22");
  });

  test("provision honors an explicit ssh_host_template override", async () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(
      options({ ssh_host_template: "{machineId}.vm.{app}.internal", ssh_user: "agent" }),
      deps,
      { fetch },
    );

    const worker = await drv.provision(provisionRequest("worker-aaa"));
    assert.equal(worker.workerHost, "agent@91857940a44389-0.vm.symphony-pool.internal:22");
  });

  test("workerHost brackets an IPv6 private_ip so the trailing :port stays unambiguous", async () => {
    // A Fly private IPv6 (fdaa:0:...) must yield a workerHost the engine's SSH
    // target parser can split into a destination + a port. An unbracketed v6
    // literal with a glued :port collapses to a single host with NO -p, so the
    // probe/runner cannot connect. Render the v6 literal bracketed so the SSH
    // bracketed-host path lifts the trailing :port into -p.
    const { fetch } = makeFakeFly({
      onCreate: () =>
        jsonResponse(200, {
          id: "m-v6",
          state: "started",
          region: "iad",
          private_ip: "fdaa:0:1::1",
          config: { image: "img", metadata: { symphony_worker_pool: "true" } },
        }),
    });
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(options({ ssh_user: "agent", ssh_port: 2222 }), deps, {
      fetch,
    });

    const worker = await drv.provision(provisionRequest("worker-aaa"));

    // The bracketed v6 form: user@[host]:port (never user@host:port for v6).
    assert.equal(worker.workerHost, "agent@[fdaa:0:1::1]:2222");
  });

  test("workerHost for an IPv4 private_ip stays unbracketed (user@host:port)", async () => {
    const { fetch } = makeFakeFly({
      onCreate: () =>
        jsonResponse(200, {
          id: "m-v4",
          state: "started",
          region: "iad",
          private_ip: "10.0.0.7",
          config: { image: "img", metadata: { symphony_worker_pool: "true" } },
        }),
    });
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(options({ ssh_user: "agent", ssh_port: 2222 }), deps, {
      fetch,
    });

    const worker = await drv.provision(provisionRequest("worker-aaa"));
    // IPv4 stays unbracketed.
    assert.equal(worker.workerHost, "agent@10.0.0.7:2222");
  });

  test("workerHost for a DNS ssh_host_template stays unbracketed (user@host:port)", async () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(
      options({ ssh_host_template: "{machineId}.vm.{app}.internal", ssh_user: "agent" }),
      deps,
      { fetch },
    );

    const worker = await drv.provision(provisionRequest("worker-aaa"));
    assert.equal(worker.workerHost, "agent@91857940a44389-0.vm.symphony-pool.internal:22");
  });

  test("camelCase driver options are honored (app/image/apiToken/sshUser)", async () => {
    const { fetch, requests } = makeFakeFly();
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(
      {
        app: "camel-app",
        image: "img:camel",
        apiToken: "camel-token",
        sshUser: "camel",
      },
      deps,
      { fetch },
    );

    const worker = await drv.provision({ workerId: "worker-z", labels: [], timeoutMs: 30_000 });

    const post = requests.find((r) => r.method === "POST")!;
    assert.equal(post.url, "https://api.machines.dev/v1/apps/camel-app/machines");
    assert.equal(post.headers["Authorization"], "Bearer camel-token");
    assert.match(worker.workerHost, /^camel@/);
  });

  test("constructing throws fly_app_required when app is missing", () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    assert.throws(
      () => new FlyWorkerDriver(options({ app: undefined }), deps, { fetch }),
      /fly_app_required/,
    );
  });

  test("constructing throws fly_image_required when image is missing", () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    assert.throws(
      () => new FlyWorkerDriver(options({ image: undefined }), deps, { fetch }),
      /fly_image_required/,
    );
  });

  test("constructing throws fly_api_token_required when no token and no FLY_API_TOKEN env", () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps();
    const prev = process.env.FLY_API_TOKEN;
    delete process.env.FLY_API_TOKEN;
    try {
      assert.throws(
        () => new FlyWorkerDriver(options({ api_token: undefined }), deps, { fetch }),
        /fly_api_token_required/,
      );
    } finally {
      if (prev === undefined) delete process.env.FLY_API_TOKEN;
      else process.env.FLY_API_TOKEN = prev;
    }
  });

  test("api token falls back to FLY_API_TOKEN env when not in the driver options", async () => {
    const { fetch, requests } = makeFakeFly();
    const { deps } = makeDeps();
    const prev = process.env.FLY_API_TOKEN;
    process.env.FLY_API_TOKEN = "env-token";
    try {
      const drv = new FlyWorkerDriver(options({ api_token: undefined }), deps, { fetch });
      await drv.provision(provisionRequest("worker-aaa"));
      const post = requests.find((r) => r.method === "POST")!;
      assert.equal(post.headers["Authorization"], "Bearer env-token");
    } finally {
      if (prev === undefined) delete process.env.FLY_API_TOKEN;
      else process.env.FLY_API_TOKEN = prev;
    }
  });

  test("provision maps a non-2xx create response to a fly_provision_failed error", async () => {
    const { fetch } = makeFakeFly({
      onCreate: () => jsonResponse(422, { error: "image not found" }),
    });
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(options(), deps, { fetch });

    await assert.rejects(
      () => drv.provision(provisionRequest("worker-aaa")),
      /fly_provision_failed/,
    );
  });

  test("probe runs deps.runSsh printf-ready against the workerHost with opts.timeoutMs", async () => {
    const calls: Array<{ host: string; command: string; options: SshRunOptions }> = [];
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps(async (host, command, options = {}): Promise<SshRunResult> => {
      calls.push({ host, command, options });
      return { stdout: "ready\n", stderr: "", status: 0 };
    });
    const drv = new FlyWorkerDriver(options(), deps, { fetch });

    const worker = await drv.provision(provisionRequest("worker-aaa"));
    const health = await drv.probe(worker, { timeoutMs: 9_000 });

    assert.equal(health.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.host, worker.workerHost);
    assert.equal(calls[0]?.command, "printf ready");
    assert.equal(calls[0]?.options.timeoutMs, 9_000);
  });

  test("probe gates a non-zero ssh exit to ok:false with a reason", async () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps(
      async (): Promise<SshRunResult> => ({ stdout: "", stderr: "boom", status: 255 }),
    );
    const drv = new FlyWorkerDriver(options(), deps, { fetch });
    const worker = await drv.provision(provisionRequest("worker-aaa"));
    const health = await drv.probe(worker, { timeoutMs: 5_000 });
    assert.equal(health.ok, false);
    if (!health.ok) assert.match(health.reason, /255/);
  });

  test("probe gates an ssh transport error to ok:false (does not throw)", async () => {
    const { fetch } = makeFakeFly();
    const { deps } = makeDeps(async (): Promise<SshRunResult> => {
      throw new Error("ssh_timeout: host 5000");
    });
    const drv = new FlyWorkerDriver(options(), deps, { fetch });
    const worker = await drv.provision(provisionRequest("worker-aaa"));
    const health = await drv.probe(worker, { timeoutMs: 5_000 });
    assert.equal(health.ok, false);
    if (!health.ok) assert.match(health.reason, /ssh_timeout/);
  });

  test("destroy issues DELETE to the machine endpoint with force=true", async () => {
    const { fetch, requests } = makeFakeFly();
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(options(), deps, { fetch });
    const worker = await drv.provision(provisionRequest("worker-aaa"));

    await drv.destroy(worker, { timeoutMs: 5_000, reason: "shrink" });

    const del = requests.find((r) => r.method === "DELETE");
    assert.ok(del);
    assert.equal(
      del!.url,
      `https://api.machines.dev/v1/apps/${APP}/machines/${worker.driverRef}?force=true`,
    );
    assert.equal(del!.headers["Authorization"], `Bearer ${TOKEN}`);
  });

  test("destroy is idempotent: a 404 (already gone) is swallowed", async () => {
    const { fetch } = makeFakeFly({
      onDestroy: () => jsonResponse(404, { error: "machine not found" }),
    });
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(options(), deps, { fetch });
    const worker: WorkerDescriptor = {
      workerId: "worker-aaa",
      workerHost: "root@fdaa:0:1::1:22",
      driverRef: "already-gone",
      createdAtMs: 0,
      labels: ["symphony.worker-pool"],
      metadata: {},
    };
    // Must NOT throw on a 404.
    await drv.destroy(worker, { timeoutMs: 5_000, reason: "orphan" });
  });

  test("destroy maps a 5xx error to fly_destroy_failed", async () => {
    const { fetch } = makeFakeFly({
      onDestroy: () => jsonResponse(500, { error: "internal" }),
    });
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(options(), deps, { fetch });
    const worker: WorkerDescriptor = {
      workerId: "worker-aaa",
      workerHost: "root@fdaa:0:1::1:22",
      driverRef: "m-boom",
      createdAtMs: 0,
      labels: ["symphony.worker-pool"],
      metadata: {},
    };
    await assert.rejects(
      () => drv.destroy(worker, { timeoutMs: 5_000, reason: "drain" }),
      /fly_destroy_failed/,
    );
  });

  test("destroy aborts and throws (never hangs) when the Fly API stalls past the timeout", async () => {
    // A fetch that NEVER resolves on its own - it settles only when the bounded
    // abort signal fires, mimicking a stuck Fly Machines API call. Without the
    // deadline this would block recycle()/drain() forever.
    const hangingFetch: FlyFetch = async (_url, init) =>
      new Promise<FlyFetchResponse>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        });
      });
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(options(), deps, { fetch: hangingFetch });
    const worker: WorkerDescriptor = {
      workerId: "worker-aaa",
      workerHost: "root@fdaa:0:1::1:22",
      driverRef: "m-stuck",
      createdAtMs: 0,
      labels: ["symphony.worker-pool"],
      metadata: {},
    };
    await assert.rejects(
      () => drv.destroy(worker, { timeoutMs: 20, reason: "drain" }),
      /fly_request_timeout/,
    );
  });

  test("list GETs the app machines endpoint and parses only pool-labeled survivors", async () => {
    const mixed = [
      {
        id: "m-ours",
        state: "started",
        private_ip: "fdaa:0:1::a",
        config: {
          image: "img",
          metadata: { symphony_worker_pool: "true", symphony_worker_id: "worker-1" },
        },
      },
      {
        // Unlabeled machine that belongs to the app but NOT to the pool: skipped.
        id: "m-foreign",
        state: "started",
        private_ip: "fdaa:0:1::b",
        config: { image: "other", metadata: {} },
      },
    ];
    const { fetch, requests } = makeFakeFly({ listResponse: () => jsonResponse(200, mixed) });
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(options(), deps, { fetch });

    const listed = await drv.list();

    const get = requests.find((r) => r.method === "GET");
    assert.ok(get);
    assert.equal(get!.url, `https://api.machines.dev/v1/apps/${APP}/machines`);
    // Only the pool-labeled survivor is adopted; the foreign machine is dropped.
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.workerId, "worker-1");
    assert.equal(listed[0]?.driverRef, "m-ours");
    assert.match(listed[0]!.workerHost, /fdaa:0:1::a/);
    // The descriptor surfaces POOL_OWNED_LABEL so the pool's hydrate/reconcile
    // ownership gate re-adopts (and can later clean up) this paid survivor.
    // Without it a crash-leaked machine is a permanent paid orphan.
    assert.equal(listed[0]!.labels.includes(POOL_OWNED_LABEL), true);
  });

  test("list maps a non-2xx response to fly_list_failed", async () => {
    const { fetch } = makeFakeFly({
      listResponse: () => jsonResponse(401, { error: "unauthorized" }),
    });
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(options(), deps, { fetch });
    await assert.rejects(() => drv.list(), /fly_list_failed/);
  });

  test("uses a configured api_host_name override for the base url", async () => {
    const { fetch, requests } = makeFakeFly();
    const { deps } = makeDeps();
    const drv = new FlyWorkerDriver(options({ api_host_name: "https://api.example.test" }), deps, {
      fetch,
    });
    await drv.provision(provisionRequest("worker-aaa"));
    const post = requests.find((r) => r.method === "POST")!;
    assert.equal(post.url, `https://api.example.test/v1/apps/${APP}/machines`);
  });

  test("registerFlyWorkerDriver registers the factory idempotently", () => {
    const registry = new WorkerDriverRegistry();
    registerFlyWorkerDriver({ workerDrivers: registry });
    // A second registration is a no-op (the kind is already registered).
    registerFlyWorkerDriver({ workerDrivers: registry });

    const factory = registry.require("fly");
    assert.equal(factory, flyWorkerDriverFactory);
    assert.equal(factory.create(options(), makeDeps().deps).kind, "fly");
  });
});

// ---------------------------------------------------------------------------
// Live e2e: provisions and destroys a REAL Fly Machine. Collected-but-skipped
// without the gate so it never runs (or costs) in default CI.
// ---------------------------------------------------------------------------

const LIVE = process.env.SYMPHONY_TS_RUN_LIVE_FLY_E2E === "1" && !!process.env.FLY_API_TOKEN;

// A minimal local `ssh` runner for the gated live probe. In production the pool
// injects the engine's SSH runner through DriverDeps; this extension test cannot
// import the engine ssh package, so it shells out to the system `ssh` binary,
// understanding the `user@host:port` / `user@[v6]:port` workerHost forms.
const liveRunSsh: SshRunner = async (destination, command, opts = {}) => {
  const match = /^(?<user>[^@]+)@(?:\[(?<v6>[^\]]+)\]|(?<host>[^:]+))(?::(?<port>\d+))?$/.exec(
    destination,
  );
  const user = match?.groups?.user ?? "root";
  const host = match?.groups?.v6 ?? match?.groups?.host ?? destination;
  const port = match?.groups?.port ?? "22";
  return new Promise((resolve) => {
    execFile(
      "ssh",
      [
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "BatchMode=yes",
        "-p",
        port,
        `${user}@${host}`,
        command,
      ],
      { timeout: opts.timeoutMs ?? 30_000, encoding: "utf8" },
      (error, stdout, stderr) => {
        const status =
          typeof (error as { code?: unknown } | null)?.code === "number"
            ? (error as { code: number }).code
            : error
              ? 255
              : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", status });
      },
    );
  });
};

describe.skipIf(!LIVE)("FlyWorkerDriver live e2e (gated)", () => {
  test("provision -> probe -> destroy against a real Fly app", async () => {
    const app = process.env.SYMPHONY_LIVE_FLY_APP;
    const image = process.env.SYMPHONY_LIVE_FLY_IMAGE;
    expect(app, "set SYMPHONY_LIVE_FLY_APP").toBeTruthy();
    expect(image, "set SYMPHONY_LIVE_FLY_IMAGE").toBeTruthy();

    const { deps } = makeDeps(liveRunSsh);
    const drv = new FlyWorkerDriver(
      options({
        app,
        image,
        api_token: process.env.FLY_API_TOKEN,
        region: process.env.SYMPHONY_LIVE_FLY_REGION ?? "iad",
        ssh_user: process.env.SYMPHONY_LIVE_FLY_SSH_USER ?? "root",
        ssh_port: Number(process.env.SYMPHONY_LIVE_FLY_SSH_PORT ?? "22"),
      }),
      deps,
    );

    const worker = await drv.provision({
      workerId: `live-${Date.now()}`,
      labels: ["symphony.worker-pool"],
      timeoutMs: 120_000,
    });
    try {
      let health = await drv.probe(worker, { timeoutMs: 30_000 });
      const deadline = Date.now() + 120_000;
      while (!health.ok && Date.now() < deadline) {
        health = await drv.probe(worker, { timeoutMs: 30_000 });
      }
      expect(health.ok).toBe(true);

      const listed = await drv.list();
      expect(listed.some((b) => b.driverRef === worker.driverRef)).toBe(true);
    } finally {
      await drv.destroy(worker, { timeoutMs: 60_000, reason: "drain" });
    }
  });
});
