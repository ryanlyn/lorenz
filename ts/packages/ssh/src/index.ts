import path from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { execa } from "execa";

const DEFAULT_SSH_TIMEOUT_MS = 60_000;
const FORCE_KILL_DELAY_MS = 5_000;

export interface SshRunOptions {
  timeoutMs?: number | undefined;
  stderrToStdout?: boolean | undefined;
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

export async function runSsh(
  host: string,
  command: string,
  options: SshRunOptions = {},
): Promise<SshRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error(`invalid_ssh_timeout: ${timeoutMs}`);

  try {
    // Spawn in its own process group (detached) so we can kill the entire group on timeout.
    // execa's built-in timeout only signals the direct child, leaving sub-processes alive
    // with open pipes that block resolution until they exit naturally.
    // SIGTERM first to allow trap handlers / graceful shutdown; SIGKILL after 5s as fallback.
    // TODO - this may not be enough to ensure the remote ssh process cleans up its children
    const subprocess = execa("ssh", sshArgs(host, command), {
      reject: false,
      ...(options.stderrToStdout ? { all: true } : {}),
      stdin: "ignore",
      stripFinalNewline: false,
      detached: true,
    });
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-subprocess.pid!, "SIGTERM");
      } catch {
        /* process already exited */
      }
      forceKillTimer = setTimeout(() => {
        try {
          process.kill(-subprocess.pid!, "SIGKILL");
        } catch {
          /* process already exited */
        }
      }, FORCE_KILL_DELAY_MS);
    }, timeoutMs);
    const result = await subprocess;
    clearTimeout(timer);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    if ((result as { code?: string }).code === "ENOENT") throw new Error("ssh_not_found");
    if (timedOut) throw new Error(`ssh_timeout: ${host} ${timeoutMs}`);
    return {
      stdout: options.stderrToStdout ? (result.all ?? "") : result.stdout,
      stderr: options.stderrToStdout ? "" : result.stderr,
      status: result.exitCode ?? 0,
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
  }) as unknown as ChildProcessWithoutNullStreams;
}

export function startReverseTunnel(
  host: string,
  remotePort: number,
  localHost: string,
  localPort: number,
): ChildProcessWithoutNullStreams {
  return execa("ssh", reverseTunnelArgs(host, remotePort, localHost, localPort), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    reject: false,
  }) as unknown as ChildProcessWithoutNullStreams;
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
    "-o",
    "ExitOnForwardFailure=yes",
    ...(target.port ? ["-p", target.port] : []),
    "-R",
    `${remotePort}:${localHost}:${localPort}`,
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
  if (!match) return { destination: trimmed, port: null };
  const destination = match[1] ?? "";
  const port = match[2] ?? "";
  if (validPortDestination(destination)) return { destination, port };
  return { destination: trimmed, port: null };
}

function sshConfigArgs(): string[] {
  const configPath = process.env.SYMPHONY_SSH_CONFIG;
  return configPath ? ["-F", configPath] : [];
}

function validPortDestination(destination: string): boolean {
  return destination !== "" && (!destination.includes(":") || bracketedHost(destination));
}

function bracketedHost(destination: string): boolean {
  return destination.includes("[") && destination.includes("]");
}

function chmodCommand(mode: number | string | undefined, remotePath: string): string {
  if (typeof mode === "number" && Number.isInteger(mode))
    return `chmod ${mode.toString(8)} ${shellEscape(remotePath)}`;
  if (typeof mode === "string" && mode.trim() !== "")
    return `chmod ${mode} ${shellEscape(remotePath)}`;
  return "true";
}
