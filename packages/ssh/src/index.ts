import path from "node:path";
import { accessSync, constants } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { execa } from "execa";
import { processGroupTerminationAdapter, superviseChild } from "@lorenz/process-supervisor";

const DEFAULT_SSH_TIMEOUT_MS = 60_000;
const DEFAULT_REMOTE_TCP_PORT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_TCP_PORT_READY_INTERVAL_MS = 200;
const DEFAULT_REMOTE_TCP_PORT_READY_ATTEMPT_TIMEOUT_MS = 1_000;
const DEFAULT_REMOTE_TCP_PORT_CLOSED_TIMEOUT_MS = 5_000;
const TCP_PORT_MAX = 65_535;
const NUMERIC_CHMOD_MODE = /^[0-7]{3,4}$/;
const SYMBOLIC_CHMOD_MODE =
  /^(?:[ugoa]*(?:(?:[+-][rwxXstugo]+)|(?:=[rwxXstugo]*)))(?:,(?:[ugoa]*(?:(?:[+-][rwxXstugo]+)|(?:=[rwxXstugo]*))))*$/;

function requireSshExecutable(): string {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const executable = path.join(directory, "ssh");
    try {
      accessSync(executable, constants.X_OK);
      return executable;
    } catch {
      continue;
    }
  }
  throw new Error("ssh_not_found");
}

export interface SshRunOptions {
  timeoutMs?: number | undefined;
  stderrToStdout?: boolean | undefined;
  abortSignal?: AbortSignal | undefined;
  sshExecutablePath?: string | undefined;
}

export interface SshRunResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface SshTarget {
  destination: string;
  port: string | null;
}

interface SshExitMetadata {
  exitCode?: number | undefined;
  signal?: string | undefined;
  signalDescription?: string | undefined;
  isTerminated?: boolean | undefined;
  isForcefullyTerminated?: boolean | undefined;
  killed?: boolean | undefined;
  timedOut?: boolean | undefined;
  isCanceled?: boolean | undefined;
  failed?: boolean | undefined;
}

export interface RemoteTcpPortWaitOptions {
  timeoutMs?: number | undefined;
  intervalMs?: number | undefined;
  attemptTimeoutMs?: number | undefined;
  sshExecutablePath?: string | undefined;
}

export interface ReverseTunnelHandle {
  /** Resolves after explicit close or when an owned tunnel process ends. */
  readonly ended: Promise<void>;
  /** Checks the recorded SSH transport before probing the remote listener. */
  check(): Promise<void>;
  /** Removes the exact remote forward without stopping a shared ControlMaster. */
  close(): Promise<void>;
}

export async function runSsh(
  host: string,
  command: string,
  options: SshRunOptions = {},
): Promise<SshRunResult> {
  return runSshArgs(host, sshArgs(host, command), options);
}

async function runSshArgs(
  host: string,
  args: string[],
  options: SshRunOptions = {},
): Promise<SshRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error(`invalid_ssh_timeout: ${timeoutMs}`);
  if (options.abortSignal?.aborted) throw new Error(`ssh_aborted: ${host}`);

  try {
    const subprocess = execa(options.sshExecutablePath ?? "ssh", args, {
      reject: false,
      ...(options.stderrToStdout ? { all: true } : {}),
      stdin: "ignore",
      stripFinalNewline: false,
      detached: true,
    });
    const result = await superviseChild({
      completion: subprocess,
      termination: processGroupTerminationAdapter(subprocess.pid),
      timeout: {
        afterMs: timeoutMs,
        error: () => new Error(`ssh_timeout: ${host} ${timeoutMs}`),
      },
      ...(options.abortSignal
        ? {
            cancellation: {
              signal: options.abortSignal,
              error: () => new Error(`ssh_aborted: ${host}`),
            },
          }
        : {}),
    });
    if ((result as { code?: string }).code === "ENOENT") throw new Error("ssh_not_found");
    if (typeof result.exitCode !== "number") throw sshMissingExitCodeError(host, result);
    return {
      stdout: options.stderrToStdout ? (result.all ?? "") : result.stdout,
      stderr: options.stderrToStdout ? "" : result.stderr,
      status: result.exitCode,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("ssh_not_found", { cause: error });
    throw error;
  }
}

