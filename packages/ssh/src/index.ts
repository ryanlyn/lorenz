import path from "node:path";
import { accessSync, constants } from "node:fs";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { execa } from "execa";

const DEFAULT_SSH_TIMEOUT_MS = 60_000;
const FORCE_KILL_DELAY_MS = 5_000;
const DEFAULT_REMOTE_TCP_PORT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_TCP_PORT_READY_INTERVAL_MS = 200;
const DEFAULT_REMOTE_TCP_PORT_READY_ATTEMPT_TIMEOUT_MS = 1_000;
const TCP_PORT_MAX = 65_535;
const NUMERIC_CHMOD_MODE = /^[0-7]{3,4}$/;
const SYMBOLIC_CHMOD_MODE =
  /^(?:[ugoa]*(?:(?:[+-][rwxXstugo]+)|(?:=[rwxXstugo]*)))(?:,(?:[ugoa]*(?:(?:[+-][rwxXstugo]+)|(?:=[rwxXstugo]*))))*$/;

function requireSshExecutable(env: NodeJS.ProcessEnv): string {
  const pathValue = env.PATH ?? "";
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
  /** Environment the ssh invocation reads PATH (binary discovery) and LORENZ_SSH_CONFIG from. */
  env: NodeJS.ProcessEnv;
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
  /** Environment the underlying ssh probe reads PATH and LORENZ_SSH_CONFIG from. */
  env: NodeJS.ProcessEnv;
  timeoutMs?: number | undefined;
  intervalMs?: number | undefined;
  attemptTimeoutMs?: number | undefined;
  sshExecutablePath?: string | undefined;
}

export async function runSsh(
  host: string,
  command: string,
  options: SshRunOptions,
): Promise<SshRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error(`invalid_ssh_timeout: ${timeoutMs}`);
  if (options.abortSignal?.aborted) throw new Error(`ssh_aborted: ${host}`);

  try {
    // Spawn in its own process group (detached) so we can kill the entire group on timeout.
    // execa's built-in timeout only signals the direct child, leaving sub-processes alive
    // with open pipes that block resolution until they exit naturally.
    // SIGTERM first to allow trap handlers / graceful shutdown; SIGKILL after 5s as fallback.
    // TODO - this may not be enough to ensure the remote ssh process cleans up its children
    const subprocess = execa(
      options.sshExecutablePath ?? "ssh",
      sshArgs(host, command, options.env),
      {
        reject: false,
        ...(options.stderrToStdout ? { all: true } : {}),
        stdin: "ignore",
        stripFinalNewline: false,
        detached: true,
      },
    );
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationRequested = false;
    let abortHandler: (() => void) | undefined;

    const killProcessGroup = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-subprocess.pid!, signal);
      } catch {
        /* process already exited */
      }
    };

    const forceKillProcessGroup = (): void => {
      forceKillTimer ??= setTimeout(() => {
        killProcessGroup("SIGKILL");
      }, FORCE_KILL_DELAY_MS);
    };

    const clearTimers = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      // After timeout, descendants can still hold inherited pipes open even if the direct child exits.
      if (!terminationRequested && forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (abortHandler) options.abortSignal?.removeEventListener("abort", abortHandler);
    };

    const clearForceKillTimer = (): void => {
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    };

    const terminate = (error: Error, reject: (reason: Error) => void): void => {
      terminationRequested = true;
      killProcessGroup("SIGTERM");
      forceKillProcessGroup();
      reject(error);
    };

    const timeout = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        terminate(new Error(`ssh_timeout: ${host} ${timeoutMs}`), reject);
      }, timeoutMs);
    });
    const abort = new Promise<never>((_, reject) => {
      if (!options.abortSignal) return;
      abortHandler = () => terminate(new Error(`ssh_aborted: ${host}`), reject);
      options.abortSignal.addEventListener("abort", abortHandler, { once: true });
    });

    void subprocess.then(clearForceKillTimer, clearForceKillTimer);

    const result = await Promise.race([subprocess, timeout, abort]).finally(clearTimers);
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

export function startSshProcess(
  host: string,
  command: string,
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  return execa("ssh", sshArgs(host, command, env), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    reject: false,
  }) as unknown as ChildProcessWithoutNullStreams;
}

export function startReverseTunnel(
  host: string,
  remotePort: number,
  localHost: string,
  localPort: number,
  env: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  return execa(
    requireSshExecutable(env),
    reverseTunnelArgs(host, remotePort, localHost, localPort, env),
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      reject: false,
    },
  ) as unknown as ChildProcessWithoutNullStreams;
}

export async function waitForRemoteTcpPort(
  host: string,
  remotePort: number,
  options: RemoteTcpPortWaitOptions,
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
        env: options.env,
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

export async function writeRemoteFile(
  host: string,
  remotePath: string,
  contents: string,
  options: SshRunOptions & { mode?: number | string | undefined },
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

export function sshArgs(host: string, command: string, env: NodeJS.ProcessEnv): string[] {
  const target = parseSshTarget(host);
  return [
    ...sshConfigArgs(env),
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
  env: NodeJS.ProcessEnv,
): string[] {
  const target = parseSshTarget(host);
  return [
    ...sshConfigArgs(env),
    "-T",
    "-N",
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

function sshConfigArgs(env: NodeJS.ProcessEnv): string[] {
  const configPath = env.LORENZ_SSH_CONFIG;
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
