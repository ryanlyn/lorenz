// Out-of-tree box-driver loading: `worker.box_pool.driver` accepts a module
// specifier (npm name, `./relative` or `/absolute` path, optional `#exportName`
// suffix) that the daemon dynamic-imports at startup and registers into the
// box-driver registry. These tests drive the loader through temp-dir fixture
// modules: startup load + provision through the loaded driver, the named-export
// form, the SDK version handshake, malformed-module rejection, the
// known-kinds/did-you-mean resolution error, reload-to-new-specifier hot-load
// via coordinator.reconcile, and the module-pinned re-encounter event.

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, test } from "vitest";
import { parseConfig } from "@symphony/config";
import { systemClock, type Settings } from "@symphony/domain";
import { assert, tempDir } from "@symphony/test-utils";
import {
  BoxDriverRegistry,
  registerFakeBoxDriver,
  type BoxDriverFactory,
  type DriverDeps,
} from "@symphony/box-sdk";
import { createBoxPool } from "@symphony/worker-box-pool";
import { createDispatchCoordinator, nullEndpointManager } from "@symphony/dispatch-coordinator";

import { registerBuiltinBackends } from "../src/daemon.js";
import { ensureBoxDriverLoaded, parseBoxDriverRef } from "../src/boxDriverLoader.js";

import { buildBoxPool } from "@symphony/cli";

// buildBoxPool resolves through the process-default registry, populated the
// same way the CLI entrypoints populate it.
beforeAll(() => {
  registerBuiltinBackends();
});

// Fixture modules import defineBoxDriver exactly like a third-party package
// would. A temp-dir module cannot resolve the bare `@symphony/box-sdk` name
// (no node_modules above it), so the fixture imports the same built module by
// file URL - byte-identical code, different resolution.
const sdkHref = pathToFileURL(createRequire(import.meta.url).resolve("@symphony/box-sdk")).href;

/**
 * Source of a self-contained driver module. The driver provisions synthetic
 * `<scheme>://box-<boxId>` hosts entirely in memory (idempotent on boxId,
 * destroy-tolerant) so the real pool can lease against it.
 */
function driverModuleSource(options: {
  kind: string;
  scheme: string;
  sdkVersion?: number;
  named?: boolean;
}): string {
  const { kind, scheme, sdkVersion = 1, named = false } = options;
  return `
import { defineBoxDriver } from ${JSON.stringify(sdkHref)};

const driverModule = defineBoxDriver({
  kind: ${JSON.stringify(kind)},
  sdkVersion: ${sdkVersion},
  create(options, deps) {
    const boxes = new Map();
    return {
      kind: ${JSON.stringify(kind)},
      capabilities: { sshAddressable: false, ephemeral: true, usesLedger: false },
      async provision(req) {
        const existing = boxes.get(req.boxId);
        if (existing) return existing;
        const descriptor = {
          boxId: req.boxId,
          workerHost: ${JSON.stringify(scheme)} + "://box-" + req.boxId,
          driverRef: req.boxId,
          createdAtMs: deps.clock.now().getTime(),
          labels: [...req.labels],
          metadata: {},
        };
        boxes.set(req.boxId, descriptor);
        return descriptor;
      },
      async probe() {
        return { ok: true };
      },
      async destroy(box) {
        boxes.delete(box.boxId);
      },
      async list() {
        return [...boxes.values()];
      },
    };
  },
});

${named ? `export const ${kind} = driverModule;` : "export default driverModule;"}
`;
}

async function writeFixture(dir: string, fileName: string, source: string): Promise<string> {
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, source);
  return filePath;
}

/** A private registry seeded with the built-in fake (plus optional extra kinds). */
function privateRegistry(extraKinds: string[] = []): BoxDriverRegistry {
  const registry = new BoxDriverRegistry();
  registerFakeBoxDriver({ boxDrivers: registry });
  for (const kind of extraKinds) {
    registry.register({
      kind,
      create: () => {
        throw new Error(`stub driver ${kind} must not be constructed`);
      },
    } satisfies BoxDriverFactory);
  }
  return registry;
}

