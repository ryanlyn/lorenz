import fs from "node:fs/promises";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, test } from "vitest";

import { stageRelease } from "../scripts/stage-release.ts";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-release-test-"));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("stages a source-free CLI release tree with rewritten package manifests", async () => {
  const workspaceRoot = path.join(tempRoot, "workspace");
  await seedWorkspace(workspaceRoot);

  const result = await stageRelease({
    workspaceRoot,
    outputRoot: path.join(tempRoot, "out"),
    releaseName: "symphony-ts-test",
    archive: true,
  });

  const releaseDir = result.releaseDir;
  assert.equal(await exists(path.join(releaseDir, "apps/cli/src/main.ts")), false);
  assert.equal(await exists(path.join(releaseDir, "apps/cli/test/cli.test.ts")), false);
  assert.equal(await exists(path.join(releaseDir, "apps/cli/dist/tsconfig.tsbuildinfo")), false);
  assert.equal(await exists(path.join(releaseDir, "apps/cli/dist/bin/cli.js")), true);
  assert.equal(
    await exists(path.join(releaseDir, "apps/symphony-dashboard/dist/index.html")),
    true,
  );
  assert.equal(await exists(result.archivePath ?? ""), true);

  const rootPackage = await readJson(path.join(releaseDir, "package.json"));
  assert.equal(rootPackage.private, true);
  assert.deepEqual(rootPackage.bin, { "symphony-ts": "./bin/symphony-ts" });
  // The root must declare every workspace package (file:) and every external dependency so that
  // npm installs the full graph even when the release is installed as a dependency (npx). npm does
  // not install the registry deps of a file: directory dependency on its own.
  assert.deepEqual(rootPackage.dependencies, {
    "@agentclientprotocol/claude-agent-acp": "file:vendor/claude-agent-acp",
    "@agentclientprotocol/codex-acp": "file:vendor/codex-acp",
    "@anthropic-ai/claude-agent-sdk": "file:runtime-deps/anthropic-claude-agent-sdk",
    "@openai/codex": "file:runtime-deps/openai-codex",
    "@symphony/acp": "file:packages/acp",
    "@symphony/cli": "file:apps/cli",
    "@symphony/server": "file:packages/server",
    "better-sqlite3": "^12.10.0",
    commander: "^14.0.3",
    execa: "^9.6.1",
    hono: "^4.12.18",
  });

  // Binary-backed SDKs are vendored with their platform binaries stripped, and the bridges point at
  // the vendored copies so installs never fetch the (hundreds of MB) agent binaries.
  const vendoredSdk = await readJson(
    path.join(releaseDir, "runtime-deps/anthropic-claude-agent-sdk/package.json"),
  );
  assert.equal("optionalDependencies" in vendoredSdk, false);
  assert.equal(vendoredSdk.private, true);
  assert.equal(
    await exists(path.join(releaseDir, "runtime-deps/anthropic-claude-agent-sdk/sdk.mjs")),
    true,
  );
  const claudeBridge = await readJson(path.join(releaseDir, "vendor/claude-agent-acp/package.json"));
  assert.deepEqual(claudeBridge.dependencies, {
    "@anthropic-ai/claude-agent-sdk": "file:../../runtime-deps/anthropic-claude-agent-sdk",
  });

  // The launcher must resolve @symphony/cli via module resolution, not a fixed node_modules path,
  // so it survives dependency hoisting.
  const entrypointSource = await fs.readFile(path.join(releaseDir, "bin/symphony-ts"), "utf8");
  assert.match(entrypointSource, /import\.meta\.resolve\("@symphony\/cli"\)/);
  assert.equal(entrypointSource.includes("../node_modules/"), false);

  const cliPackage = await readJson(path.join(releaseDir, "apps/cli/package.json"));
  assert.deepEqual(cliPackage.dependencies, {
    "@symphony/acp": "file:../../packages/acp",
    "@symphony/server": "file:../../packages/server",
    commander: "^14.0.3",
  });

  const serverPackage = await readJson(path.join(releaseDir, "packages/server/package.json"));
  assert.deepEqual(serverPackage.dependencies, {
    "@symphony/acp": "file:../acp",
    "better-sqlite3": "^12.10.0",
    hono: "^4.12.18",
  });

  const manifest = await readJson(path.join(releaseDir, "RELEASE-MANIFEST.json"));
  assert.deepEqual(
    manifest.packages.map((entry: { name: string }) => entry.name),
    [
      "@symphony/cli",
      "@symphony/acp",
      "@symphony/server",
      "@agentclientprotocol/claude-agent-acp",
      "@agentclientprotocol/codex-acp",
    ],
  );
  assert.deepEqual(manifest.nativeDependencies, ["better-sqlite3"]);
  assert.equal(manifest.installCommand, "npm install --omit=dev");
  assert.deepEqual(
    (manifest.vendoredRuntimeDependencies as Array<{ name: string }>).map((entry) => entry.name),
    ["@anthropic-ai/claude-agent-sdk", "@openai/codex"],
  );
  // Vendored SDKs are shipped as file: packages, not registry installs, so they are not externals.
  assert.equal(
    (manifest.externalDependencies as string[]).includes("@anthropic-ai/claude-agent-sdk"),
    false,
  );
  assert.equal((manifest.externalDependencies as string[]).includes("@openai/codex"), false);

  const entrypoint = path.join(releaseDir, "bin/symphony-ts");
  const entrypointMode = (await fs.stat(entrypoint)).mode;
  assert.equal((entrypointMode & 0o111) !== 0, true);
});

