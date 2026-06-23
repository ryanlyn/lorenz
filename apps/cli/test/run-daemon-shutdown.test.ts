import path from "node:path";
import { writeFile } from "node:fs/promises";

import { parseConfig } from "@lorenz/config";
import { afterEach, beforeEach, test, vi } from "vitest";
import { assert, tempDir } from "@lorenz/test-utils";

import type * as daemonModule from "../src/daemon.js";
import type * as daemonLockModule from "../src/daemonLock.js";

const mocks = vi.hoisted(() => ({
  loadWorkflow: vi.fn(),
  configureLogFile: vi.fn(async () => {}),
  startObservabilityServer: vi.fn(),
  render: vi.fn(),
  createTrackerClient: vi.fn(),
  runAgentAttempt: vi.fn(),
  runtimeDefaultSettingsOptions: vi.fn(() => ({})),
  // No worker.worker_pool in the fixture, so the real builder returns undefined.
  buildDispatchCoordinator: vi.fn(() => undefined),
  acquireDaemonLock: null as
    | ((
        ...args: Parameters<typeof daemonLockModule.acquireDaemonLock>
      ) => ReturnType<typeof daemonLockModule.acquireDaemonLock>)
    | null,
  runtimeInstances: [] as Array<FakeRuntime>,
}));

class FakeRuntime {
  public readonly stop = vi.fn(() => {
    this.stopResolver?.();
  });

  public readonly subscribe = vi.fn();

  public readonly drainWorkerPool = vi.fn(async () => {});

  public startEntered: Promise<void>;
  public stopRequested: Promise<void>;
  private readonly startResolver: () => void;
  private readonly stopResolver: () => void;

  constructor() {
    const startLatch = promiseLatch();
    const stopLatch = promiseLatch();
    this.startEntered = startLatch.promise;
    this.stopRequested = stopLatch.promise;
    this.startResolver = startLatch.resolve;
    this.stopResolver = stopLatch.resolve;
    mocks.runtimeInstances.push(this);
  }

  async start(): Promise<void> {
    this.startResolver();
    await this.stopRequested;
  }
}

function promiseLatch(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

vi.mock("@lorenz/workflow", () => ({
  loadWorkflow: mocks.loadWorkflow,
}));

vi.mock("@lorenz/log-file", () => ({
  configureLogFile: mocks.configureLogFile,
  appendLogEvent: vi.fn(),
}));

vi.mock("@lorenz/server", () => ({
  startObservabilityServer: mocks.startObservabilityServer,
  IssueStore: class {
    upsert() {}
    close() {}
  },
  defaultIssueStorePath: () => "/tmp/lorenz-test-issues.db",
}));

vi.mock("ink", () => ({
  render: mocks.render,
}));

vi.mock("@lorenz/runtime", () => ({
  LorenzRuntime: FakeRuntime,
}));

vi.mock("../src/daemonLock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof daemonLockModule>();
  return {
    ...actual,
    acquireDaemonLock: (...args: Parameters<typeof actual.acquireDaemonLock>) =>
      mocks.acquireDaemonLock
        ? mocks.acquireDaemonLock(...args)
        : actual.acquireDaemonLock(...args),
  };
});

vi.mock("@lorenz/traceviz-emitter", () => ({
  TraceEmitter: class {
    public readonly emit = vi.fn();
  },
}));

// Keep the real registerBuiltinBackends so runDaemon populates the default registries the
// same way the CLI entrypoints do; only the runtime-facing adapters are stubbed.
vi.mock("../src/daemon.js", async (importOriginal) => ({
  ...(await importOriginal<typeof daemonModule>()),
  createTrackerClient: mocks.createTrackerClient,
  runAgentAttempt: mocks.runAgentAttempt,
  runtimeAdapters: {},
  runtimeDefaultSettingsOptions: mocks.runtimeDefaultSettingsOptions,
  buildDispatchCoordinator: mocks.buildDispatchCoordinator,
}));

