import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { test } from "vitest";

import { assert } from "./assert.js";
import { tempDir, writeExecutable } from "./helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");

test("worktree initializer prepares TypeScript when Elixir is absent", async () => {
  const checkout = await createCheckout({ includeElixir: false });
  const { binDir, logPath } = await createStubToolchain(checkout);

  await runInitializer(checkout, binDir, logPath);

  await fs.stat(path.join(checkout, "ts", "node_modules", ".modules.yaml"));
  await fs.stat(path.join(checkout, "ts", "dist", ".built"));

  const log = await fs.readFile(logPath, "utf8");
  assert.match(log, commandPattern(checkout, "ts", "mise", "trust"));
  assert.match(log, commandPattern(checkout, "ts", "mise", "install"));
  assert.match(log, commandPattern(checkout, "ts", "pnpm", "install --frozen-lockfile"));
  assert.match(log, commandPattern(checkout, "ts", "pnpm", "build"));
  assert.notMatch(log, /:make:/);
});

test("worktree initializer keeps Elixir setup when Elixir is present", async () => {
  const checkout = await createCheckout({ includeElixir: true });
  const { binDir, logPath } = await createStubToolchain(checkout);

  await runInitializer(checkout, binDir, logPath);

  const log = await fs.readFile(logPath, "utf8");
  assert.match(log, commandPattern(checkout, "ts", "pnpm", "install --frozen-lockfile"));
  assert.match(log, commandPattern(checkout, "elixir", "make", "setup"));
});

async function createCheckout({ includeElixir }: { includeElixir: boolean }): Promise<string> {
  const checkout = await tempDir("symphony-worktree-init");

  await fs.mkdir(path.join(checkout, ".codex"), { recursive: true });
  await fs.copyFile(
    path.join(repoRoot, ".codex", "worktree_init.sh"),
    path.join(checkout, ".codex", "worktree_init.sh"),
  );
  await fs.chmod(path.join(checkout, ".codex", "worktree_init.sh"), 0o755);
  await fs.mkdir(path.join(checkout, "ts"), { recursive: true });

  if (includeElixir) {
    await fs.mkdir(path.join(checkout, "elixir"), { recursive: true });
  }

  return checkout;
}

async function createStubToolchain(checkout: string): Promise<{ binDir: string; logPath: string }> {
  const binDir = path.join(checkout, "bin");
  const logPath = path.join(checkout, "commands.log");

  await writeExecutable(
    path.join(binDir, "mise"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s:%s:%s\\n' "$PWD" "mise" "$*" >> "$WORKTREE_INIT_LOG"
if [ "\${1:-}" = "exec" ] && [ "\${2:-}" = "--" ]; then
  shift 2
  "$@"
fi
`,
  );

  await writeExecutable(
    path.join(binDir, "pnpm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s:%s:%s\\n' "$PWD" "pnpm" "$*" >> "$WORKTREE_INIT_LOG"
case "\${1:-}" in
  install)
    mkdir -p node_modules
    printf 'installed\\n' > node_modules/.modules.yaml
    ;;
  build)
    mkdir -p dist
    printf 'built\\n' > dist/.built
    ;;
esac
`,
  );

  await writeExecutable(
    path.join(binDir, "make"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s:%s:%s\\n' "$PWD" "make" "$*" >> "$WORKTREE_INIT_LOG"
`,
  );

  return { binDir, logPath };
}

async function runInitializer(checkout: string, binDir: string, logPath: string): Promise<void> {
  const pathEnv = process.env.PATH ?? "";

  await execFileAsync(path.join(checkout, ".codex", "worktree_init.sh"), {
    cwd: path.dirname(checkout),
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${pathEnv}`,
      WORKTREE_INIT_LOG: logPath,
    },
  });
}

function commandPattern(
  checkout: string,
  packageDir: "elixir" | "ts",
  command: "make" | "mise" | "pnpm",
  args: string,
): RegExp {
  return new RegExp(
    `${escapeRegExp(path.join(checkout, packageDir))}:${command}:${escapeRegExp(args)}`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