export function startSshProcess(host: string, command: string): ChildProcessWithoutNullStreams {
  return execa("ssh", sshArgs(host, command), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    reject: false,
    // Callers stream stdout/stderr themselves; buffering would ALSO retain the
    // process's entire lifetime output for a `result` nobody reads - for a
    // remote agent bridge that is the whole session's traffic, an unbounded
    // memory leak in a long-running daemon.
    buffer: false,
  }) as unknown as ChildProcessWithoutNullStreams;
}

export async function startReverseTunnel(
  host: string,
  remotePort: number,
  localHost: string,
  localPort: number,
): Promise<ReverseTunnelHandle> {
  const sshExecutablePath = requireSshExecutable();
  const existingPortState = await remoteTcpPortState(host, remotePort, {
    sshExecutablePath,
    timeoutMs: DEFAULT_REMOTE_TCP_PORT_READY_ATTEMPT_TIMEOUT_MS,
  });
  if (existingPortState === "open") {
    throw new Error(`remote_reverse_tunnel_port_in_use: ${host} ${remotePort}`);
  }

  const existingMaster = await activeControlMaster(host, sshExecutablePath);
  if (existingMaster) {
    const forwarded = await runSshArgs(
      host,
      controlForwardArgs(
        existingMaster.controlPath,
        host,
        "forward",
        remotePort,
        localHost,
        localPort,
      ),
      { sshExecutablePath, stderrToStdout: true },
    );
    if (forwarded.status === 0) {
      const handle = new SshReverseTunnelHandle({
        controlMaster: existingMaster,
        host,
        localHost,
        localPort,
        remotePort,
        sshExecutablePath,
      });
      try {
        await handle.check();
        return handle;
      } catch (error) {
        await cleanupOwnedControlForward(handle, host, remotePort);
        throw error;
      }
    }

    // The master can disappear between check and forward. Fall through to the
    // ordinary ssh path only when a second check confirms that happened; a
    // real forwarding failure on a live master must not be hidden by retrying.
    const masterStillRunning = await controlMasterRunning(existingMaster, host, sshExecutablePath);
    const forwardError = new Error(
      `ssh_control_forward_failed: ${host} ${forwarded.status} ${forwarded.stdout}`,
    );
    if (masterStillRunning) throw forwardError;
    try {
      await waitForRemoteTcpPortClosed(host, remotePort, { sshExecutablePath });
    } catch {
      throw forwardError;
    }
  }

  const subprocess = execa(
    sshExecutablePath,
    reverseTunnelArgs(host, remotePort, localHost, localPort),
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      reject: false,
      // A tunnel lives for hours; buffering would retain its whole lifetime
      // output for a `result` nobody reads.
      buffer: false,
    },
  ) as unknown as ChildProcessWithoutNullStreams;
  // No caller consumes tunnel output. With buffering off, someone must drain
  // the pipes or a chatty ssh (warnings, debug output) eventually fills them
  // and blocks the tunnel; discard the data instead of retaining it.
  subprocess.stdout.resume();
  subprocess.stderr.resume();
  const handle = new SshReverseTunnelHandle({
    child: subprocess,
    host,
    localHost,
    localPort,
    remotePort,
    sshExecutablePath,
  });
  try {
    await handle.check();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function cleanupOwnedControlForward(
  handle: ReverseTunnelHandle,
  host: string,
  remotePort: number,
): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    throw new Error(`ssh_control_forward_cleanup_failed: ${host} ${remotePort}`, {
      cause: error,
    });
  }
}

interface ActiveControlMaster {
  controlPath: string;
  pid: number | null;
}