function recordingLog(): {
  events: Record<string, unknown>[];
  logEvent: (event: Record<string, unknown>) => void;
} {
  const events: Record<string, unknown>[] = [];
  return { events, logEvent: (event) => void events.push(event) };
}

const driverDeps: DriverDeps = {
  clock: systemClock,
  logEvent: () => {},
  runSsh: async () => ({ stdout: "", stderr: "", status: 0 }),
};

function poolSettings(dir: string, driver: string): Settings {
  return parseConfig(
    {
      workspace: { root: path.join(dir, "workspaces") },
      logging: { log_file: path.join(dir, "symphony.log") },
      worker: {
        box_pool: {
          enabled: true,
          driver,
          max: 1,
          warm: 0,
          acquire_timeout_ms: 5_000,
          reap_interval_ms: 3_600_000,
        },
      },
    },
    {},
  );
}

// ---------------------------------------------------------------------------
// startup load (buildBoxPool path)
// ---------------------------------------------------------------------------

test("startup: buildBoxPool loads a default-export driver module and provisions through it", async () => {
  const dir = await tempDir("box-driver-loader");
  // An absolute specifier keeps the process-default registry entry unique to
  // this test (the registered kind IS the configured string).
  const specifier = await writeFixture(
    dir,
    "acme-driver.mjs",
    driverModuleSource({ kind: "acme", scheme: "acme" }),
  );
  const settings = poolSettings(dir, specifier);

  const pool = await buildBoxPool(settings, {}, { baseDir: dir });
  assert.ok(pool);
  assert.equal(pool!.snapshot().driver, specifier);

  // The box provisions via the loaded driver: the workerHost carries the
  // fixture's synthetic scheme.
  const acquired = await pool!.acquire({
    issueId: "ISS-1",
    slotIndex: 0,
    labels: [],
    timeoutMs: 5_000,
  });
  assert.equal(acquired.status, "leased");
  if (acquired.status !== "leased") return;
  assert.match(acquired.lease.workerHost, /^acme:\/\/box-/);
  await acquired.lease.release("healthy");
  await pool!.drain({ deadlineMs: 5_000 });
});

test("startup: a relative specifier resolves against baseDir", async () => {
  const dir = await tempDir("box-driver-loader");
  await writeFixture(dir, "rel-driver.mjs", driverModuleSource({ kind: "rel", scheme: "rel" }));
  const registry = privateRegistry();
  const { events, logEvent } = recordingLog();

  await ensureBoxDriverLoaded("./rel-driver.mjs", registry, { baseDir: dir, logEvent });

  // Registered under the EXACT configured string, resolvable by the pool.
  assert.ok(registry.get("./rel-driver.mjs"));
  const loaded = events.find((event) => event.event === "box_pool_driver_loaded");
  assert.ok(loaded);
  assert.equal(loaded!.specifier, "./rel-driver.mjs");
  assert.equal(loaded!.kind, "rel");
  assert.equal(loaded!.sdkVersion, 1);
  assert.match(String(loaded!.resolvedFrom), /^file:\/\/.*rel-driver\.mjs$/);
});

// ---------------------------------------------------------------------------
// named-export form (#name)
// ---------------------------------------------------------------------------

test("a #exportName suffix selects a named export", async () => {
  const dir = await tempDir("box-driver-loader");
  await writeFixture(
    dir,
    "named-driver.mjs",
    driverModuleSource({ kind: "acme", scheme: "acme", named: true }),
  );
  const registry = privateRegistry();
  const { events, logEvent } = recordingLog();

  const driver = "./named-driver.mjs#acme";
  await ensureBoxDriverLoaded(driver, registry, { baseDir: dir, logEvent });

  const factory = registry.get(driver);
  assert.ok(factory);
  assert.equal(factory!.kind, driver);
  // The factory delegates to the loaded module's create.
  const instance = factory!.create({}, driverDeps);
  assert.equal(instance.kind, "acme");
  assert.equal(events.filter((event) => event.event === "box_pool_driver_loaded").length, 1);
});

