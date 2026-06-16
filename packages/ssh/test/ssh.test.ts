import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

// Tests mutate process.env.PATH and process.env.LORENZ_SSH_CONFIG to inject fake
// ssh binaries and config. This requires sequential execution (enforced by the root
// vitest.config.ts `sequence: { concurrent: false }`). The afterEach hook guarantees
// env restoration even when assertions fail mid-test.
import { afterEach, beforeEach, test } from "vitest";
import { assert, tempDir, writeExecutable } from "@lorenz/test-utils";

import {
  parseSshTarget,
  remoteShellCommand,
  reverseTunnelArgs,
  runSsh,
  shellEscape,
  sshArgs,
  waitForRemoteTcpPort,
  writeRemoteFile,
} from "@lorenz/ssh";

let savedEnv: { PATH: string | undefined; LORENZ_SSH_CONFIG: string | undefined };

beforeEach(() => {
  savedEnv = {
    PATH: process.env.PATH,
    LORENZ_SSH_CONFIG: process.env.LORENZ_SSH_CONFIG,
  };
});

afterEach(() => {
  restoreEnv("PATH", savedEnv.PATH);
  restoreEnv("LORENZ_SSH_CONFIG", savedEnv.LORENZ_SSH_CONFIG);
});

test("SSH target parsing and command args match host:port behavior", () => {
  assert.deepEqual(parseSshTarget("localhost:2222"), { destination: "localhost", port: "2222" });
  assert.deepEqual(parseSshTarget("root@127.0.0.1:2200"), {
    destination: "root@127.0.0.1",
    port: "2200",
  });
  assert.deepEqual(parseSshTarget("root@[::1]:2200"), { destination: "root@[::1]", port: "2200" });
  assert.deepEqual(parseSshTarget("::1:2200"), { destination: "::1:2200", port: null });
  assert.equal(remoteShellCommand("printf 'hello'"), "bash -lc 'printf '\"'\"'hello'\"'\"''");
  assert.deepEqual(sshArgs("localhost:2222", "echo ready"), [
    "-T",
    "-p",
    "2222",
    "--",
    "localhost",
    "bash -lc 'echo ready'",
  ]);
  assert.deepEqual(reverseTunnelArgs("localhost:2222", 9000, "127.0.0.1", 4040), [
    "-T",
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-p",
    "2222",
    "-R",
    "9000:127.0.0.1:4040",
    "--",
    "localhost",
  ]);
});

test("SSH args reject empty and option-like targets", () => {
  const unsafeTargets = ["", "   ", "-oProxyCommand=touch /tmp/pwned", "--"];

  for (const target of unsafeTargets) {
    assert.throws(() => sshArgs(target, "echo ready"), /invalid_ssh_destination/);
    assert.throws(
      () => reverseTunnelArgs(target, 9000, "127.0.0.1", 4040),
      /invalid_ssh_destination/,
    );
  }
});

test("SSH run honors LORENZ_SSH_CONFIG, stderr folding, missing ssh, and timeouts", async () => {
  const root = await tempDir("lorenz-ssh");
  const trace = path.join(root, "ssh.trace");

  await installFakeSsh(
    root,
    trace,
    `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> ${shellEscape(trace)}
printf 'out\\n'
printf 'err\\n' >&2
exit 7
`,
  );
  process.env.LORENZ_SSH_CONFIG = "/tmp/lorenz-test-ssh-config";

  const result = await runSsh("localhost:2222", "echo ready", { stderrToStdout: true });
  assert.equal(result.status, 7);
  assert.equal(result.stdout, "out\nerr\n");
  assert.equal(result.stderr, "");
  const traceText = await fs.readFile(trace, "utf8");
  assert.match(traceText, /-F \/tmp\/lorenz-test-ssh-config -T -p 2222 -- localhost bash -lc/);
  assert.match(traceText, /echo ready/);

  const emptyPath = await tempDir("lorenz-ssh-empty-path");
  process.env.PATH = emptyPath;
  await assert.rejects(() => runSsh("localhost", "printf ok"), /ssh_not_found/);

  process.env.PATH = savedEnv.PATH!;
  await installFakeSsh(
    root,
    trace,
    `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> ${shellEscape(trace)}
sleep 1
exit 0
`,
  );
  await assert.rejects(
    () => runSsh("localhost", "printf ok", { timeoutMs: 20 }),
    /ssh_timeout: localhost 20/,
  );
});

test("SSH timeout rejects near the caller deadline when a child keeps pipes open", async () => {
  const root = await tempDir("lorenz-ssh-timeout");
  const trace = path.join(root, "ssh.trace");

  await installFakeSsh(
    root,
    trace,
    `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> ${shellEscape(trace)}
# A TERM-ignoring child that holds the pipes open. Plain sh: spawning node
# here can outlast the ssh timeout on a loaded machine, killing the script
# before it records CHILD and flaking the test.
sh -c 'trap "" TERM; while :; do sleep 1; done' &
child="$!"
printf 'CHILD:%s\\n' "$child" >> ${shellEscape(trace)}
wait "$child"
`,
  );

  const started = performance.now();
  await assert.rejects(
    () => runSsh("localhost", "printf ok", { timeoutMs: 1000 }),
    /ssh_timeout: localhost 1000/,
  );
  const elapsedMs = performance.now() - started;

  // Guards against the rejection waiting on the SIGTERM-ignoring child (which
  // would take the full waitForProcessExit horizon) rather than asserting
  // scheduler precision: the margin must absorb event-loop and process-spawn
  // delay on a loaded machine (parallel check tasks, CI) without flaking.
  if (elapsedMs >= 3_000) throw new Error(`timeout returned after ${Math.round(elapsedMs)}ms`);

  const traceText = await fs.readFile(trace, "utf8");
  const childMatch = /^CHILD:(\d+)$/m.exec(traceText);
  if (!childMatch) throw new Error(`fake ssh child pid missing in trace: ${traceText}`);
  await waitForProcessExit(Number(childMatch[1]), 7_000);
});