interface SshReverseTunnelHandleOptions {
  child?: ChildProcessWithoutNullStreams | undefined;
  controlMaster?: ActiveControlMaster | undefined;
  host: string;
  localHost: string;
  localPort: number;
  remotePort: number;
  sshExecutablePath: string;
}

class SshReverseTunnelHandle implements ReverseTunnelHandle {
  readonly ended: Promise<void>;

  private readonly child: ChildProcessWithoutNullStreams | undefined;
  private readonly host: string;
  private readonly localHost: string;
  private readonly localPort: number;
  private readonly remotePort: number;
  private readonly sshExecutablePath: string;
  private controlMaster: ActiveControlMaster | null;
  private childEnded = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private endResolved = false;
  private resolveEnded: () => void = () => {};

  constructor(options: SshReverseTunnelHandleOptions) {
    this.child = options.child;
    this.controlMaster = options.controlMaster ?? null;
    this.host = options.host;
    this.localHost = options.localHost;
    this.localPort = options.localPort;
    this.remotePort = options.remotePort;
    this.sshExecutablePath = options.sshExecutablePath;
    this.ended = new Promise<void>((resolve) => {
      this.resolveEnded = resolve;
    });

    const child = this.child;
    if (child) {
      const onEnd = (): void => {
        if (this.childEnded) return;
        this.childEnded = true;
        this.handleChildEnd();
      };
      child.once("close", onEnd);
      child.once("exit", onEnd);
      child.once("error", onEnd);
    }
  }

