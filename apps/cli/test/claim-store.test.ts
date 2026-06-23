import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { test } from "vitest";
import { parseConfig } from "@lorenz/config";
import { assert, tempDir } from "@lorenz/test-utils";
import type { WorkflowDefinition } from "@lorenz/domain";

import { buildClaimStoreHandle, defaultClaimStorePath } from "../src/claimStore.js";

test("claim store builder keeps memory as the default backend", async () => {
  const workflow = workflowFixture(await tempDir("lorenz-claim-store-memory"));
  const handle = await buildClaimStoreHandle(
    workflow,
    { backend: null, path: null, ownerStaleMs: null },
    {},
  );

  assert.equal(handle.backend, "memory");
  assert.equal(handle.path, null);
  assert.equal(handle.claimStore, undefined);
  await handle.close();
});

test("claim store builder opens an explicit SQLite backend", async () => {
  const root = await tempDir("lorenz-claim-store-sqlite");
  const workflow = workflowFixture(root);
  const dbPath = path.join(root, "claims.db");
  const handle = await buildClaimStoreHandle(
    workflow,
    { backend: "sqlite", path: dbPath, ownerStaleMs: 60_000 },
    {},
  );

  try {
    assert.equal(handle.backend, "sqlite");
    assert.equal(handle.path, dbPath);
    assert.equal(handle.claimStore?.kind, "sqlite");
    assert.deepEqual(handle.claimStore?.capabilities, {
      crashRecovery: true,
      sharedAcrossProcesses: true,
      retryDurability: true,
    });
  } finally {
    await handle.close();
  }
});

test("claim store builder reads explicit backend settings from env", async () => {
  const root = await tempDir("lorenz-claim-store-env");
  const workflow = workflowFixture(root);
  const handle = await buildClaimStoreHandle(
    workflow,
    { backend: null, path: null, ownerStaleMs: null },
    {
      LORENZ_CLAIM_STORE: "sqlite",
      LORENZ_CLAIM_STORE_PATH: path.join(root, "env-claims.db"),
      LORENZ_CLAIM_STORE_OWNER_STALE_MS: "120000",
    },
  );

  try {
    assert.equal(handle.backend, "sqlite");
    assert.equal(handle.path, path.join(root, "env-claims.db"));
    assert.equal(handle.claimStore?.kind, "sqlite");
  } finally {
    await handle.close();
  }
});

test("claim store default path is anchored under the workflow workspace", async () => {
  const root = await tempDir("lorenz-claim-store-default-path");
  const workflow = workflowFixture(root);
  const defaultPath = defaultClaimStorePath(workflow);
  const canonicalRoot = await realpath(root);

  assert.equal(
    path.dirname(path.dirname(defaultPath)),
    path.join(canonicalRoot, ".lorenz", "claim-store"),
  );
  assert.match(path.basename(path.dirname(defaultPath)), /^[a-f0-9]{64}$/);
  assert.equal(path.basename(defaultPath), "claims.db");
});

test("claim store default path is scoped by workflow path", async () => {
  const root = await tempDir("lorenz-claim-store-workflow-scope");
  const first = workflowFixture(root, "WORKFLOW.md");
  const second = workflowFixture(root, "WORKFLOW.alt.md");
  const canonicalRoot = await realpath(root);

  assert.notEqual(defaultClaimStorePath(first), defaultClaimStorePath(second));
  assert.equal(
    path.dirname(path.dirname(defaultClaimStorePath(first))),
    path.join(canonicalRoot, ".lorenz", "claim-store"),
  );
  assert.equal(
    path.dirname(path.dirname(defaultClaimStorePath(second))),
    path.join(canonicalRoot, ".lorenz", "claim-store"),
  );
});

test("claim store default path canonicalizes symlinked workflow aliases", async () => {
  const root = await tempDir("lorenz-claim-store-symlink");
  const workspaceRoot = path.join(root, "workspace");
  const workspaceAlias = path.join(root, "workspace-link");
  await mkdir(workspaceRoot);
  await symlink(workspaceRoot, workspaceAlias, "dir");
  const workflowPath = path.join(workspaceRoot, "WORKFLOW.md");
  await writeFile(workflowPath, "workflow", "utf8");

  const canonical = workflowFixture(workspaceRoot);
  const alias = workflowFixture(workspaceAlias);

  assert.equal(defaultClaimStorePath(canonical), defaultClaimStorePath(alias));
});

function workflowFixture(root: string, fileName = "WORKFLOW.md"): WorkflowDefinition {
  return {
    path: path.join(root, fileName),
    config: {},
    content: "",
    settings: parseConfig({
      tracker: { kind: "memory" },
      workspace: { root },
      logging: { log_file: path.join(root, "lorenz.log") },
    }),
  };
}
