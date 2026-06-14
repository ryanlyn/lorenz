import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, test, vi } from "vitest";
import { assert, tempDir, writeExecutable } from "@symphony/test-utils";

import {
  main,
  parseDoctorArgs,
  renderDoctorReport,
  runDoctorCommand,
  runDoctorMain,
} from "@symphony/cli";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("doctor command parses workflow path and local options", () => {
  assert.deepEqual(parseDoctorArgs(["--no-dashboard", "WORKFLOW.md"]), {
    status: "ok",
    options: {
      workflowPath: "WORKFLOW.md",
      dashboard: false,
      logsRoot: null,
    },
  });
  assert.deepEqual(parseDoctorArgs(["--logs-root", "tmp/custom-logs"]), {
    status: "ok",
    options: {
      workflowPath: null,
      dashboard: true,
      logsRoot: "tmp/custom-logs",
    },
  });
});

test("doctor command reports help and invalid arguments", () => {
  const help = parseDoctorArgs(["--help"]);
  assert.equal(help.status, "help");
  assert.match(help.message, /Usage: symphony-ts doctor \[options\] \[workflowPath\]/);
  assert.match(help.message, /--no-dashboard/);
  assert.deepEqual(parseDoctorArgs(["one.md", "two.md"]), {
    status: "error",
    message: "error: too many arguments. Expected 1 argument but got 2.",
  });
  assert.deepEqual(parseDoctorArgs(["--logs-root"]), {
    status: "error",
    message: "--logs-root requires a path",
  });
});

test("doctor uses default workflow resolution and reports healthy local checks", async () => {
  const fixture = await doctorFixture({ withDashboard: true });
  vi.stubEnv("SYMPHONY_WORKFLOW", fixture.workflowPath);

  const report = await runDoctorCommand({
    workflowPath: null,
    dashboard: true,
    logsRoot: null,
  });

  assert.equal(report.status, "ok");
  assert.equal(report.workflowPath, fixture.workflowPath);
  assert.equal(statusFor(report, "workflow_file"), "ok");
  assert.equal(statusFor(report, "workflow_load"), "ok");
  assert.equal(statusFor(report, "dispatch_config"), "ok");
  assert.equal(statusFor(report, "dashboard_assets"), "ok");
  assert.equal(statusFor(report, "log_path"), "ok");
  assert.equal(statusFor(report, "agent_bridge_codex"), "ok");
});

test("doctor renders a text report via runDoctorMain", async () => {
  const fixture = await doctorFixture({ withDashboard: true });
  const output = await runDoctorMain([fixture.workflowPath]);

  assert.match(output, /^Symphony doctor$/m);
  assert.match(output, /^status=ok$/m);
  assert.equal(output.includes(`workflow=${fixture.workflowPath}`), true);
});

test("doctor returns warnings without failing the CLI process", async () => {
  const fixture = await doctorFixture({
    withDashboard: false,
    bridgeCommand: "missing-symphony-test-acp",
  });
  const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  try {
    assert.equal(await main(["doctor", fixture.workflowPath]), 0);
    const output = spy.mock.calls.map((call) => String(call[0])).join("");
    assert.match(output, /status=warning/);
    assert.match(output, /dashboard_assets/);
    assert.match(output, /agent_bridge_codex/);
  } finally {
    spy.mockRestore();
  }
});

test("doctor checks status override bridge commands for the active agent", async () => {
  const fixture = await doctorFixture({
    withDashboard: true,
    statusOverrideBridgeCommand: "missing-symphony-status-acp",
  });

  const report = await runDoctorCommand({
    workflowPath: fixture.workflowPath,
    dashboard: true,
    logsRoot: null,
  });

  assert.equal(report.status, "warning");
  assert.equal(statusFor(report, "agent_bridge_codex"), "ok");
  assert.equal(statusFor(report, "agent_bridge_codex_todo"), "warning");
  assert.match(
    messageFor(report, "agent_bridge_codex_todo"),
    /Agent bridge command was not found for codex in todo/,
  );
});