  async check(): Promise<void> {
    if (
      this.controlMaster &&
      !(await controlMasterRunning(this.controlMaster, this.host, this.sshExecutablePath))
    ) {
      throw new Error(`ssh_control_master_ended: ${this.host}`);
    }
    if (
      this.child &&
      (this.childEnded || this.child.exitCode !== null || this.child.signalCode !== null)
    ) {
      throw new Error(`reverse_tunnel_process_ended: ${this.host}`);
    }
    const readiness = waitForRemoteTcpPort(this.host, this.remotePort, {
      sshExecutablePath: this.sshExecutablePath,
    });
    if (!this.child) {
      await readiness;
      return;
    }

    await Promise.race([
      readiness,
      this.ended.then(() => {
        throw new Error(`reverse_tunnel_process_ended: ${this.host}`);
      }),
    ]);
    if (this.childEnded || this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error(`reverse_tunnel_process_ended: ${this.host}`);
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const closePromise = this.closeOnce();
    this.closePromise = closePromise;
    try {
      await closePromise;
    } catch (error) {
      if (this.closePromise === closePromise) this.closePromise = null;
      throw error;
    }
  }

  private async liveControlMaster(): Promise<ActiveControlMaster | null> {
    if (
      this.controlMaster &&
      (await controlMasterRunning(this.controlMaster, this.host, this.sshExecutablePath))
    ) {
      return this.controlMaster;
    }
    return null;
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    try {
      const master = await this.liveControlMaster();
      if (master) {
        await runSshArgs(
          this.host,
          controlForwardArgs(
            master.controlPath,
            this.host,
            "cancel",
            this.remotePort,
            this.localHost,
            this.localPort,
          ),
          {
            sshExecutablePath: this.sshExecutablePath,
            stderrToStdout: true,
          },
        );
      } else if (this.child && !this.childEnded) {
        this.child.kill();
      }

      try {
        await waitForRemoteTcpPortClosed(this.host, this.remotePort, {
          sshExecutablePath: this.sshExecutablePath,
        });
      } catch (error) {
        // The direct tunnel process may still be exiting after the first
        // signal. Signal it again, then require positive closure before reuse.
        if (this.child && !this.childEnded) {
          this.child.kill();
          await waitForRemoteTcpPortClosed(this.host, this.remotePort, {
            sshExecutablePath: this.sshExecutablePath,
          });
        } else {
          throw error;
        }
      }
      this.resolveEnd();
    } finally {
      this.closing = false;
    }
  }

  private handleChildEnd(): void {
    if (this.closing) return;
    this.resolveEnd();
  }

  private resolveEnd(): void {
    if (this.endResolved) return;
    this.endResolved = true;
    this.resolveEnded();
  }
}

async function activeControlMaster(
  host: string,
  sshExecutablePath: string,
): Promise<ActiveControlMaster | null> {
  const controlPath = await resolveControlPath(host, sshExecutablePath);
  if (!controlPath) return null;
  const result = await runSshArgs(host, controlCheckArgs(controlPath, host), {
    sshExecutablePath,
    stderrToStdout: true,
  });
  if (result.status !== 0) return null;
  const pidMatch = /Master running \(pid=(\d+)\)/.exec(result.stdout);
  return {
    controlPath,
    pid: pidMatch?.[1] ? Number(pidMatch[1]) : null,
  };
}

async function controlMasterRunning(
  master: ActiveControlMaster,
  host: string,
  sshExecutablePath: string,
): Promise<boolean> {
  const result = await runSshArgs(host, controlCheckArgs(master.controlPath, host), {
    sshExecutablePath,
    stderrToStdout: true,
  });
  if (result.status !== 0) return false;
  if (master.pid === null) return true;
  const pidMatch = /Master running \(pid=(\d+)\)/.exec(result.stdout);
  return pidMatch?.[1] === String(master.pid);
}

async function resolveControlPath(host: string, sshExecutablePath: string): Promise<string | null> {
  const result = await runSshArgs(host, sshConfigQueryArgs(host), {
    sshExecutablePath,
    stderrToStdout: true,
  });
  if (result.status !== 0) return null;
  const configLines = result.stdout.split("\n");
  const controlPathLine = configLines.find((line) => line.toLowerCase().startsWith("controlpath "));
  const controlPath = controlPathLine?.slice("controlpath ".length).trim();
  return controlPath && controlPath !== "none" ? controlPath : null;
}

function sshConfigQueryArgs(host: string): string[] {
  const target = parseSshTarget(host);
  return [
    ...sshConfigArgs(),
    "-T",
    "-G",
    ...(target.port ? ["-p", target.port] : []),
    "--",
    target.destination,
  ];
}

function controlCheckArgs(controlPath: string, host: string): string[] {
  const target = parseSshTarget(host);
  return ["-F", "none", "-S", controlPath, "-O", "check", "--", target.destination];
}

function controlForwardArgs(
  controlPath: string,
  host: string,
  operation: "forward" | "cancel",
  remotePort: number,
  localHost: string,
  localPort: number,
): string[] {
  const target = parseSshTarget(host);
  return [
    "-F",
    "none",
    "-S",
    controlPath,
    "-O",
    operation,
    "-R",
    `${remotePort}:${localHost}:${localPort}`,
    "--",
    target.destination,
  ];
}

export async function waitForRemoteTcpPort(
  host: string,
  remotePort: number,
  options: RemoteTcpPortWaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_TCP_PORT_READY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_REMOTE_TCP_PORT_READY_INTERVAL_MS;
  const attemptTimeoutMs =
    options.attemptTimeoutMs ?? DEFAULT_REMOTE_TCP_PORT_READY_ATTEMPT_TIMEOUT_MS;
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > TCP_PORT_MAX) {
    throw new Error(`invalid_remote_tcp_port: ${remotePort}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid_remote_tcp_port_ready_timeout: ${timeoutMs}`);
  }
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error(`invalid_remote_tcp_port_ready_interval: ${intervalMs}`);
  }
  if (!Number.isInteger(attemptTimeoutMs) || attemptTimeoutMs <= 0) {
    throw new Error(`invalid_remote_tcp_port_ready_attempt_timeout: ${attemptTimeoutMs}`);
  }

  const deadline = Date.now() + timeoutMs;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    try {
      const result = await runSsh(host, `: < /dev/tcp/127.0.0.1/${remotePort}`, {
        stderrToStdout: true,
        sshExecutablePath: options.sshExecutablePath,
        timeoutMs: Math.min(attemptTimeoutMs, remainingMs),
      });
      if (result.status === 0) return;
      lastFailure = new Error(`remote_tcp_probe_status: ${result.status} ${result.stdout}`);
    } catch (error) {
      lastFailure = error;
    }

    const sleepMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (sleepMs > 0) await delay(sleepMs);
  }
  throw new Error(`remote_tcp_port_unreachable: ${host} ${remotePort}`, {
    cause: lastFailure,
  });
}

