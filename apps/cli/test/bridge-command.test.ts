import fs from "node:fs/promises";
import path from "node:path";

import { test } from "vitest";
import { assert, tempDir, writeExecutable } from "@lorenz/test-utils";

import {
  agentCliRequirement,
  bridgeCommandRequirements,
  findExecutable,
} from "../src/bridgeCommand.js";

test("bridge command parsing preserves quoted and escaped words", () => {
  assert.deepEqual(bridgeCommandRequirements('"/opt/bridge tools/codex acp" --stdio'), {
    executable: "/opt/bridge tools/codex acp",
    wrapperExecutable: undefined,
    bridgeTarget: undefined,
  });
  assert.deepEqual(bridgeCommandRequirements("/opt/bridge\\ tools/codex\\ acp --stdio"), {
    executable: "/opt/bridge tools/codex acp",
    wrapperExecutable: undefined,
    bridgeTarget: undefined,
  });
});

test("bridge command parsing skips assignments and exec", () => {
  assert.deepEqual(
    bridgeCommandRequirements('CODEX_HOME="/tmp/codex home" DEBUG=1 exec codex-acp --stdio'),
    {
      executable: "codex-acp",
      wrapperExecutable: undefined,
      bridgeTarget: undefined,
    },
  );
});

test("bridge command parsing handles env assignments and supported options", () => {
  assert.deepEqual(
    bridgeCommandRequirements(
      "env - -0 -i --ignore-environment -uCODEX_PATH --unset=DEBUG -C /tmp " +
        '--chdir=/var TOKEN="two words" codex-acp --stdio',
    ),
    {
      executable: "codex-acp",
      wrapperExecutable: "env",
      bridgeTarget: undefined,
    },
  );
});

test("bridge command parsing records env wrappers and absolute Node targets", () => {
  assert.deepEqual(
    bridgeCommandRequirements('exec /usr/bin/env TOKEN=value -- node "/opt/bridges/codex acp.js"'),
    {
      executable: "node",
      wrapperExecutable: "/usr/bin/env",
      bridgeTarget: "/opt/bridges/codex acp.js",
    },
  );
  assert.deepEqual(bridgeCommandRequirements('node "relative/bridge.js"'), {
    executable: "node",
    wrapperExecutable: undefined,
    bridgeTarget: undefined,
  });
});

test.each([
  "",
  "TOKEN=value",
  "exec",
  "env",
  "env --",
  "env -u",
  "env --unset",
  "env -C",
  "env --chdir",
])("bridge command parsing rejects malformed command %j", (command) => {
  assert.equal(bridgeCommandRequirements(command), null);
});

test.each([
  'env -S "codex-acp --stdio"',
  "env --split-string codex-acp",
  "env --split-string=codex-acp",
  "env --debug codex-acp",
])("bridge command parsing preserves unsupported env option behavior for %j", (command) => {
  assert.equal(bridgeCommandRequirements(command), null);
});

test("executable discovery handles PATH, absolute files, and non-files", async () => {
  const root = await tempDir("lorenz-bridge-command");
  const binDir = path.join(root, "bin");
  const executable = path.join(binDir, "bridge");
  const regularFile = path.join(binDir, "not-executable");
  const directory = path.join(binDir, "directory");
  await writeExecutable(executable, "#!/usr/bin/env bash\nexit 0\n");
  await fs.writeFile(regularFile, "plain file\n");
  await fs.mkdir(directory);

  assert.equal(await findExecutable("bridge", { PATH: binDir }), executable);
  assert.equal(await findExecutable(executable, { PATH: "" }), executable);
  assert.equal(await findExecutable(regularFile, { PATH: binDir }), null);
  assert.equal(await findExecutable(directory, { PATH: binDir }), null);
  assert.equal(await findExecutable("missing", { PATH: binDir }), null);
});

test("agent CLI requirements preserve Codex and Claude environment overrides", () => {
  assert.deepEqual(agentCliRequirement("codex-acp", { CODEX_PATH: " /tools/codex-real " }), {
    binary: "codex",
    executable: "/tools/codex-real",
    envOverride: "CODEX_PATH",
    overridden: true,
  });
  assert.deepEqual(
    agentCliRequirement("/opt/bridges/claude-agent-acp --stdio", {
      CLAUDE_CODE_EXECUTABLE: "/tools/claude-real",
    }),
    {
      binary: "claude",
      executable: "/tools/claude-real",
      envOverride: "CLAUDE_CODE_EXECUTABLE",
      overridden: true,
    },
  );
  assert.deepEqual(agentCliRequirement("claude-agent-acp", { CLAUDE_CODE_EXECUTABLE: "  " }), {
    binary: "claude",
    executable: "claude",
    envOverride: "CLAUDE_CODE_EXECUTABLE",
    overridden: false,
  });
  assert.equal(agentCliRequirement("custom-acp", {}), null);
});
