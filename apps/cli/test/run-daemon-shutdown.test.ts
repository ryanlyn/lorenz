import path from "node:path";

import { parseConfig } from "@lorenz/config";
import { afterEach, beforeEach, test, vi } from "vitest";
import { assert, tempDir } from "@lorenz/test-utils";

import type * as daemonModule from "../src/daemon.js";

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
  runtimeAdapters: () => ({}),
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

  return {
    path: path.join(root, "WORKFLOW.md"),
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
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const runtime = mocks.runtimeInstances[0];
    if (runtime) return runtime;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("runtime instance was not created");
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
  });

  assert.equal(result, 1);
  assert.equal(
    stderrWriteSpy.mock.calls.some((call) => String(call[0]).includes("listen failed")),
    true,
  );
  assertNoAddedProcessListeners("SIGINT", sigintBaseline);
  assertNoAddedProcessListeners("SIGTERM", sigtermBaseline);
});
