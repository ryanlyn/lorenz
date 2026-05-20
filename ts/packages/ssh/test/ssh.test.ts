import { assert } from "../../../test/assert.js";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import {
  parseSshTarget,
  remoteShellCommand,
  runSsh,
  shellEscape,
  sshArgs,
  writeRemoteFile,
} from "@symphony/ssh";
import { tempDir, writeExecutable } from "../../../test/helpers.js";

test("SSH target parsing and command args match Elixir host:port behavior", () => {
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
    "localhost",
    "bash -lc 'echo ready'",
  ]);
});

test("SSH run honors SYMPHONY_SSH_CONFIG, stderr folding, missing ssh, and timeouts", async () => {
  const root = await tempDir("symphony-ts-ssh");
  const trace = path.join(root, "ssh.trace");
  const oldPath = process.env.PATH;
  const oldConfig = process.env.SYMPHONY_SSH_CONFIG;

  try {
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
    process.env.SYMPHONY_SSH_CONFIG = "/tmp/symphony-test-ssh-config";

    const result = await runSsh("localhost:2222", "echo ready", { stderrToStdout: true });
    assert.equal(result.status, 7);
    assert.equal(result.stdout, "out\nerr\n");
    assert.equal(result.stderr, "");
    const traceText = await fs.readFile(trace, "utf8");
    assert.match(traceText, /-F \/tmp\/symphony-test-ssh-config -T -p 2222 localhost bash -lc/);
    assert.match(traceText, /echo ready/);

    const emptyPath = await tempDir("symphony-ts-ssh-empty-path");
    process.env.PATH = emptyPath;
    await assert.rejects(() => runSsh("localhost", "printf ok"), /ssh_not_found/);

    process.env.PATH = oldPath;
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
  } finally {
    restoreEnv("PATH", oldPath);
    restoreEnv("SYMPHONY_SSH_CONFIG", oldConfig);
  }
});

test("SSH writeRemoteFile preserves payload bytes and applies mode", async () => {
  const root = await tempDir("symphony-ts-ssh-write");
  const trace = path.join(root, "ssh.trace");
  const remotePath = path.join(root, "nested", "script.sh");
  const oldPath = process.env.PATH;

  try {
    await installFakeSsh(
      root,
      trace,
      `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> ${shellEscape(trace)}
for arg in "$@"; do last_arg="$arg"; done
eval "$last_arg"
`,
    );
    const payload = "#!/bin/bash\necho ready\n__SYMPHONY_SSH_WRITE_PAYLOAD__\n";
    await writeRemoteFile("localhost", remotePath, payload, { mode: 0o755 });
    assert.equal(await fs.readFile(remotePath, "utf8"), payload);
    const stat = await fs.stat(remotePath);
    assert.equal(stat.mode & 0o777, 0o755);
    const traceText = await fs.readFile(trace, "utf8");
    assert.match(traceText, /printf/);
    assert.notMatch(traceText, /cat <<'__SYMPHONY_SSH_WRITE_PAYLOAD__'/);
  } finally {
    restoreEnv("PATH", oldPath);
  }
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
