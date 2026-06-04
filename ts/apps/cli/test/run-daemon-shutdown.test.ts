import path from "node:path";

import { parseConfig } from "@symphony/config";
import { afterEach, beforeEach, test, vi } from "vitest";

import { assert } from "../../../test/assert.js";
import { tempDir } from "../../../test/helpers.js";

const mocks = vi.hoisted(() => ({
  loadWorkflow: vi.fn(),
  configureLogFile: vi.fn(async () => {}),
  startObservabilityServer: vi.fn(),
  render: vi.fn(),
  createTrackerClient: vi.fn(),
  runAgentAttempt: vi.fn(),
  runtimeDefaultSettingsOptions: vi.fn(() => ({})),
  runtimeInstances: [] as Array<FakeRuntime>,
}));

class FakeRuntime {
  public readonly stop = vi.fn(() => {
    this.stopResolver?.();
  });

  public readonly subscribe = vi.fn();

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

vi.mock("@symphony/workflow", () => ({
  loadWorkflow: mocks.loadWorkflow,
}));

vi.mock("@symphony/log-file", () => ({
  configureLogFile: mocks.configureLogFile,
}));

vi.mock("@symphony/server", () => ({
  startObservabilityServer: mocks.startObservabilityServer,
}));

vi.mock("ink", () => ({
  render: mocks.render,
}));

vi.mock("@symphony/runtime", () => ({
  SymphonyRuntime: FakeRuntime,
}));

vi.mock("@symphony/traceviz-emitter", () => ({
  TraceEmitter: class {
    public readonly emit = vi.fn();
  },
}));

vi.mock("../src/daemon.js", () => ({
  createTrackerClient: mocks.createTrackerClient,
  runAgentAttempt: mocks.runAgentAttempt,
  runtimeAdapters: {},
  runtimeDefaultSettingsOptions: mocks.runtimeDefaultSettingsOptions,
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

async function workflowFixture() {
  const root = await tempDir("symphony-cli-shutdown");
  const settings = parseConfig(
    {
      tracker: {
        kind: "local",
        path: path.join(root, ".symphony/local"),
        active_states: ["Todo", "In Progress"],
        terminal_states: ["Done"],
      },
      workspace: { root },
      logging: { log_file: path.join(root, "log", "symphony.log") },
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

  process.off("SIGINT", sigintHandler as ProcessListener);
  for (const handler of sigtermHandlers) {
    process.off("SIGTERM", handler as ProcessListener);
  }
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

  for (const handler of addedProcessListeners("SIGINT", sigintBaseline)) {
    process.off("SIGINT", handler as ProcessListener);
  }
  for (const handler of addedProcessListeners("SIGTERM", sigtermBaseline)) {
    process.off("SIGTERM", handler as ProcessListener);
  }
});