export async function waitForRemoteTcpPortClosed(
  host: string,
  remotePort: number,
  options: RemoteTcpPortWaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_TCP_PORT_CLOSED_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_REMOTE_TCP_PORT_READY_INTERVAL_MS;
  const attemptTimeoutMs =
    options.attemptTimeoutMs ?? DEFAULT_REMOTE_TCP_PORT_READY_ATTEMPT_TIMEOUT_MS;
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > TCP_PORT_MAX) {
    throw new Error(`invalid_remote_tcp_port: ${remotePort}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid_remote_tcp_port_closed_timeout: ${timeoutMs}`);
  }
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error(`invalid_remote_tcp_port_closed_interval: ${intervalMs}`);
  }
  if (!Number.isInteger(attemptTimeoutMs) || attemptTimeoutMs <= 0) {
    throw new Error(`invalid_remote_tcp_port_closed_attempt_timeout: ${attemptTimeoutMs}`);
  }

  const deadline = Date.now() + timeoutMs;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    try {
      const state = await remoteTcpPortState(host, remotePort, {
        sshExecutablePath: options.sshExecutablePath,
        timeoutMs: Math.min(attemptTimeoutMs, remainingMs),
      });
      if (state === "closed") return;
      lastFailure = new Error(`remote_tcp_port_still_reachable: ${host} ${remotePort}`);
    } catch (error) {
      lastFailure = error;
    }

    const sleepMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (sleepMs > 0) await delay(sleepMs);
  }
  throw new Error(`remote_tcp_port_still_reachable: ${host} ${remotePort}`, {
    cause: lastFailure,
  });
}

type RemoteTcpPortState = "open" | "closed";

async function remoteTcpPortState(
  host: string,
  remotePort: number,
  options: Pick<RemoteTcpPortWaitOptions, "sshExecutablePath"> & { timeoutMs: number },
): Promise<RemoteTcpPortState> {
  const closedMarker = "__LORENZ_REMOTE_PORT_CLOSED__";
  const openMarker = "__LORENZ_REMOTE_PORT_OPEN__";
  const command =
    `if : < /dev/tcp/127.0.0.1/${remotePort} 2>/dev/null; ` +
    `then printf ${shellEscape(openMarker)}; else printf ${shellEscape(closedMarker)}; fi`;
  const result = await runSsh(host, command, {
    sshExecutablePath: options.sshExecutablePath,
    timeoutMs: options.timeoutMs,
  });
  if (result.status !== 0) {
    throw new Error(`remote_tcp_port_probe_failed: ${host} ${remotePort} ${result.status}`, {
      cause: result,
    });
  }
  if (result.stdout.includes(openMarker)) return "open";
  if (result.stdout.includes(closedMarker)) return "closed";
  throw new Error(`remote_tcp_port_probe_invalid: ${host} ${remotePort}`);
}

export async function writeRemoteFile(
  host: string,
  remotePath: string,
  contents: string,
  options: SshRunOptions & { mode?: number | string | undefined } = {},
): Promise<void> {
  const command = [
    `mkdir -p ${shellEscape(path.posix.dirname(remotePath))}`,
    `printf '%s' ${shellEscape(contents)} > ${shellEscape(remotePath)}`,
    chmodCommand(options.mode, remotePath),
  ].join("\n");
  const result = await runSsh(host, command, { ...options, stderrToStdout: true });
  if (result.status !== 0)
    throw new Error(`remote_write_failed: ${result.status} ${result.stdout}`);
}