const { runDaemon } = await import("../src/main.js");

type ProcessEvent = "SIGINT" | "SIGTERM";
type ProcessListener = (...args: unknown[]) => void;

function addedProcessListeners(
  event: ProcessEvent,
  baseline: ReadonlyArray<ProcessListener>,
): ProcessListener[] {
  const known = new Set(baseline);
  return process.listeners(event).filter((listener) => !known.has(listener));
}

function assertNoAddedProcessListeners(
  event: ProcessEvent,
  baseline: ReadonlyArray<ProcessListener>,
): void {
  assert.deepEqual(addedProcessListeners(event, baseline), []);
}

async function workflowFixture() {
  const root = await tempDir("lorenz-cli-shutdown");
  const settings = parseConfig(
    {
      tracker: {
        kind: "local",
        path: path.join(root, ".lorenz/local"),
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done"],
      },
      workspace: { root },
      logging: { log_file: path.join(root, "log", "lorenz.log") },
      server: {
        host: "127.0.0.1",
        port: 4040,
        traceDir: path.join(root, "traces"),
      },
    },
    {},
  );

  const workflowPath = path.join(root, "WORKFLOW.md");
  await writeFile(workflowPath, "# Test workflow\n", "utf8");

  return {
    path: workflowPath,
    config: {},
    promptTemplate: "Issue {{ issue.identifier }}",
    settings,
  };
}

let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
let originalIsTTY: PropertyDescriptor | undefined;

