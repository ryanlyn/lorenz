import path from "node:path";

import {
  AsyncPersistentClaimStore,
  PersistentClaimStore,
  type ClaimStoreLike,
} from "@lorenz/orchestrator";
import { SqliteClaimStoreBackend } from "@lorenz/orchestrator/sqlite";
import { TursoClaimStoreBackend } from "@lorenz/orchestrator/turso";
import { type WorkflowDefinition } from "@lorenz/domain";

import { daemonWorkflowKey, daemonWorkspacePath } from "./daemonLock.js";

type ClaimStoreBackendName = "memory" | "sqlite" | "turso";

/**
 * Resolved claim-store configuration. The CLI composition root derives this entirely from the
 * `@lorenz/flags` snapshot (`claim_store.*`); there is no bespoke option or env parsing here.
 */
export interface ClaimStoreConfig {
  backend: ClaimStoreBackendName;
  /** Empty/null derives a path under the workflow workspace. */
  path?: string | null | undefined;
  /** Non-positive/null uses the store's built-in owner-lease stale threshold. */
  ownerStaleMs?: number | null | undefined;
}

export interface ClaimStoreHandle {
  readonly backend: ClaimStoreBackendName;
  readonly path: string | null;
  readonly claimStore: ClaimStoreLike | undefined;
  close(): Promise<void>;
}

export async function buildClaimStoreHandle(
  workflow: WorkflowDefinition,
  config: ClaimStoreConfig,
): Promise<ClaimStoreHandle> {
  if (config.backend === "memory") {
    return {
      backend: "memory",
      path: null,
      claimStore: undefined,
      close: async () => Promise.resolve(),
    };
  }

  const dbPath = config.path ? path.resolve(config.path) : defaultClaimStorePath(workflow);
  const ownerLeaseStaleMs =
    typeof config.ownerStaleMs === "number" && config.ownerStaleMs > 0
      ? config.ownerStaleMs
      : undefined;
  if (config.backend === "sqlite") {
    const store = new PersistentClaimStore(new SqliteClaimStoreBackend(dbPath), {
      ownerLeaseStaleMs,
    });
    return {
      backend: "sqlite",
      path: dbPath,
      claimStore: store,
      async close() {
        store.close();
        return Promise.resolve();
      },
    };
  }

  const store = await AsyncPersistentClaimStore.create(
    await TursoClaimStoreBackend.open(dbPath, { multiprocessWal: true }),
    { ownerLeaseStaleMs },
  );
  return {
    backend: "turso",
    path: dbPath,
    claimStore: store,
    async close() {
      await store.close();
    },
  };
}

export function defaultClaimStorePath(workflow: WorkflowDefinition): string {
  return daemonWorkspacePath(
    workflow.settings.workspace.root,
    "claim-store",
    daemonWorkflowKey(workflow.path),
    "claims.db",
  );
}