test("a #exportName miss fails loud listing the available exports", async () => {
  const dir = await tempDir("box-driver-loader");
  await writeFixture(
    dir,
    "named-driver.mjs",
    driverModuleSource({ kind: "acme", scheme: "acme", named: true }),
  );
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureBoxDriverLoaded("./named-driver.mjs#nope", registry, { baseDir: dir }),
    /box_pool_driver_module_invalid: .*no export named "nope".*acme/,
  );
});

// ---------------------------------------------------------------------------
// version handshake + malformed modules
// ---------------------------------------------------------------------------

test("an sdkVersion mismatch fails loud with box_pool_driver_sdk_mismatch", async () => {
  const dir = await tempDir("box-driver-loader");
  // defineBoxDriver would reject v2 at authoring time, so the fixture exports
  // the raw object - exactly what an incompatible third-party module looks like.
  await writeFixture(
    dir,
    "future-driver.mjs",
    `export default { kind: "future", sdkVersion: 2, create: () => { throw new Error("unreachable"); } };`,
  );
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureBoxDriverLoaded("./future-driver.mjs", registry, { baseDir: dir }),
    /box_pool_driver_sdk_mismatch: \.\/future-driver\.mjs targets SDK v2, this build supports v1/,
  );
  assert.equal(registry.get("./future-driver.mjs"), undefined);
});

test("a malformed module (no create) fails loud with box_pool_driver_module_invalid", async () => {
  const dir = await tempDir("box-driver-loader");
  await writeFixture(dir, "broken-driver.mjs", `export default { kind: "broken" };`);
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureBoxDriverLoaded("./broken-driver.mjs", registry, { baseDir: dir }),
    /box_pool_driver_module_invalid: \.\/broken-driver\.mjs.*create/,
  );
});

test("a module without a default export fails loud and points at #name", async () => {
  const dir = await tempDir("box-driver-loader");
  await writeFixture(dir, "no-default.mjs", `export const somethingElse = 1;`);
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureBoxDriverLoaded("./no-default.mjs", registry, { baseDir: dir }),
    /box_pool_driver_module_invalid: \.\/no-default\.mjs has no default export.*somethingElse/,
  );
});

// ---------------------------------------------------------------------------
// bare-specifier resolution failures
// ---------------------------------------------------------------------------

test("an unknown bare specifier fails loud listing the known kinds", async () => {
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureBoxDriverLoaded("definitely-not-a-real-driver-pkg", registry, {}),
    /box_pool_driver_unavailable: definitely-not-a-real-driver-pkg.*known kinds: .*fake/,
  );
});

test("a near-miss bare specifier appends a did-you-mean hint", async () => {
  const registry = privateRegistry(["docker"]);

  await assert.rejects(
    () => ensureBoxDriverLoaded("dokcer", registry, {}),
    /box_pool_driver_unavailable: dokcer.*did you mean "docker"\?/,
  );
});

test("cache-busting query strings are rejected", async () => {
  const registry = privateRegistry();

  await assert.rejects(
    () => ensureBoxDriverLoaded("./driver.mjs?bust=1", registry, {}),
    /box_pool_driver_invalid_specifier: .*query strings are not supported/,
  );
});