test("doctor checks node bridge target files", async () => {
  const root = await tempDir("symphony-ts-doctor-node-bridge");
  const missingTarget = path.join(root, "missing-bridge.js");
  const fixture = await doctorFixture({
    withDashboard: true,
    bridgeCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(missingTarget)}`,
  });

  const report = await runDoctorCommand({
    workflowPath: fixture.workflowPath,
    dashboard: true,
    logsRoot: null,
  });

  assert.equal(report.status, "warning");
  assert.equal(statusFor(report, "agent_bridge_codex"), "warning");
  assert.match(
    messageFor(report, "agent_bridge_codex"),
    /Agent bridge target was not readable for codex/,
  );
});

test("doctor checks env-wrapped bridge commands", async () => {
  const fixture = await doctorFixture({
    withDashboard: true,
    bridgeCommand: 'env CODEX_PATH="$(command -v codex)" missing-symphony-env-acp',
  });

  const report = await runDoctorCommand({
    workflowPath: fixture.workflowPath,
    dashboard: true,
    logsRoot: null,
  });

  assert.equal(report.status, "warning");
  assert.equal(statusFor(report, "agent_bridge_codex"), "warning");
  assert.match(
    messageFor(report, "agent_bridge_codex"),
    /Agent bridge command was not found for codex: missing-symphony-env-acp/,
  );
});

test("doctor warns when remote worker bridge commands are not checked", async () => {
  const fixture = await doctorFixture({
    withDashboard: true,
    workerSshHosts: ["worker.example"],
  });

  const report = await runDoctorCommand({
    workflowPath: fixture.workflowPath,
    dashboard: true,
    logsRoot: null,
  });

  assert.equal(report.status, "warning");
  assert.equal(statusFor(report, "agent_bridge"), "warning");
  assert.match(messageFor(report, "agent_bridge"), /not checked over SSH/);
});

test("doctor verifies the underlying agent CLI is discoverable on PATH", async () => {
  const binDir = path.join(await tempDir("symphony-ts-doctor-cli-found"), "bin");
  await writeExecutable(path.join(binDir, "codex"), "#!/usr/bin/env bash\nexit 0\n");
  const fixture = await doctorFixture({ withDashboard: true, bridgeCommand: "codex-acp" });

  const report = await runDoctorCommand(
    { workflowPath: fixture.workflowPath, dashboard: true, logsRoot: null },
    { env: { PATH: binDir } },
  );

  assert.equal(statusFor(report, "agent_cli_codex"), "ok");
  assert.match(messageFor(report, "agent_cli_codex"), /Agent CLI is available: codex/);
});

test("doctor warns when the underlying agent CLI is missing", async () => {
  const emptyBin = path.join(await tempDir("symphony-ts-doctor-cli-missing"), "bin");
  await fs.mkdir(emptyBin, { recursive: true });
  const fixture = await doctorFixture({ withDashboard: true, bridgeCommand: "claude-agent-acp" });

  const report = await runDoctorCommand(
    { workflowPath: fixture.workflowPath, dashboard: true, logsRoot: null },
    { env: { PATH: emptyBin } },
  );

  assert.equal(report.status, "warning");
  assert.equal(statusFor(report, "agent_cli_claude"), "warning");
  assert.match(
    messageFor(report, "agent_cli_claude"),
    /Agent CLI was not found on PATH: claude\. Install it or set CLAUDE_CODE_EXECUTABLE/,
  );
});

test("doctor honors CODEX_PATH when locating the codex CLI", async () => {
  const root = await tempDir("symphony-ts-doctor-codex-path");
  const emptyBin = path.join(root, "empty-bin");
  await fs.mkdir(emptyBin, { recursive: true });
  const codexBinary = path.join(root, "tools", "codex-real");
  await writeExecutable(codexBinary, "#!/usr/bin/env bash\nexit 0\n");
  const fixture = await doctorFixture({ withDashboard: true, bridgeCommand: "codex-acp" });

  const report = await runDoctorCommand(
    { workflowPath: fixture.workflowPath, dashboard: true, logsRoot: null },
    { env: { PATH: emptyBin, CODEX_PATH: codexBinary } },
  );

  assert.equal(statusFor(report, "agent_cli_codex"), "ok");
  assert.equal(messageFor(report, "agent_cli_codex").includes(codexBinary), true);
});

test("doctor does not treat directories as executable bridge commands", async () => {
  const root = await tempDir("symphony-ts-doctor-directory-bridge");
  const bridgeDirectory = path.join(root, "bridge-dir");
  await fs.mkdir(bridgeDirectory);
  const fixture = await doctorFixture({
    withDashboard: true,
    bridgeCommand: bridgeDirectory,
  });

  const report = await runDoctorCommand({
    workflowPath: fixture.workflowPath,
    dashboard: true,
    logsRoot: null,
  });

  assert.equal(report.status, "warning");
  assert.equal(statusFor(report, "agent_bridge_codex"), "warning");
  assert.match(
    messageFor(report, "agent_bridge_codex"),
    /Agent bridge command was not found for codex/,
  );
});

test("doctor checks dashboard assets whenever the CLI dashboard would start", async () => {
  const fixture = await doctorFixture({
    withDashboard: false,
    observabilityDashboardEnabled: false,
  });

  const report = await runDoctorCommand({
    workflowPath: fixture.workflowPath,
    dashboard: true,
    logsRoot: null,
  });

  assert.equal(report.status, "warning");
  assert.equal(statusFor(report, "dashboard_assets"), "warning");
  assert.match(messageFor(report, "dashboard_assets"), /Dashboard static assets are not available/);
});

test("doctor warns when the log path crosses a non-directory ancestor", async () => {
  const root = await tempDir("symphony-ts-doctor-log-path");
  const fileAncestor = path.join(root, "not-a-directory");
  await fs.writeFile(fileAncestor, "not a directory\n");
  const fixture = await doctorFixture({
    withDashboard: true,
  });

  const report = await runDoctorCommand({
    workflowPath: fixture.workflowPath,
    dashboard: true,
    logsRoot: fileAncestor,
  });

  assert.equal(report.status, "warning");
  assert.equal(statusFor(report, "log_path"), "warning");
  assert.match(messageFor(report, "log_path"), /Log path ancestor exists but is not a directory/);
});

test("doctor marks dispatch validation failures as fatal", async () => {
  const fixture = await doctorFixture({ trackerKind: "not-a-tracker", withDashboard: true });

  const report = await runDoctorCommand({
    workflowPath: fixture.workflowPath,
    dashboard: true,
    logsRoot: null,
  });

  assert.equal(report.status, "error");
  assert.equal(statusFor(report, "dispatch_config"), "error");
  assert.match(renderDoctorReport(report), /unsupported tracker\.kind/);
});

async function doctorFixture(options: {
  bridgeCommand?: string;
  observabilityDashboardEnabled?: boolean;
  statusOverrideBridgeCommand?: string;
  trackerKind?: string;
  workerSshHosts?: string[];
  withDashboard: boolean;
}): Promise<{ workflowPath: string }> {
  const root = await tempDir("symphony-ts-doctor");
  const workflowPath = path.join(root, "WORKFLOW.md");
  const boardDir = path.join(root, "board");
  const logFile = path.join(root, "log", "symphony.log");
  const dashboardDir = path.join(root, "dashboard");
  const bridgeCommand = options.bridgeCommand ?? path.join(root, "bin", "test-acp");
  if (options.bridgeCommand === undefined) {
    await writeExecutable(bridgeCommand, "#!/usr/bin/env bash\nexit 0\n");
  }
  if (options.withDashboard) {
    await fs.mkdir(path.join(dashboardDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(dashboardDir, "index.html"), "<div>dashboard</div>");
  }
  await fs.writeFile(
    workflowPath,
    [
      "---",
      "tracker:",
      `  kind: ${JSON.stringify(options.trackerKind ?? "local")}`,
      `  path: ${JSON.stringify(boardDir)}`,
      "  active_states:",
      "    - Todo",
      "  terminal_states:",
      "    - Done",
      "agents:",
      "  codex:",
      `    bridge_command: ${JSON.stringify(bridgeCommand)}`,
      ...(options.statusOverrideBridgeCommand === undefined
        ? []
        : [
            "status_overrides:",
            "  Todo:",
            "    agents:",
            "      codex:",
            `        bridge_command: ${JSON.stringify(options.statusOverrideBridgeCommand)}`,
          ]),
      ...(options.observabilityDashboardEnabled === undefined
        ? []
        : [
            "observability:",
            `  dashboard_enabled: ${JSON.stringify(options.observabilityDashboardEnabled)}`,
          ]),
      ...(options.workerSshHosts === undefined
        ? []
        : ["worker:", `  ssh_hosts: ${JSON.stringify(options.workerSshHosts)}`]),
      "logging:",
      `  log_file: ${JSON.stringify(logFile)}`,
      "server:",
      `  staticDir: ${JSON.stringify(dashboardDir)}`,
      "---",
      "Handle {{ issue.identifier }}",
      "",
    ].join("\n"),
  );
  return { workflowPath };
}

function statusFor(report: { checks: Array<{ id: string; status: string }> }, id: string): string {
  const check = report.checks.find((candidate) => candidate.id === id);
  if (!check) throw new Error(`missing doctor check ${id}`);
  return check.status;
}

function messageFor(
  report: { checks: Array<{ id: string; message: string }> },
  id: string,
): string {
  const check = report.checks.find((candidate) => candidate.id === id);
  if (!check) throw new Error(`missing doctor check ${id}`);
  return check.message;
}