beforeEach(() => {
  mocks.loadWorkflow.mockReset();
  mocks.configureLogFile.mockClear();
  mocks.startObservabilityServer.mockReset();
  mocks.render.mockReset();
  mocks.render.mockReturnValue({ unmount: vi.fn() });
  mocks.createTrackerClient.mockReset();
  mocks.runAgentAttempt.mockReset();
  mocks.runtimeDefaultSettingsOptions.mockClear();
  mocks.buildDispatchCoordinator.mockClear();
  mocks.acquireDaemonLock = null;
  mocks.runtimeInstances.length = 0;
  stderrWriteSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  stderrWriteSpy.mockRestore();
  if (originalIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
  vi.restoreAllMocks();
});

async function waitForRuntimeInstance(): Promise<FakeRuntime> {
  await vi.waitFor(
    () => {
      assert.ok(mocks.runtimeInstances[0]);
    },
    {
      timeout: 500,
      interval: 5,
      onTimeout(error) {
        const stderr = stderrWriteSpy.mock.calls.map((call) => String(call[0])).join("");
        return new Error(`${error.message}: ${stderr}`);
      },
    },
  );
  return mocks.runtimeInstances[0]!;
}

test("runDaemon stops gracefully on the first SIGINT and returns success", async () => {
  mocks.loadWorkflow.mockResolvedValue(await workflowFixture());

  const sigintBaseline = process.listeners("SIGINT");
  const sigtermBaseline = process.listeners("SIGTERM");

  const daemonPromise = runDaemon({
    workflowPath: "WORKFLOW.md",
    once: false,
    dryRun: false,
    tui: true,
    dashboard: false,
    port: null,
    logsRoot: null,
    claimStore: { backend: null, path: null, ownerStaleMs: null },
  });

  const runtime = await waitForRuntimeInstance();
  await runtime.startEntered;

  const [sigintHandler] = addedProcessListeners("SIGINT", sigintBaseline);
  const sigtermHandlers = addedProcessListeners("SIGTERM", sigtermBaseline);

  assert.equal(typeof sigintHandler, "function");
  assert.equal(sigtermHandlers.length, 1);

  sigintHandler!();

  assert.equal(runtime.stop.mock.calls.length, 1);
  assert.equal(await daemonPromise, 0);
  assert.equal(mocks.render.mock.calls.length, 1);
  assert.equal(mocks.configureLogFile.mock.calls.length, 1);
  assert.equal(
    stderrWriteSpy.mock.calls.some((call) => String(call[0]).includes("ELIFECYCLE")),
    false,
  );
  assertNoAddedProcessListeners("SIGINT", sigintBaseline);
  assertNoAddedProcessListeners("SIGTERM", sigtermBaseline);
});

test("runDaemon rejects a second live daemon for the same workflow", async () => {
  mocks.loadWorkflow.mockResolvedValue(await workflowFixture());

  const sigintBaseline = process.listeners("SIGINT");
  const daemonPromise = runDaemon({
    workflowPath: "WORKFLOW.md",
    once: false,
    dryRun: false,
    tui: true,
    dashboard: false,
    port: null,
    logsRoot: null,
    claimStore: { backend: null, path: null, ownerStaleMs: null },
  });

  const runtime = await waitForRuntimeInstance();
  await runtime.startEntered;

  const secondResult = await runDaemon({
    workflowPath: "WORKFLOW.md",
    once: false,
    dryRun: false,
    tui: false,
    dashboard: false,
    port: null,
    logsRoot: null,
    claimStore: { backend: null, path: null, ownerStaleMs: null },
  });

  assert.equal(secondResult, 1);
  assert.equal(
    stderrWriteSpy.mock.calls.some((call) => String(call[0]).includes("daemon_already_running")),
    true,
  );

  const [sigintHandler] = addedProcessListeners("SIGINT", sigintBaseline);
  sigintHandler!();
  assert.equal(await daemonPromise, 0);
});

test("runDaemon publishes no HTTP control endpoint when dashboard is disabled", async () => {
  mocks.loadWorkflow.mockResolvedValue(await workflowFixture());
  const sigintBaseline = process.listeners("SIGINT");
  const startedAt = "2026-01-01T00:00:00.000Z";
  const heartbeatAt = "2026-01-01T00:00:00.000Z";
  const fakeRecord = {
    version: 1 as const,
    ownerId: "owner-a",
    pid: process.pid,
    hostname: "host-a",
    startedAt,
    workflowPath: "/tmp/WORKFLOW.md",
    workspaceRoot: "/tmp",
    lockPath: "/tmp/.lorenz/daemon/test.lock.json",
    endpoint: { kind: "none" as const, address: "" },
    controlToken: "control-token",
    heartbeatAt,
  };
  const updateEndpoint = vi.fn(async () => fakeRecord);
  const release = vi.fn(async () => true);
  const heartbeat = vi.fn(async () => fakeRecord);
  mocks.acquireDaemonLock = async (...args) => {
    assert.equal(args[0].endpoint.kind, "none");
    assert.equal(args[0].endpoint.address, "");
    return {
      status: "acquired",
      lock: {
        heartbeat,
        release,
        snapshot: () => fakeRecord,
        updateEndpoint,
      } as unknown as daemonLockModule.DaemonLock,
    };
  };

  const daemonPromise = runDaemon({
    workflowPath: "WORKFLOW.md",
    once: false,
    dryRun: false,
    tui: false,
    dashboard: false,
    port: null,
    logsRoot: null,
    claimStore: { backend: null, path: null, ownerStaleMs: null },
  });

  const runtime = await waitForRuntimeInstance();
  await runtime.startEntered;
  const [sigintHandler] = addedProcessListeners("SIGINT", sigintBaseline);
  sigintHandler!();

  assert.equal(await daemonPromise, 0);
  assert.equal(mocks.startObservabilityServer.mock.calls.length, 0);
  assert.equal(updateEndpoint.mock.calls.length, 0);
});

test("runDaemon reports failure when the daemon lock is lost during runtime start", async () => {
  mocks.loadWorkflow.mockResolvedValue(await workflowFixture());
  let rejectHeartbeat!: (error: Error) => void;
  const pendingHeartbeat = new Promise<never>((_resolve, reject) => {
    rejectHeartbeat = reject;
  });
  const startedAt = "2026-01-01T00:00:00.000Z";
  const heartbeatAt = "2026-01-01T00:00:00.000Z";
  const fakeRecord = {
    version: 1 as const,
    ownerId: "owner-a",
    pid: process.pid,
    hostname: "host-a",
    startedAt,
    workflowPath: "/tmp/WORKFLOW.md",
    workspaceRoot: "/tmp",
    lockPath: "/tmp/.lorenz/daemon/test.lock.json",
    endpoint: { kind: "http" as const, address: "http://127.0.0.1:4040" },
    controlToken: "control-token",
    heartbeatAt,
  };
  const release = vi.fn(async () => true);
  const heartbeat = vi.fn(() => pendingHeartbeat);
  mocks.acquireDaemonLock = async () => ({
    status: "acquired",
    lock: {
      heartbeat,
      release,
      snapshot: () => fakeRecord,
      updateEndpoint: vi.fn(async () => fakeRecord),
    } as unknown as daemonLockModule.DaemonLock,
  });

  const daemonPromise = runDaemon({
    workflowPath: "WORKFLOW.md",
    once: false,
    dryRun: false,
    tui: false,
    dashboard: false,
    port: null,
    logsRoot: null,
    claimStore: { backend: null, path: null, ownerStaleMs: null },
  });

  const runtime = await waitForRuntimeInstance();
  await runtime.startEntered;
  rejectHeartbeat(new Error("daemon_lock_lost"));

  assert.equal(await daemonPromise, 1);
  assert.equal(runtime.stop.mock.calls.length, 1);
  assert.equal(release.mock.calls.length, 1);
  assert.equal(
    stderrWriteSpy.mock.calls.some((call) => String(call[0]).includes("daemon_lock_lost")),
    true,
  );
});

test("runDaemon warns about deprecated config keys once at startup", async () => {
  const fixture = await workflowFixture();
  mocks.loadWorkflow.mockResolvedValue({
    ...fixture,
    config: { codex: { command: "codex-acp" } },
  });

  const sigintBaseline = process.listeners("SIGINT");

  const daemonPromise = runDaemon({
    workflowPath: "WORKFLOW.md",
    once: false,
    dryRun: false,
    tui: true,
    dashboard: false,
    port: null,
    logsRoot: null,
    claimStore: { backend: null, path: null, ownerStaleMs: null },
  });

  const runtime = await waitForRuntimeInstance();
  await runtime.startEntered;

  const deprecationWrites = stderrWriteSpy.mock.calls.filter((call) =>
    String(call[0]).includes("Lorenz config deprecation:"),
  );
  assert.equal(deprecationWrites.length, 1);
  assert.match(
    String(deprecationWrites[0]![0]),
    /`codex\.command` is deprecated; use `agents\.codex\.bridge_command` instead/,
  );

  const [sigintHandler] = addedProcessListeners("SIGINT", sigintBaseline);
  sigintHandler!();
  assert.equal(await daemonPromise, 0);
});

test("runDaemon still reports real startup failures", async () => {
  mocks.loadWorkflow.mockResolvedValue(await workflowFixture());
  mocks.startObservabilityServer.mockRejectedValue(new Error("listen failed"));

  const sigintBaseline = process.listeners("SIGINT");
  const sigtermBaseline = process.listeners("SIGTERM");

  const result = await runDaemon({
    workflowPath: "WORKFLOW.md",
    once: false,
    dryRun: false,
    tui: false,
    dashboard: true,
    port: 4040,
    logsRoot: null,
    claimStore: { backend: null, path: null, ownerStaleMs: null },
  });

  assert.equal(result, 1);
  assert.equal(
    stderrWriteSpy.mock.calls.some((call) => String(call[0]).includes("listen failed")),
    true,
  );
  assertNoAddedProcessListeners("SIGINT", sigintBaseline);
  assertNoAddedProcessListeners("SIGTERM", sigtermBaseline);
});