test("SSH run reports signaled subprocesses as failures", async () => {
  const root = await tempDir("lorenz-ssh-signaled");
  const trace = path.join(root, "ssh.trace");

  await installFakeSsh(
    root,
    trace,
    `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> ${shellEscape(trace)}
kill -TERM $$
`,
  );

  const outcome = await runSsh("localhost", "printf ok", { stderrToStdout: true }).then(
    (result) => ({ status: result.status }),
    (error: unknown) => ({ error }),
  );

  if ("error" in outcome) {
    assert.match(String(outcome.error), /ssh_failed_without_exit_code: localhost/);
    assert.match(String(outcome.error), /signal=SIGTERM/);
    assert.match(String(outcome.error), /killed=true/);
  } else {
    assert.notEqual(outcome.status, 0);
  }
});

test("SSH writeRemoteFile rejects signaled subprocesses", async () => {
  const root = await tempDir("lorenz-ssh-write-signaled");
  const trace = path.join(root, "ssh.trace");

  await installFakeSsh(
    root,
    trace,
    `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> ${shellEscape(trace)}
kill -TERM $$
`,
  );

  await assert.rejects(
    () => writeRemoteFile("localhost", path.join(root, "remote.txt"), "payload"),
    /ssh.*SIGTERM|remote_write_failed/,
  );
});

test("SSH writeRemoteFile preserves payload bytes and applies mode", async () => {
  const root = await tempDir("lorenz-ssh-write");
  const trace = path.join(root, "ssh.trace");
  const remotePath = path.join(root, "nested", "script.sh");

  await installFakeSsh(
    root,
    trace,
    `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> ${shellEscape(trace)}
for arg in "$@"; do last_arg="$arg"; done
eval "$last_arg"
`,
  );
  const payload = "#!/bin/bash\necho ready\n__LORENZ_SSH_WRITE_PAYLOAD__\n";
  await writeRemoteFile("localhost", remotePath, payload, { mode: 0o755 });
  assert.equal(await fs.readFile(remotePath, "utf8"), payload);
  const stat = await fs.stat(remotePath);
  assert.equal(stat.mode & 0o777, 0o755);
  const traceText = await fs.readFile(trace, "utf8");
  assert.match(traceText, /printf/);
  assert.notMatch(traceText, /cat <<'__LORENZ_SSH_WRITE_PAYLOAD__'/);
});

test("SSH waitForRemoteTcpPort probes the remote loopback port", async () => {
  const root = await tempDir("lorenz-ssh-port-probe");
  const trace = path.join(root, "ssh.trace");

  await installFakeSsh(
    root,
    trace,
    `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> ${shellEscape(trace)}
for arg in "$@"; do last_arg="$arg"; done
case "$last_arg" in
  *'/dev/tcp/127.0.0.1/46000'*) exit 0 ;;
  *) exit 13 ;;
esac
`,
  );

  await waitForRemoteTcpPort("localhost:2222", 46_000, {
    timeoutMs: 2_000,
    intervalMs: 100,
    attemptTimeoutMs: 1_000,
  });

  const traceText = await fs.readFile(trace, "utf8");
  assert.match(traceText, /-T -p 2222 -- localhost bash -lc/);
  assert.match(traceText, /\/dev\/tcp\/127\.0\.0\.1\/46000/);
});

test("SSH writeRemoteFile rejects unsafe string modes without executing them", async () => {
  const root = await tempDir("lorenz-ssh-unsafe-mode");
  const trace = path.join(root, "ssh.trace");
  const marker = path.join(root, "marker");
  const remotePath = path.join(root, "script.sh");

  await installFakeSsh(
    root,
    trace,
    `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> ${shellEscape(trace)}
for arg in "$@"; do last_arg="$arg"; done
eval "$last_arg"
`,
  );

  let writeError: unknown;
  try {
    await writeRemoteFile("localhost", remotePath, "echo ready\n", {
      mode: `u+x; printf pwned > ${shellEscape(marker)}`,
    });
  } catch (error) {
    writeError = error;
  }

  await assertMissing(marker, "unsafe chmod mode created marker");
  assert.match(String(writeError), /invalid_chmod_mode/);
});

test("SSH writeRemoteFile shell-quotes string modes and protects dash-leading paths", async () => {
  const root = await tempDir("lorenz-ssh-string-mode");
  const trace = path.join(root, "ssh.trace");
  const remotePath = "-script.sh";

  await installFakeSsh(
    root,
    trace,
    `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> ${shellEscape(trace)}
for arg in "$@"; do last_arg="$arg"; done
cd ${shellEscape(root)}
eval "$last_arg"
`,
  );

  await writeRemoteFile("localhost", remotePath, "echo ready\n", { mode: "u+x" });

  const stat = await fs.stat(path.join(root, remotePath));
  assert.equal(stat.mode & 0o777, 0o744);
  const traceText = await fs.readFile(trace, "utf8");
  assert.match(traceText, /chmod '"'"'u\+x'"'"' '"'"'\.\/-script\.sh'"'"'/);
});

async function installFakeSsh(root: string, trace: string, source: string): Promise<void> {
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  await writeExecutable(path.join(bin, "ssh"), source);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  await fs.writeFile(trace, "");
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(50);
  }
  throw new Error(`process ${pid} still running after ${timeoutMs}ms`);
}

async function assertMissing(filePath: string, message: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(message);
}
