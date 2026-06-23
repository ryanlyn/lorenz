import path from "node:path";

import {
  AsyncPersistentClaimStore,
  PersistentClaimStore,
  type ClaimStoreLike,
} from "@lorenz/orchestrator";
import { SqliteClaimStoreBackend } from "@lorenz/orchestrator/sqlite";
import { TursoClaimStoreBackend } from "@lorenz/orchestrator/turso";
import { isOneOf, type WorkflowDefinition } from "@lorenz/domain";

import { daemonWorkflowKey, daemonWorkspacePath } from "./daemonLock.js";

const CLAIM_STORE_BACKENDS = ["memory", "sqlite", "turso"] as const;
export type ClaimStoreBackendName = (typeof CLAIM_STORE_BACKENDS)[number];

export interface ClaimStoreCliOptions {
  backend: ClaimStoreBackendName | null;
  path: string | null;
  ownerStaleMs: number | null;
}

export interface ClaimStoreHandle {
  readonly backend: ClaimStoreBackendName;
  readonly path: string | null;
  readonly claimStore: ClaimStoreLike | undefined;
  close(): Promise<void>;
}

export function parseClaimStoreBackend(value: string): ClaimStoreBackendName {
  if (isClaimStoreBackend(value)) return value;
  throw new Error(`claim store backend must be one of: ${CLAIM_STORE_BACKENDS.join(", ")}`);
}

export async function buildClaimStoreHandle(
  workflow: WorkflowDefinition,
  options: ClaimStoreCliOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaimStoreHandle> {
  const backend = selectedBackend(options, env);
  if (backend === "memory") {
    return {
      backend,
      path: null,
      claimStore: undefined,
      close: async () => Promise.resolve(),
    };
  }

  const dbPath = selectedStorePath(workflow, options, env);
  const ownerLeaseStaleMs = selectedOwnerStaleMs(options, env);
  if (backend === "sqlite") {
    const store = new PersistentClaimStore(new SqliteClaimStoreBackend(dbPath), {
      ownerLeaseStaleMs,
    });
    return {
      backend,
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
    backend,
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

function selectedBackend(
  options: ClaimStoreCliOptions,
  env: NodeJS.ProcessEnv,
): ClaimStoreBackendName {
  if (options.backend) return options.backend;
  const raw = env.LORENZ_CLAIM_STORE?.trim();
  if (!raw) return "memory";
  return parseClaimStoreBackend(raw);
}

function selectedStorePath(
  workflow: WorkflowDefinition,
  options: ClaimStoreCliOptions,
  env: NodeJS.ProcessEnv,
): string {
  const raw = options.path ?? env.LORENZ_CLAIM_STORE_PATH;
  return raw ? path.resolve(raw) : defaultClaimStorePath(workflow);
}

function selectedOwnerStaleMs(
  options: ClaimStoreCliOptions,
  env: NodeJS.ProcessEnv,
): number | undefined {
  if (options.ownerStaleMs !== null) return options.ownerStaleMs;
  const raw = env.LORENZ_CLAIM_STORE_OWNER_STALE_MS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("LORENZ_CLAIM_STORE_OWNER_STALE_MS must be a positive integer");
  }
  return parsed;
}

function isClaimStoreBackend(value: string): value is ClaimStoreBackendName {
  return isOneOf(value, CLAIM_STORE_BACKENDS);
}
