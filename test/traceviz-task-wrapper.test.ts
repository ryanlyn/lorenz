import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const wrapperPath = path.join(workspaceRoot, ".mise/tasks/traceviz");
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

function createFakePnpm(): { binDir: string; logPath: string } {
  const binDir = fs.mkdtempSync(path.join(workspaceRoot, ".traceviz-wrapper-test-"));
  tempDirs.push(binDir);

  const logPath = path.join(binDir, "pnpm-argv.log");
  const pnpmPath = path.join(binDir, "pnpm");
  fs.writeFileSync(
    pnpmPath,
    [
      "#!/usr/bin/env bash",
      "set -eu",
      "{",
      "  printf '%s\\n' \"$#\"",
      '  for arg in "$@"; do',
      "    printf '%s\\n' \"$arg\"",
      "  done",
      "  printf '%s\\n' '---'",
      '} >> "$MONO_408_TRACEVIZ_PNPM_LOG"',
      "",
    ].join("\n"),
  );
  fs.chmodSync(pnpmPath, 0o755);

  return { binDir, logPath };
}

function readLoggedArgv(logPath: string): string[][] {
  const lines = fs.readFileSync(logPath, "utf8").trimEnd().split("\n");
  const invocations: string[][] = [];

  for (let index = 0; index < lines.length; ) {
    const argc = Number(lines[index]);
    const args = lines.slice(index + 1, index + 1 + argc);
    expect(lines[index + 1 + argc]).toBe("---");
    invocations.push(args);
    index += argc + 2;
  }

  return invocations;
}

describe("traceviz mise task wrapper", () => {
  it("is not kept as an inline mise command with argument interpolation", () => {
    const miseToml = fs.readFileSync(path.join(workspaceRoot, "mise.toml"), "utf8");
    const inlineTracevizTask =
      miseToml.match(/\[tasks\.traceviz\][\s\S]*?(?=\n\[tasks\.|$)/)?.[0] ?? "";

    expect(inlineTracevizTask).not.toContain("{{arg(name='file')}}");
  });

  it("passes spaces and shell metacharacters to pnpm traceviz as one argument", () => {
    const { binDir, logPath } = createFakePnpm();
    const tracePath = "trace path with spaces; echo MONO_408_INJECTION.jsonl";
    const result = spawnSync(wrapperPath, [tracePath], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MONO_408_TRACEVIZ_PNPM_LOG: logPath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("MONO_408_INJECTION");
    expect(result.status).toBe(0);
    expect(readLoggedArgv(logPath)).toEqual([
      ["--filter", "@lorenz/dashboard", "build"],
      ["traceviz", "--", tracePath],
    ]);
  });
});