test("parseBoxDriverRef splits the #exportName suffix and keeps plain specifiers whole", () => {
  assert.deepEqual(parseBoxDriverRef("@acme/box-driver"), {
    specifier: "@acme/box-driver",
    exportName: undefined,
  });
  assert.deepEqual(parseBoxDriverRef("./drivers/acme.mjs#acmeDriver"), {
    specifier: "./drivers/acme.mjs",
    exportName: "acmeDriver",
  });
  assert.throws(() => parseBoxDriverRef("#name"), /empty module specifier/);
  assert.throws(() => parseBoxDriverRef("./driver.mjs#"), /empty #exportName/);
});

// ---------------------------------------------------------------------------
// reload semantics: hot-load on a NEW specifier, pinning on a re-encounter
// ---------------------------------------------------------------------------

test("reload: coordinator.reconcile hot-loads a NEW specifier before the pool swaps to it", async () => {
  const dir = await tempDir("box-driver-loader");
  const specA = await writeFixture(
    dir,
    "driver-a.mjs",
    driverModuleSource({ kind: "alpha", scheme: "alpha" }),
  );
  const specB = await writeFixture(
    dir,
    "driver-b.mjs",
    driverModuleSource({ kind: "beta", scheme: "beta" }),
  );
  const registry = privateRegistry();
  const { events, logEvent } = recordingLog();

  // Startup: load + construct the REAL pool on driver A (mirrors buildBoxPool).
  const initial = poolSettings(dir, specA).worker.boxPool!;
  await ensureBoxDriverLoaded(initial.driver, registry, { baseDir: dir, logEvent });
  const pool = createBoxPool(initial, {
    clock: systemClock,
    logEvent,
    ledgerPath: path.join(dir, "ledger.json"),
    drivers: registry,
  });
  const coordinator = createDispatchCoordinator({
    pool,
    mcpEndpointManager: nullEndpointManager,
    settings: initial,
    driverLoader: (driver) => ensureBoxDriverLoaded(driver, registry, { baseDir: dir, logEvent }),
  });

  // Reload to driver B: the injected loader hot-loads the new specifier, then
  // the (synchronous) pool reconcile swaps to it via the registry.
  const next = poolSettings(dir, specB).worker.boxPool!;
  await coordinator.reconcile(next);
  assert.ok(registry.get(specB));
  const loadedKinds = events
    .filter((event) => event.event === "box_pool_driver_loaded")
    .map((event) => event.kind);
  assert.deepEqual(loadedKinds, ["alpha", "beta"]);

  // The next acquire provisions through the hot-loaded driver B.
  const acquired = await coordinator.acquireRunSlot({
    issueId: "ISS-2",
    slotIndex: 0,
    labels: [],
    timeoutMs: 5_000,
  });
  assert.equal(acquired.status, "bound");
  if (acquired.status !== "bound") return;
  assert.match(acquired.slot.workerHost, /^beta:\/\/box-/);
  await acquired.slot.release("healthy");
  await coordinator.drain({ deadlineMs: 5_000 });
});

test("reload: re-encountering an already-loaded specifier emits box_pool_driver_module_pinned", async () => {
  const dir = await tempDir("box-driver-loader");
  const specifier = await writeFixture(
    dir,
    "pinned-driver.mjs",
    driverModuleSource({ kind: "pinned", scheme: "pinned" }),
  );
  const registry = privateRegistry();
  const { events, logEvent } = recordingLog();

  await ensureBoxDriverLoaded(specifier, registry, { baseDir: dir, logEvent });
  const factory = registry.get(specifier);

  // A reload that keeps the same specifier: no re-import (Node's ESM cache pins
  // the code for the daemon lifetime), same factory, observable pinned event.
  await ensureBoxDriverLoaded(specifier, registry, { baseDir: dir, logEvent });
  assert.equal(registry.get(specifier), factory);
  assert.equal(events.filter((event) => event.event === "box_pool_driver_loaded").length, 1);
  assert.deepEqual(
    events.filter((event) => event.event === "box_pool_driver_module_pinned"),
    [{ event: "box_pool_driver_module_pinned", specifier }],
  );

  // A registered KIND hit (the built-in path) stays silent: no pinned event for
  // a driver this loader never imported.
  await ensureBoxDriverLoaded("fake", registry, { baseDir: dir, logEvent });
  assert.equal(events.filter((event) => event.event === "box_pool_driver_module_pinned").length, 1);
});