test("reports missing build outputs before writing a release tree", async () => {
  const workspaceRoot = path.join(tempRoot, "workspace");
  await seedWorkspace(workspaceRoot);
  await fs.rm(path.join(workspaceRoot, "apps/symphony-dashboard/dist"), {
    recursive: true,
    force: true,
  });

  await assert.rejects(
    stageRelease({
      workspaceRoot,
      outputRoot: path.join(tempRoot, "out"),
      releaseName: "symphony-ts-test",
    }),
    /apps\/symphony-dashboard\/dist/,
  );
  assert.equal(await exists(path.join(tempRoot, "out", "symphony-ts-test")), false);
});

async function seedWorkspace(workspaceRoot: string): Promise<void> {
  await writeFile(
    workspaceRoot,
    "pnpm-workspace.yaml",
    `packages:
  - "packages/*"
  - "extensions/*"
  - "apps/*"
  - "vendor/*"
catalog:
  commander: "^14.0.3"
  better-sqlite3: "^12.10.0"
  hono: "^4.12.18"
  execa: "^9.6.1"
`,
  );

  await seedPackage(workspaceRoot, "apps/cli", {
    name: "@symphony/cli",
    version: "0.1.0",
    type: "module",
    bin: { "symphony-ts": "./bin/symphony-ts.js" },
    main: "./dist/index.js",
    dependencies: {
      "@symphony/acp": "workspace:*",
      "@symphony/server": "workspace:*",
      commander: "catalog:",
    },
  });
  await writeFile(workspaceRoot, "apps/cli/dist/bin/cli.js", "export {};\n");
  await writeFile(workspaceRoot, "apps/cli/dist/tsconfig.tsbuildinfo", "build cache\n");
  await writeFile(workspaceRoot, "apps/cli/bin/symphony-ts.js", "#!/usr/bin/env node\n");
  await writeFile(workspaceRoot, "apps/cli/src/main.ts", "export {};\n");
  await writeFile(workspaceRoot, "apps/cli/test/cli.test.ts", "export {};\n");

  await seedPackage(workspaceRoot, "packages/acp", {
    name: "@symphony/acp",
    version: "0.1.0",
    type: "module",
    main: "./dist/index.js",
    dependencies: {
      "@agentclientprotocol/claude-agent-acp": "workspace:*",
      "@agentclientprotocol/codex-acp": "workspace:*",
      execa: "catalog:",
    },
  });

  await seedPackage(workspaceRoot, "packages/server", {
    name: "@symphony/server",
    version: "0.1.0",
    type: "module",
    main: "./dist/index.js",
    dependencies: {
      "@symphony/acp": "workspace:*",
      "better-sqlite3": "catalog:",
      hono: "catalog:",
    },
  });

  await seedPackage(workspaceRoot, "vendor/claude-agent-acp", {
    name: "@agentclientprotocol/claude-agent-acp",
    version: "0.40.0",
    type: "module",
    bin: { "claude-agent-acp": "dist/bundle.js" },
    main: "dist/lib.js",
    dependencies: {
      "@anthropic-ai/claude-agent-sdk": "0.3.160",
    },
  });
  await writeFile(workspaceRoot, "vendor/claude-agent-acp/dist/bundle.js", "export {};\n");
  // The vendored SDK ships dependency-free JS plus platform-specific binaries as optionalDeps.
  await writeFile(
    workspaceRoot,
    "vendor/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
    {
      name: "@anthropic-ai/claude-agent-sdk",
      version: "0.3.160",
      type: "module",
      main: "sdk.mjs",
      dependencies: {},
      optionalDependencies: {
        "@anthropic-ai/claude-agent-sdk-darwin-arm64": "0.3.160",
        "@anthropic-ai/claude-agent-sdk-linux-x64": "0.3.160",
      },
    },
  );
  await writeFile(
    workspaceRoot,
    "vendor/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    "export {};\n",
  );

  await seedPackage(workspaceRoot, "vendor/codex-acp", {
    name: "@agentclientprotocol/codex-acp",
    version: "0.0.45",
    type: "module",
    bin: { "codex-acp": "dist/index.js" },
    main: "dist/index.js",
    dependencies: {
      "@openai/codex": "^0.128.0",
    },
  });
  await writeFile(
    workspaceRoot,
    "vendor/codex-acp/node_modules/@openai/codex/package.json",
    {
      name: "@openai/codex",
      version: "0.128.0",
      type: "module",
      bin: { codex: "bin/codex.js" },
      dependencies: {},
      optionalDependencies: {
        "@openai/codex-darwin-arm64": "npm:@openai/[email protected]",
      },
    },
  );
  await writeFile(
    workspaceRoot,
    "vendor/codex-acp/node_modules/@openai/codex/bin/codex.js",
    "#!/usr/bin/env node\n",
  );

  await writeFile(workspaceRoot, "apps/symphony-dashboard/dist/index.html", "<div></div>\n");
  await writeFile(workspaceRoot, "README.md", "# Test\n");
}

async function seedPackage(
  workspaceRoot: string,
  relativeDir: string,
  packageJson: Record<string, unknown>,
): Promise<void> {
  await writeFile(workspaceRoot, path.join(relativeDir, "package.json"), packageJson);
  await writeFile(workspaceRoot, path.join(relativeDir, "dist/index.js"), "export {};\n");
}

async function writeFile(
  workspaceRoot: string,
  relativePath: string,
  content: string | Record<string, unknown>,
): Promise<void> {
  const filePath = path.join(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
  );
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