export function sshArgs(host: string, command: string): string[] {
  const target = parseSshTarget(host);
  return [
    ...sshConfigArgs(),
    "-T",
    ...(target.port ? ["-p", target.port] : []),
    "--",
    target.destination,
    remoteShellCommand(command),
  ];
}

export function reverseTunnelArgs(
  host: string,
  remotePort: number,
  localHost: string,
  localPort: number,
): string[] {
  const target = parseSshTarget(host);
  return [
    ...sshConfigArgs(),
    "-T",
    "-N",
    "-S",
    "none",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ExitOnForwardFailure=yes",
    ...(target.port ? ["-p", target.port] : []),
    "-R",
    `${remotePort}:${localHost}:${localPort}`,
    "--",
    target.destination,
  ];
}

export function remoteShellCommand(command: string): string {
  return `bash -lc ${shellEscape(command)}`;
}

export function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function parseSshTarget(target: string): SshTarget {
  const trimmed = target.trim();
  const match = /^(.*):(\d+)$/.exec(trimmed);
  if (!match) return { destination: validateSshDestination(trimmed), port: null };
  const destination = match[1] ?? "";
  const port = match[2] ?? "";
  if (validPortDestination(destination))
    return { destination: validateSshDestination(destination), port };
  return { destination: validateSshDestination(trimmed), port: null };
}

function sshMissingExitCodeError(host: string, result: SshExitMetadata): Error {
  const killed = result.killed ?? result.isTerminated ?? result.isForcefullyTerminated ?? false;
  const metadata = [
    `signal=${result.signal ?? "none"}`,
    result.signalDescription
      ? `signalDescription=${JSON.stringify(result.signalDescription)}`
      : null,
    `terminated=${Boolean(result.isTerminated)}`,
    `killed=${Boolean(killed)}`,
    `forcefullyTerminated=${Boolean(result.isForcefullyTerminated)}`,
    `timedOut=${Boolean(result.timedOut)}`,
    `canceled=${Boolean(result.isCanceled)}`,
    `failed=${Boolean(result.failed)}`,
  ].filter((entry) => entry !== null);

  return new Error(`ssh_failed_without_exit_code: ${host} ${metadata.join(" ")}`, {
    cause: result,
  });
}

function sshConfigArgs(): string[] {
  const configPath = process.env.LORENZ_SSH_CONFIG;
  return configPath ? ["-F", configPath] : [];
}

function validPortDestination(destination: string): boolean {
  return destination !== "" && (!destination.includes(":") || bracketedHost(destination));
}

function validateSshDestination(destination: string): string {
  if (destination === "" || destination.startsWith("-"))
    throw new Error(`invalid_ssh_destination: ${destination}`);
  return destination;
}

function bracketedHost(destination: string): boolean {
  return destination.includes("[") && destination.includes("]");
}

function chmodCommand(mode: number | string | undefined, remotePath: string): string {
  if (typeof mode === "number" && Number.isInteger(mode))
    return `chmod ${mode.toString(8)} ${shellEscape(chmodPathOperand(remotePath))}`;
  if (typeof mode === "string") {
    const normalizedMode = normalizeChmodMode(mode);
    if (normalizedMode !== "")
      return `chmod ${shellEscape(normalizedMode)} ${shellEscape(chmodPathOperand(remotePath))}`;
  }
  return "true";
}

function normalizeChmodMode(mode: string): string {
  const trimmed = mode.trim();
  if (trimmed === "") return "";
  if (trimmed !== mode || !validChmodMode(trimmed))
    throw new Error(`invalid_chmod_mode: ${JSON.stringify(mode)}`);
  return trimmed;
}

function validChmodMode(mode: string): boolean {
  return NUMERIC_CHMOD_MODE.test(mode) || SYMBOLIC_CHMOD_MODE.test(mode);
}

function chmodPathOperand(remotePath: string): string {
  return remotePath.startsWith("-") ? `./${remotePath}` : remotePath;
}
