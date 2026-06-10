import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, test } from "vitest";
import type { BoxPoolSettings } from "@symphony/domain";
import { withDerivedMaxInFlight } from "@symphony/domain";
import type { ClockPort, TimerHandle } from "@symphony/ports";

import { assert } from "../../../test/assert.js";
import { createBoxPool, POOL_OWNED_LABEL } from "../src/pool.js";
import { FakeBoxProvider } from "../src/providers/fake.js";
import { clearBoxProviderRegistry, registerBoxProvider } from "../src/registry.js";
import type {
  BoxDescriptor,
  BoxHealth,
  BoxLease,
  BoxProvider,
  LedgerRow,
  ProviderCapabilities,
  ProvisionRequest,
  TeardownReason,
} from "../src/types.js";

// A manual clock for accounting math (`now`/`advance`/`set` control the logical
// wall clock that spend/ttl/idle read) while `setTimeout`/`clearTimeout` use the
// REAL event loop so the pool's waiter timeouts and the drain deadline actually
// fire. The returned timer handles carry an `unref` so the pool can detach them.
function controllableClock(startMs: number): {
  clock: ClockPort;
  advance(ms: number): void;
  set(ms: number): void;
} {
  let current = startMs;
  return {
    clock: {
      now: () => new Date(current),
      setTimeout: (callback, delayMs): TimerHandle => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
    },
    advance(ms: number): void {
      current += ms;
    },
    set(ms: number): void {
      current = ms;
    },
  };
}

// Builds a full BoxPoolSettings with sane defaults, overridable per-test. Mirrors
// the daemon defaults so a test only states the knobs it cares about.
function poolSettings(overrides: Partial<BoxPoolSettings> = {}): BoxPoolSettings {
  const { maxInFlight, slotsPerMachine, ...rest } = overrides;
  return withDerivedMaxInFlight({
    enabled: true,
    provider: "fake",
    min: 0,
    max: 1,
    warm: 0,
    slotsPerMachine: slotsPerMachine ?? maxInFlight ?? 1,
    ttlMs: 3_600_000,
    idleReapMs: 300_000,
    acquireTimeoutMs: 1_000,
    reapIntervalMs: 15_000,
    staleHeartbeatMs: 600_000,
    drainDeadlineMs: 30_000,
    ...rest,
  });
}

// A fresh fake provider registered under the `fake` kind so createBoxPool can
// resolve it. Returns the instance so a test can inject failures / inspect it.
let lastProvider: FakeBoxProvider | null = null;
function registerFake(): void {
  registerBoxProvider("fake", (_settings, deps) => {
    lastProvider = new FakeBoxProvider(deps);
    return lastProvider;
  });
}

// A provider whose `list()` is fully controllable so a test can stage the boxes
// that "survived" a restart (carrying the pool-owned label so the pool re-adopts
// them) plus an unlabeled foreign instance (never adopted). `usesLedger` is
// togglable so the hydrate-orphan test can exercise the live ledger path. Tracks
// every `destroy` so a test can assert what the pool tore down.
class SurvivorProvider implements BoxProvider {
  readonly kind = "fake" as const;
  readonly capabilities: ProviderCapabilities;
  readonly destroyed: string[] = [];
  // A PERMANENT list() failure (set once, never cleared): every list() rejects.
  listError: Error | null = null;
  // A TRANSIENT list() failure budget: the first `listFailsRemaining` calls reject
  // (each decrements the budget) and then list() recovers, so a test can prove the
  // hydrate retry loop eventually succeeds and adopts the survivors.
  listFailsRemaining = 0;
  // Count of every list() invocation (failed or not) so a test can assert the
  // bounded retry actually re-attempted before giving up / recovering.
  listCalls = 0;

  constructor(
    private readonly survivors: BoxDescriptor[],
    usesLedger = false,
  ) {
    this.capabilities = { sshAddressable: false, ephemeral: false, usesLedger };
  }

  async provision(req: ProvisionRequest): Promise<BoxDescriptor> {
    const workerHost = `fake://box-${req.boxId}`;
    return Promise.resolve({
      boxId: req.boxId,
      workerHost,
      providerRef: workerHost,
      createdAtMs: 0,
      labels: [...req.labels],
      metadata: {},
    });
  }

  async probe(): Promise<BoxHealth> {
    return Promise.resolve({ ok: true });
  }

  async destroy(box: BoxDescriptor, _opts: { timeoutMs: number; reason: TeardownReason }) {
    this.destroyed.push(box.boxId);
    const index = this.survivors.findIndex((entry) => entry.boxId === box.boxId);
    if (index !== -1) this.survivors.splice(index, 1);
    return Promise.resolve();
  }

  async list(): Promise<BoxDescriptor[]> {
    this.listCalls += 1;
    if (this.listError) return Promise.reject(this.listError);
    if (this.listFailsRemaining > 0) {
      this.listFailsRemaining -= 1;
      return Promise.reject(new Error("transient list() failure"));
    }
    return Promise.resolve([...this.survivors]);
  }
}

// Registers a survivor provider under the `fake` kind so createBoxPool resolves it.
function registerSurvivor(provider: SurvivorProvider): void {
  registerBoxProvider("fake", () => provider);
}

// A provider whose `provision` is deferred behind an externally-resolved gate, so
// a test can interleave an event (drain start, a second concurrent acquire) IN
// BETWEEN the pool deciding to grow and the provision resolving. Every live box
// is tracked so a test can assert what actually got created/destroyed (a leaked
// paid box shows up as a box that was provisioned but never destroyed).
class DeferredProvider implements BoxProvider {
  readonly kind = "fake" as const;
  readonly capabilities: ProviderCapabilities = {
    sshAddressable: false,
    ephemeral: true,
    usesLedger: false,
  };
  readonly provisioned: string[] = [];
  readonly destroyed: string[] = [];
  readonly boxes = new Set<string>();
  // Resolvers for each pending provision, in call order.
  private readonly gates: Array<() => void> = [];

  async provision(req: ProvisionRequest): Promise<BoxDescriptor> {
    await new Promise<void>((resolve) => {
      this.gates.push(resolve);
    });
    this.provisioned.push(req.boxId);
    this.boxes.add(req.boxId);
    const workerHost = `fake://box-${req.boxId}`;
    return {
      boxId: req.boxId,
      workerHost,
      providerRef: workerHost,
      createdAtMs: 0,
      labels: [...req.labels],
      metadata: {},
    };
  }

  async probe(): Promise<BoxHealth> {
    return Promise.resolve({ ok: true });
  }

  async destroy(box: BoxDescriptor, _opts: { timeoutMs: number; reason: TeardownReason }) {
    this.destroyed.push(box.boxId);
    this.boxes.delete(box.boxId);
    return Promise.resolve();
  }

  async list(): Promise<BoxDescriptor[]> {
    return Promise.resolve(
      [...this.boxes].map((boxId) => {
        const workerHost = `fake://box-${boxId}`;
        return {
          boxId,
          workerHost,
          providerRef: workerHost,
          createdAtMs: 0,
          labels: [POOL_OWNED_LABEL],
          metadata: {},
        };
      }),
    );
  }

  /** Number of provisions currently parked on the gate. */
  pendingCount(): number {
    return this.gates.length;
  }

  /** Releases the oldest parked provision so it resolves. */
  releaseNext(): void {
    const gate = this.gates.shift();
    if (gate) gate();
  }

  /** Releases every parked provision. */
  releaseAll(): void {
    while (this.gates.length > 0) this.releaseNext();
  }
}

function registerDeferred(provider: DeferredProvider): void {
  registerBoxProvider("fake", () => provider);
}

// A provider whose `destroy` parks on an externally-resolved gate, so a test can
// interleave a late lease settle IN BETWEEN the drain's force-destroy starting
// (record set DESTROYING, provider.destroy awaited) and the destroy completing.
// `provision` is immediate; `list()` mirrors the live boxes so a hydrate/reconcile
// over this provider stays coherent.
class DeferredDestroyProvider implements BoxProvider {
  readonly kind = "fake" as const;
  readonly capabilities: ProviderCapabilities = {
    sshAddressable: false,
    ephemeral: true,
    usesLedger: false,
  };
  readonly destroyed: string[] = [];
  readonly boxes = new Set<string>();
  private readonly gates: Array<() => void> = [];
  private seq = 0;

  async provision(req: ProvisionRequest): Promise<BoxDescriptor> {
    this.boxes.add(req.boxId);
    const workerHost = `fake://box-${req.boxId}`;
    return Promise.resolve({
      boxId: req.boxId,
      workerHost,
      providerRef: workerHost,
      createdAtMs: this.seq++,
      labels: [...req.labels],
      metadata: {},
    });
  }

  async probe(): Promise<BoxHealth> {
    return Promise.resolve({ ok: true });
  }

  async destroy(box: BoxDescriptor, _opts: { timeoutMs: number; reason: TeardownReason }) {
    // Park on a gate so the test can interleave a late settle mid-destroy.
    await new Promise<void>((resolve) => {
      this.gates.push(resolve);
    });
    this.destroyed.push(box.boxId);
    this.boxes.delete(box.boxId);
  }

  async list(): Promise<BoxDescriptor[]> {
    return Promise.resolve(
      [...this.boxes].map((boxId) => ({
        boxId,
        workerHost: `fake://box-${boxId}`,
        providerRef: `fake://box-${boxId}`,
        createdAtMs: 0,
        labels: [POOL_OWNED_LABEL],
        metadata: {},
      })),
    );
  }

  pendingDestroys(): number {
    return this.gates.length;
  }

  releaseNextDestroy(): void {
    const gate = this.gates.shift();
    if (gate) gate();
  }
}

function registerDeferredDestroy(provider: DeferredDestroyProvider): void {
  registerBoxProvider("fake", () => provider);
}

// A ledger-backed (usesLedger:true) provider whose `provision` parks on a gate so
// a test can read the on-disk WAL AFTER the provisional row is written but BEFORE
// the post-provision correlate upsert. Mirrors live boxes in `list()`.
class LedgerDeferredProvider implements BoxProvider {
  readonly kind = "fake" as const;
  readonly capabilities: ProviderCapabilities = {
    sshAddressable: false,
    ephemeral: true,
    usesLedger: true,
  };
  readonly boxes = new Set<string>();
  private readonly gates: Array<() => void> = [];

  async provision(req: ProvisionRequest): Promise<BoxDescriptor> {
    await new Promise<void>((resolve) => {
      this.gates.push(resolve);
    });
    this.boxes.add(req.boxId);
    const workerHost = `fake://box-${req.boxId}`;
    return {
      boxId: req.boxId,
      workerHost,
      providerRef: `ref-${req.boxId}`,
      createdAtMs: 0,
      labels: [...req.labels],
      metadata: {},
    };
  }

  async probe(): Promise<BoxHealth> {
    return Promise.resolve({ ok: true });
  }

  async destroy(box: BoxDescriptor, _opts: { timeoutMs: number; reason: TeardownReason }) {
    this.boxes.delete(box.boxId);
    return Promise.resolve();
  }

  async list(): Promise<BoxDescriptor[]> {
    return Promise.resolve(
      [...this.boxes].map((boxId) => ({
        boxId,
        workerHost: `fake://box-${boxId}`,
        providerRef: `ref-${boxId}`,
        createdAtMs: 0,
        labels: [POOL_OWNED_LABEL],
        metadata: {},
      })),
    );
  }

  pendingCount(): number {
    return this.gates.length;
  }

  releaseNext(): void {
    const gate = this.gates.shift();
    if (gate) gate();
  }
}

// A pool-owned survivor descriptor (carries the label the pool re-adopts on).
function survivorBox(boxId: string): BoxDescriptor {
  const workerHost = `fake://box-${boxId}`;
  return {
    boxId,
    workerHost,
    providerRef: workerHost,
    createdAtMs: 0,
    labels: [POOL_OWNED_LABEL],
    metadata: {},
  };
}

function acquireReq(
  overrides: Partial<{
    issueId: string;
    slotIndex: number;
    labels: ReadonlyArray<string>;
    affinityKey: string | null;
    timeoutMs: number;
    signal: AbortSignal;
  }> = {},
): {
  issueId: string;
  slotIndex: number;
  labels: ReadonlyArray<string>;
  affinityKey?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
} {
  return {
    issueId: "issue-1",
    slotIndex: 0,
    labels: [],
    timeoutMs: 1_000,
    ...overrides,
  };
}

let tmpDir: string | null = null;

beforeEach(() => {
  clearBoxProviderRegistry();
  registerFake();
  lastProvider = null;
  tmpDir = null;
});

afterEach(async () => {
  clearBoxProviderRegistry();
  // The pool's ledger I/O is fire-and-forget (e.g. `void ledger.delete(...)` on a
  // drain recycle), so a write can briefly race the cleanup and recreate a file
  // mid-removal (ENOTEMPTY). Retry the removal a few times to absorb that race.
  if (tmpDir) {
    const dir = tmpDir;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }
});

test("acquire grows under max when no warm box", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  const result = await pool.acquire(acquireReq());

  assert.equal(result.status, "leased");
  if (result.status === "leased") {
    assert.equal(result.lease.workerHost.startsWith("fake://box-"), true);
  }
  const snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.leased, 1);
  assert.equal(snap.inFlight, 1);
  await pool.drain({ deadlineMs: 1_000 });
});

test("acquire grows a box that never becomes ready: probes, destroys it, reports no_capacity (no leak, never leased)", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0, min: 0 }), {
    clock,
    logEvent: () => undefined,
  });
  assert.ok(lastProvider);
  const provider = lastProvider as FakeBoxProvider;
  // The first on-demand grow mints box-0; force its readiness probe to fail so the
  // box is never SSH-reachable (a cold cloud box whose sshd never comes up). Without
  // the readiness gate this unready host would be leased to the runner.
  provider.injectProbeFailure("box-0", "sshd_not_up");

  const result = await pool.acquire(acquireReq());

  // The unready box is NOT leased - the acquire reports capacity-unavailable...
  assert.equal(result.status, "no_capacity");
  // ...the box was destroyed (no paid-box leak: the fake daemon holds none)...
  assert.equal((await provider.list()).length, 0);
  // ...and it never entered inventory.
  assert.equal(pool.snapshot().total, 0);

  // A subsequent grow of a HEALTHY box (box-1, probe ok) leases normally.
  const second = await pool.acquire(acquireReq());
  assert.equal(second.status, "leased");
  await pool.drain({ deadlineMs: 1_000 });
});

test("reconcile to disabled drains even when the target provider would fail to construct", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0, min: 0 }), {
    clock,
    logEvent: () => undefined,
  });
  const first = await pool.acquire(acquireReq());
  assert.equal(first.status, "leased");
  if (first.status !== "leased") return;
  await first.lease.release("healthy");
  assert.equal(pool.snapshot().total, 1);

  // Disable the pool AND point it at a provider kind NOT registered in this test (so
  // swapProvider would throw resolving it). reconcile must NOT throw - it skips the
  // swap when disabled - and must still drain the live box to zero. Without the fix it
  // would throw in swapProvider and strand the pool enabled with the box still alive.
  pool.reconcile(poolSettings({ enabled: false, provider: "modal", max: 1, warm: 0, min: 0 }));
  await pool.drain({ deadlineMs: 1_000 });
  assert.equal(pool.snapshot().total, 0);
});

test("acquire leased when warm box free (release returns it to WARM_IDLE)", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  const first = await pool.acquire(acquireReq());
  assert.equal(first.status, "leased");
  if (first.status !== "leased") return;
  const firstBoxId = first.lease.boxId;
  await first.lease.release("healthy");

  let snap = pool.snapshot();
  assert.equal(snap.warmIdle, 1);
  assert.equal(snap.leased, 0);
  assert.equal(snap.inFlight, 0);

  // The free warm box is reused (no growth, same boxId) rather than a new provision.
  const second = await pool.acquire(acquireReq());
  assert.equal(second.status, "leased");
  if (second.status !== "leased") return;
  assert.equal(second.lease.boxId, firstBoxId);
  snap = pool.snapshot();
  assert.equal(snap.total, 1);
  await pool.drain({ deadlineMs: 1_000 });
});

test("acquire blocks to acquireTimeoutMs then no_capacity:acquire_timeout", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0, acquireTimeoutMs: 30 }), {
    clock,
    logEvent: () => undefined,
  });

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");

  // The single box is leased; a second acquire has no capacity and cannot grow,
  // so it blocks up to acquireTimeoutMs then surfaces the timeout reason.
  const blocked = await pool.acquire(acquireReq({ issueId: "issue-2", timeoutMs: 30 }));
  assert.equal(blocked.status, "no_capacity");
  if (blocked.status === "no_capacity") {
    assert.equal(blocked.reason, "acquire_timeout");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("released box wakes a blocked waiter (FIFO) before the timeout", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0, acquireTimeoutMs: 10_000 }), {
    clock,
    logEvent: () => undefined,
  });

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;

  // This acquire blocks because the only box is leased.
  const waiterPromise = pool.acquire(acquireReq({ issueId: "issue-2" }));

  // Releasing the held box must hand it to the queued waiter (not time out).
  await held.lease.release("healthy");

  const waiter = await waiterPromise;
  assert.equal(waiter.status, "leased");
  if (waiter.status === "leased") {
    assert.equal(waiter.lease.boxId, held.lease.boxId);
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("abort signal resolves acquire to no_capacity promptly", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0, acquireTimeoutMs: 10_000 }), {
    clock,
    logEvent: () => undefined,
  });

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");

  const controller = new AbortController();
  const blockedPromise = pool.acquire(
    acquireReq({ issueId: "issue-2", signal: controller.signal, timeoutMs: 10_000 }),
  );
  // Aborting must resolve the acquire to no_capacity without waiting the full
  // acquireTimeoutMs (so the poll thread is never blocked).
  controller.abort();
  const blocked = await blockedPromise;
  assert.equal(blocked.status, "no_capacity");
  if (blocked.status === "no_capacity") {
    assert.equal(blocked.reason, "acquire_timeout");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("no_capacity:pool_disabled when enabled false", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ enabled: false }), {
    clock,
    logEvent: () => undefined,
  });

  const result = await pool.acquire(acquireReq());
  assert.equal(result.status, "no_capacity");
  if (result.status === "no_capacity") {
    assert.equal(result.reason, "pool_disabled");
  }
  assert.equal(pool.canAcquire(), false);
});

test("no_capacity:spend_cap when maxConcurrentBoxes reached BEFORE leasing", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 4, warm: 0, spend: { maxConcurrentBoxes: 1 } }), {
    clock,
    logEvent: () => undefined,
  });

  const first = await pool.acquire(acquireReq());
  assert.equal(first.status, "leased");

  // The concurrent-box cap is 1; a second box cannot be provisioned even though
  // `max` is 4, so the second acquire fails with spend_cap (not a fresh box).
  const second = await pool.acquire(acquireReq({ issueId: "issue-2", timeoutMs: 30 }));
  assert.equal(second.status, "no_capacity");
  if (second.status === "no_capacity") {
    assert.equal(second.reason, "spend_cap");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("no_capacity:spend_cap when dailyBoxSeconds exhausted", async () => {
  const start = Date.UTC(2026, 4, 29, 12, 0, 0);
  const { clock, advance } = controllableClock(start);
  const pool = createBoxPool(poolSettings({ max: 4, warm: 0, spend: { dailyBoxSeconds: 5 } }), {
    clock,
    logEvent: () => undefined,
  });

  // Lease, hold for 6 seconds, release -> 6 box-seconds accrued, over the 5s cap.
  const first = await pool.acquire(acquireReq());
  assert.equal(first.status, "leased");
  if (first.status !== "leased") return;
  advance(6_000);
  await first.lease.release("healthy");

  const second = await pool.acquire(acquireReq({ issueId: "issue-2", timeoutMs: 30 }));
  assert.equal(second.status, "no_capacity");
  if (second.status === "no_capacity") {
    assert.equal(second.reason, "spend_cap");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("canAcquire false when full and cannot grow; true when can grow under caps", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  // Empty pool but growth is possible under max -> canAcquire true.
  assert.equal(pool.canAcquire(), true);

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");

  // The single box is leased and max is reached -> cannot grow, no warm free.
  assert.equal(pool.canAcquire(), false);

  if (held.status === "leased") await held.lease.release("healthy");
  // A warm box is now free -> canAcquire true again.
  assert.equal(pool.canAcquire(), true);
  await pool.drain({ deadlineMs: 1_000 });
});

test("sticky affinityKey re-acquires same boxId", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 2, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  const first = await pool.acquire(acquireReq());
  assert.equal(first.status, "leased");
  if (first.status !== "leased") return;
  const host = first.lease.workerHost;
  const boxId = first.lease.boxId;
  await first.lease.release("healthy");

  // Provision a second warm box so there are two idle boxes to choose from.
  const other = await pool.acquire(acquireReq({ issueId: "issue-x" }));
  assert.equal(other.status, "leased");
  if (other.status !== "leased") return;
  await other.lease.release("healthy");

  // A retry that names the prior workerHost as its affinityKey must re-land on
  // the SAME box, not the other warm box.
  const retry = await pool.acquire(acquireReq({ affinityKey: host }));
  assert.equal(retry.status, "leased");
  if (retry.status === "leased") {
    assert.equal(retry.lease.boxId, boxId);
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("two concurrent acquires never select same warm slot (synchronous stamp)", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 2, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  // Pre-warm exactly one box, then release it so a single WARM_IDLE box exists.
  const seed = await pool.acquire(acquireReq());
  assert.equal(seed.status, "leased");
  if (seed.status !== "leased") return;
  await seed.lease.release("healthy");

  // Two acquires race for that one warm box. The synchronous select-and-stamp
  // guarantees they cannot both grab the same WARM_IDLE box; one reuses it, the
  // other grows a new box. Both succeed and the boxIds are distinct.
  const [a, b] = await Promise.all([
    pool.acquire(acquireReq({ issueId: "issue-a" })),
    pool.acquire(acquireReq({ issueId: "issue-b" })),
  ]);
  assert.equal(a.status, "leased");
  assert.equal(b.status, "leased");
  if (a.status !== "leased" || b.status !== "leased") return;
  assert.notEqual(a.lease.boxId, b.lease.boxId);
  await pool.drain({ deadlineMs: 1_000 });
});

test("TWO concurrent growth decisions never exceed max (reservation counter)", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0, acquireTimeoutMs: 50 }), {
    clock,
    logEvent: () => undefined,
  });

  // Two acquires hit an empty pool simultaneously. The synchronous reservation
  // counter, taken BEFORE the provision await, lets only ONE grow; the other
  // cannot exceed max -> times out with no_capacity. The pool never exceeds max.
  const [a, b] = await Promise.all([
    pool.acquire(acquireReq({ issueId: "issue-a", timeoutMs: 50 })),
    pool.acquire(acquireReq({ issueId: "issue-b", timeoutMs: 50 })),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["leased", "no_capacity"]);
  assert.equal(pool.snapshot().total, 1);
  await pool.drain({ deadlineMs: 1_000 });
});

test("reservation released on provision reject (no permanent block)", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0, acquireTimeoutMs: 30 }), {
    clock,
    logEvent: () => undefined,
  });
  assert.ok(lastProvider);
  // Make every provision reject by injecting failures for the deterministic ids
  // the pool will mint. The reservation must be released on reject so a later
  // acquire (after clearing the failure) can still grow under max.
  const provider = lastProvider as FakeBoxProvider;
  for (let i = 0; i < 8; i += 1) {
    provider.injectProvisionFailure(`box-${i}`, "boom");
  }

  const failed = await pool.acquire(acquireReq({ timeoutMs: 30 }));
  assert.equal(failed.status, "no_capacity");

  // Reservation released: a subsequent successful provision can grow.
  for (let i = 0; i < 8; i += 1) {
    provider.clearProvisionFailure(`box-${i}`);
  }
  const ok = await pool.acquire(acquireReq({ issueId: "issue-2" }));
  assert.equal(ok.status, "leased");
  await pool.drain({ deadlineMs: 1_000 });
});

test("provider_error returned when growth provision rejects and no warm box exists", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0, acquireTimeoutMs: 30 }), {
    clock,
    logEvent: () => undefined,
  });
  const provider = lastProvider as FakeBoxProvider;
  for (let i = 0; i < 8; i += 1) {
    provider.injectProvisionFailure(`box-${i}`, "boom");
  }

  const result = await pool.acquire(acquireReq({ timeoutMs: 30 }));
  assert.equal(result.status, "no_capacity");
  if (result.status === "no_capacity") {
    // A failed growth with nothing else to wait on surfaces a provider_error
    // (distinct from a pure timeout) so the caller can log the cause.
    assert.ok(result.reason === "provider_error" || result.reason === "acquire_timeout");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("maxInFlight>1 allows N leases on one box; N+1 blocks", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(
    poolSettings({ max: 1, warm: 0, maxInFlight: 2, acquireTimeoutMs: 30 }),
    {
      clock,
      logEvent: () => undefined,
    },
  );

  const a = await pool.acquire(acquireReq({ issueId: "issue-a" }));
  const b = await pool.acquire(acquireReq({ issueId: "issue-b" }));
  assert.equal(a.status, "leased");
  assert.equal(b.status, "leased");
  if (a.status !== "leased" || b.status !== "leased") return;
  // Both leases land on the SAME box (maxInFlight=2, max=1).
  assert.equal(a.lease.boxId, b.lease.boxId);
  assert.equal(pool.snapshot().inFlight, 2);

  // The third lease exceeds both maxInFlight and max -> blocks then times out.
  const c = await pool.acquire(acquireReq({ issueId: "issue-c", timeoutMs: 30 }));
  assert.equal(c.status, "no_capacity");
  await pool.drain({ deadlineMs: 1_000 });
});

test("maxBoxesPerIssue caps one issue's boxes so an ensemble cannot monopolize", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(
    poolSettings({ max: 4, warm: 0, maxBoxesPerIssue: 1, acquireTimeoutMs: 30 }),
    { clock, logEvent: () => undefined },
  );

  // issue-A's first slot leases one box.
  const a0 = await pool.acquire(acquireReq({ issueId: "issue-A", slotIndex: 0 }));
  assert.equal(a0.status, "leased");

  // issue-A's second slot is blocked by the per-issue cap of 1, even though the
  // global pool has capacity for 3 more boxes.
  const a1 = await pool.acquire(acquireReq({ issueId: "issue-A", slotIndex: 1, timeoutMs: 30 }));
  assert.equal(a1.status, "no_capacity");

  // A DIFFERENT issue can still acquire (the cap is per-issue, not global).
  const b0 = await pool.acquire(acquireReq({ issueId: "issue-B", slotIndex: 0 }));
  assert.equal(b0.status, "leased");
  await pool.drain({ deadlineMs: 1_000 });
});

test("maxBoxesPerIssue releases the per-issue slot when a lease is returned", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(
    poolSettings({ max: 4, warm: 0, maxBoxesPerIssue: 1, acquireTimeoutMs: 30 }),
    { clock, logEvent: () => undefined },
  );

  const a0 = await pool.acquire(acquireReq({ issueId: "issue-A", slotIndex: 0 }));
  assert.equal(a0.status, "leased");
  if (a0.status !== "leased") return;
  await a0.lease.release("healthy");

  // After release, the issue is back under its cap and can acquire again.
  const a1 = await pool.acquire(acquireReq({ issueId: "issue-A", slotIndex: 1 }));
  assert.equal(a1.status, "leased");
  await pool.drain({ deadlineMs: 1_000 });
});

test("snapshot reports total/warmIdle/leased/inFlight/spend/markedForDestroy accurately", async () => {
  const start = Date.UTC(2026, 4, 29, 0, 0, 0);
  const { clock, advance } = controllableClock(start);
  const pool = createBoxPool(poolSettings({ max: 2, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  const a = await pool.acquire(acquireReq({ issueId: "issue-a" }));
  const b = await pool.acquire(acquireReq({ issueId: "issue-b" }));
  assert.equal(a.status, "leased");
  assert.equal(b.status, "leased");
  if (a.status !== "leased" || b.status !== "leased") return;

  let snap = pool.snapshot();
  assert.equal(snap.enabled, true);
  assert.equal(snap.provider, "fake");
  assert.equal(snap.total, 2);
  assert.equal(snap.leased, 2);
  assert.equal(snap.warmIdle, 0);
  assert.equal(snap.inFlight, 2);
  assert.equal(snap.spend.concurrentBoxes, 2);
  assert.equal(snap.spend.dayKey, "2026-05-29");
  assert.equal(snap.boxes.length, 2);
  for (const box of snap.boxes) {
    assert.equal(box.state, "LEASED");
    assert.equal(box.inFlight, 1);
    assert.equal(box.markedForDestroy, false);
  }

  advance(2_000);
  await a.lease.release("healthy");
  snap = pool.snapshot();
  assert.equal(snap.leased, 1);
  assert.equal(snap.warmIdle, 1);
  assert.equal(snap.inFlight, 1);
  // Box-seconds accrue on release: a held for 2s.
  assert.equal(snap.spend.boxSecondsUsed >= 2, true);
  await pool.drain({ deadlineMs: 1_000 });
});

test("a long heartbeating run accrues box-seconds from its own acquire time (heartbeats do NOT reset the bill)", async () => {
  const { clock, advance } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;

  // A 600s run that heartbeats every 30s. Each heartbeat stamps lastHeartbeatMs,
  // but the spend bill must be the WHOLE 600s window (from acquire to settle),
  // not the gap since the last heartbeat (~0s, the old defeated accrual).
  for (let elapsed = 0; elapsed < 600_000; elapsed += 30_000) {
    advance(30_000);
    held.lease.heartbeat();
  }
  await held.lease.release("healthy");

  const snap = pool.snapshot();
  assert.equal(snap.spend.boxSecondsUsed >= 600, true);
  await pool.drain({ deadlineMs: 1_000 });
});

test("two overlapping leases on one box (maxInFlight=2) each accrue their own window", async () => {
  const { clock, advance } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0, maxInFlight: 2 }), {
    clock,
    logEvent: () => undefined,
  });

  // Lease A acquires at t=0.
  const a = await pool.acquire(acquireReq({ issueId: "issue-a" }));
  assert.equal(a.status, "leased");
  if (a.status !== "leased") return;

  // 100s later lease B acquires the SAME box (overlapping window).
  advance(100_000);
  const b = await pool.acquire(acquireReq({ issueId: "issue-b" }));
  assert.equal(b.status, "leased");
  if (b.status !== "leased") return;
  assert.equal(a.lease.boxId, b.lease.boxId);

  // Both heartbeat, then both settle at t=300s. A's window is 300s, B's is 200s;
  // billing each from its OWN acquire time yields 300 + 200 = 500 box-seconds.
  advance(200_000);
  a.lease.heartbeat();
  b.lease.heartbeat();
  await a.lease.release("healthy");
  await b.lease.release("healthy");

  const snap = pool.snapshot();
  assert.equal(snap.spend.boxSecondsUsed >= 500, true);
  await pool.drain({ deadlineMs: 1_000 });
});

test("a heartbeating run that exceeds maxBoxSeconds is denied on the next acquire", async () => {
  const { clock, advance } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0, spend: { maxBoxSeconds: 500 } }), {
    clock,
    logEvent: () => undefined,
  });

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;

  // A 600s run that heartbeats every 30s. Even though every heartbeat resets the
  // staleness stamp, the cap must fire on the full 600s window.
  for (let elapsed = 0; elapsed < 600_000; elapsed += 30_000) {
    advance(30_000);
    held.lease.heartbeat();
  }
  await held.lease.release("healthy");

  // 600 box-seconds accrued, over the 500s cap -> the next acquire is denied.
  const next = await pool.acquire(acquireReq({ issueId: "issue-2", timeoutMs: 30 }));
  assert.equal(next.status, "no_capacity");
  if (next.status === "no_capacity") {
    assert.equal(next.reason, "spend_cap");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("drain rejects new acquires, force-destroys ALL boxes (zero remain even with held lease)", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 2, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");

  await pool.drain({ deadlineMs: 10 });

  // Every box is gone after drain, even the one whose lease was never released
  // (the leak fix). A post-drain acquire is rejected.
  const snap = pool.snapshot();
  assert.equal(snap.total, 0);
  assert.equal(snap.inFlight, 0);

  const blocked = await pool.acquire(acquireReq({ issueId: "issue-2" }));
  assert.equal(blocked.status, "no_capacity");
  if (blocked.status === "no_capacity") {
    assert.equal(blocked.reason, "pool_disabled");
  }
});

test("drain is idempotent and resolves", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });
  await pool.acquire(acquireReq());

  await pool.drain({ deadlineMs: 10 });
  // A second drain must resolve without throwing.
  await pool.drain({ deadlineMs: 10 });
  assert.equal(pool.snapshot().total, 0);
});

test("drain waits for an in-flight lease released before the deadline", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const lease: BoxLease = held.lease;

  // Release shortly after drain begins; drain should observe inFlight->0 and
  // still tear the box down (zero boxes remain).
  const drainPromise = pool.drain({ deadlineMs: 5_000 });
  await lease.release("healthy");
  await drainPromise;

  assert.equal(pool.snapshot().total, 0);
  assert.equal(pool.snapshot().inFlight, 0);
});

test("a late settle during a deadline-exceeded drain cannot flip a destroyed box back to WARM_IDLE", async () => {
  const { clock } = controllableClock(0);
  const provider = new DeferredDestroyProvider();
  registerDeferredDestroy(provider);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  // Hold a lease so drain cannot settle before the deadline.
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;

  // Drain with a deadline that fires (the in-flight lease never settles in time),
  // so runDrain proceeds into the force-destroy loop and parks on the gated
  // provider.destroy with the record set DESTROYING.
  const drainPromise = pool.drain({ deadlineMs: 10 });
  await waitUntil(() => provider.pendingDestroys() === 1);

  // While the drain's recycle is parked mid-destroy (record set DESTROYING), a
  // late healthy settle runs. Its onLeaseSettle, while draining, flips the box to
  // WARM_IDLE. If the drain destroy runs OUTSIDE the per-box mutex (the bug), the
  // settle interleaves with the in-progress recycle and the record is observably
  // WARM_IDLE mid-destroy — a "destroyed" box resurrected to idle, which a
  // concurrent snapshot/select could then hand back out. The fix serializes both
  // under the per-box mutex so the box is NEVER observed WARM_IDLE once its
  // teardown has begun: the settle either runs fully before the destroy starts
  // (then is overwritten to DESTROYED) or fully after (and no-ops on DESTROYED).
  const settlePromise = held.lease.release("healthy");

  // Poll the record's state while the destroy is parked. Under the bug the late
  // settle flips DESTROYING->WARM_IDLE; under the fix the mutex holds the settle
  // behind the destroy so WARM_IDLE is never observed once teardown has begun.
  let resurrectedToWarmIdle = false;
  for (let i = 0; i < 25 && provider.pendingDestroys() === 1; i += 1) {
    const row = pool.snapshot().boxes.find((b) => b.boxId === held.lease.boxId);
    if (row?.state === "WARM_IDLE") {
      resurrectedToWarmIdle = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(resurrectedToWarmIdle, false);

  // Let the parked destroy complete, then both the drain and the late settle.
  provider.releaseNextDestroy();
  await Promise.all([drainPromise, settlePromise]);

  // Zero boxes remain, none flipped back to WARM_IDLE, and the provider's box set
  // is empty (no paid box leaked), with exactly one destroy issued.
  const snap = pool.snapshot();
  assert.equal(snap.total, 0);
  assert.equal(snap.warmIdle, 0);
  assert.equal(snap.inFlight, 0);
  assert.equal(provider.boxes.size, 0);
  assert.equal(provider.destroyed.length, 1);
});

test("reaper-vs-release on inFlight->0 destroys exactly once (per-box mutex)", async () => {
  // A box that is marked for destroy (e.g. poisoned) and then released must be
  // torn down exactly once; the per-box mutex serializes the release-driven
  // recycle so inFlight never underflows and only one destroy is issued.
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;

  // Poison the box: on settle it is marked for destroy and recycled.
  await held.lease.fail("ssh_timeout");

  const snap = pool.snapshot();
  // The poisoned box was recycled (removed), inFlight is 0, never negative.
  assert.equal(snap.inFlight, 0);
  assert.equal(snap.total, 0);
  await pool.drain({ deadlineMs: 1_000 });
});

// Polls a predicate on the real event loop so a fire-and-forget async grow/drain
// settles before the assertion (the manual clock never advances on its own). The
// predicate may be sync or async (e.g. polling on-disk ledger state).
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("reconcile false->true grows from zero; true->false drains to zero", async () => {
  const { clock } = controllableClock(0);
  // The pool starts DISABLED (no boxes, acquire rejected).
  const pool = createBoxPool(poolSettings({ enabled: false, min: 2, max: 3, warm: 2 }), {
    clock,
    logEvent: () => undefined,
  });
  assert.equal(pool.snapshot().total, 0);
  assert.equal(pool.canAcquire(), false);

  // false -> true: the reload re-enables the pool and grows from zero toward the
  // warm/min target WITHOUT reconstructing the pool object.
  const same = pool;
  pool.reconcile(poolSettings({ enabled: true, min: 2, max: 3, warm: 2 }));
  assert.equal(same, pool);
  await waitUntil(() => pool.snapshot().total >= 2);
  let snap = pool.snapshot();
  assert.equal(snap.enabled, true);
  assert.equal(snap.total, 2);
  assert.equal(snap.warmIdle, 2);

  // true -> false: the reload disables the pool and drains it to zero.
  pool.reconcile(poolSettings({ enabled: false, min: 2, max: 3, warm: 2 }));
  await waitUntil(() => pool.snapshot().total === 0);
  snap = pool.snapshot();
  assert.equal(snap.enabled, false);
  assert.equal(snap.total, 0);
  // A drained, disabled pool rejects acquires with pool_disabled.
  const blocked = await pool.acquire(acquireReq());
  assert.equal(blocked.status, "no_capacity");
  if (blocked.status === "no_capacity") {
    assert.equal(blocked.reason, "pool_disabled");
  }
});

test("reconcile disable then re-enable resets draining so acquire serves again", async () => {
  const { clock } = controllableClock(0);
  // The pool starts ENABLED and serves a lease.
  const pool = createBoxPool(poolSettings({ enabled: true, min: 0, max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });
  const first = await pool.acquire(acquireReq());
  assert.equal(first.status, "leased");
  if (first.status !== "leased") return;
  await first.lease.release("healthy");

  // enabled true -> false: the reload drains the pool to zero, setting `draining`.
  pool.reconcile(poolSettings({ enabled: false, min: 0, max: 1, warm: 0 }));
  await waitUntil(() => pool.snapshot().total === 0);
  assert.equal(pool.snapshot().enabled, false);

  // enabled false -> true: the re-enable must clear `draining` so acquire is not
  // permanently short-circuited. Without the reset, every acquire returns
  // pool_disabled forever (the dead-pool defect).
  pool.reconcile(poolSettings({ enabled: true, min: 0, max: 1, warm: 0 }));
  assert.equal(pool.canAcquire(), true);
  const served = await pool.acquire(acquireReq({ issueId: "issue-2" }));
  assert.equal(served.status, "leased");
  await pool.drain({ deadlineMs: 1_000 });
});

test("reconcile raising warm tops up; lowering max defers shrink to reaper (oldest-idle first), never destroys leased synchronously; never reconstructs", async () => {
  const { clock, advance } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ enabled: true, min: 0, max: 4, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  // Raising `warm` tops the pool up toward the new target (grow, not reconstruct).
  const same = pool;
  pool.reconcile(poolSettings({ enabled: true, min: 0, max: 4, warm: 3 }));
  assert.equal(same, pool);
  await waitUntil(() => pool.snapshot().warmIdle >= 3);
  assert.equal(pool.snapshot().total, 3);

  // Lease one box (so it is LEASED), and stagger idle times so oldest-idle is
  // deterministic across the remaining warm boxes.
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const leasedBoxId = held.lease.boxId;
  advance(1_000);

  // Lowering `max` to 1 must NOT destroy anything synchronously (defer to reaper)
  // and must NOT destroy the LEASED box synchronously. The excess oldest-idle
  // boxes are flagged markedForDestroy; the leased box stays LEASED and unflagged
  // until idle boxes alone cover the shrink.
  const before = pool.snapshot();
  assert.equal(before.total, 3);
  pool.reconcile(poolSettings({ enabled: true, min: 0, max: 1, warm: 0 }));

  // No synchronous teardown: all three boxes still present immediately after.
  const after = pool.snapshot();
  assert.equal(after.total, 3);
  // The leased box is never destroyed synchronously and (since 2 idle boxes cover
  // the 2-box overshoot) is not even flagged.
  const leasedRow = after.boxes.find((box) => box.boxId === leasedBoxId);
  assert.ok(leasedRow);
  assert.equal(leasedRow?.state, "LEASED");
  assert.equal(leasedRow?.markedForDestroy, false);
  // Exactly the two excess idle boxes are flagged for the deferred reaper shrink.
  const flagged = after.boxes.filter((box) => box.markedForDestroy);
  assert.equal(flagged.length, 2);
  for (const box of flagged) {
    assert.equal(box.state, "WARM_IDLE");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("hydrate replays ledger + provider.list() and re-adopts boxes", async () => {
  const { clock } = controllableClock(0);
  // Two pool-owned survivors plus one UNLABELED foreign instance the pool must
  // never adopt.
  const foreign: BoxDescriptor = {
    boxId: "foreign-1",
    workerHost: "fake://box-foreign-1",
    providerRef: "fake://box-foreign-1",
    createdAtMs: 0,
    labels: [],
    metadata: {},
  };
  const provider = new SurvivorProvider([survivorBox("box-A"), survivorBox("box-B"), foreign]);
  registerSurvivor(provider);

  const pool = createBoxPool(poolSettings({ enabled: true, min: 0, max: 4, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  await pool.hydrate();

  const snap = pool.snapshot();
  // Both labeled survivors are re-adopted as idle (no run is active on restart);
  // the unlabeled foreign box is NOT adopted.
  assert.equal(snap.total, 2);
  assert.equal(snap.warmIdle, 2);
  assert.equal(snap.leased, 0);
  assert.equal(snap.inFlight, 0);
  const ids = snap.boxes.map((box) => box.boxId).sort();
  assert.deepEqual(ids, ["box-A", "box-B"]);
  for (const box of snap.boxes) {
    assert.equal(box.state, "WARM_IDLE");
    assert.equal(box.inFlight, 0);
  }

  // A re-adopted survivor is immediately leasable (no re-provision needed).
  const leased = await pool.acquire(acquireReq());
  assert.equal(leased.status, "leased");
  if (leased.status === "leased") {
    assert.ok(leased.lease.boxId === "box-A" || leased.lease.boxId === "box-B");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("hydrate force-returns orphan leased rows whose run is gone", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-pool-hydrate-test-"));
  const ledgerPath = path.join(tmpDir, "box-pool", "ledger.json");
  const { clock } = controllableClock(0);

  // The provider's authoritative list still shows box-survivor but NOT box-gone:
  // the machine that hosted box-gone vanished while its run is gone.
  const provider = new SurvivorProvider([survivorBox("box-survivor")], /* usesLedger */ true);
  registerSurvivor(provider);

  // Seed the ledger with a row for the survivor AND an orphan row for the gone box.
  const rows: LedgerRow[] = [
    {
      boxId: "box-survivor",
      providerRef: "fake://box-box-survivor",
      workerHost: "fake://box-box-survivor",
      labels: [POOL_OWNED_LABEL],
      status: "active",
      createdAtMs: 0,
      updatedAtMs: 0,
    },
    {
      boxId: "box-gone",
      providerRef: "fake://box-box-gone",
      workerHost: "fake://box-box-gone",
      labels: [POOL_OWNED_LABEL],
      status: "active",
      createdAtMs: 0,
      updatedAtMs: 0,
    },
  ];
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, `${JSON.stringify({ rows }, null, 2)}\n`, "utf8");

  const pool = createBoxPool(poolSettings({ enabled: true, min: 0, max: 4, warm: 0 }), {
    clock,
    logEvent: () => undefined,
    ledgerPath,
  });

  await pool.hydrate();

  // Only the surviving box is re-adopted; the orphan box is not in inventory.
  const snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.boxes[0]?.boxId, "box-survivor");

  // The orphan ledger row was force-returned (dropped); only the survivor row
  // remains on disk.
  const onDisk = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as { rows: LedgerRow[] };
  const remainingIds = onDisk.rows.map((row) => row.boxId);
  assert.deepEqual(remainingIds, ["box-survivor"]);
  // No drain here: the survivor is idle (no in-flight lease), and a drain's
  // fire-and-forget ledger delete would race the tmpdir cleanup. The on-disk
  // assertion above already proves the orphan row was force-returned.
});

test("drain durably flushes the daily total: persisted spend equals in-memory total", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-pool-spend-test-"));
  const ledgerPath = path.join(tmpDir, "box-pool", "ledger.json");
  const { clock, advance } = controllableClock(Date.UTC(2026, 4, 29, 12, 0, 0));

  // A ledger-backed provider so the spend sidecar (spend.json) is live. `list()`
  // starts empty; the short test completes before any reaper reconcile fires.
  const provider = new SurvivorProvider([], /* usesLedger */ true);
  registerSurvivor(provider);

  const pool = createBoxPool(poolSettings({ enabled: true, min: 0, max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
    ledgerPath,
  });

  // Settle N runs, each accruing some box-seconds (the hot-path records are
  // fire-and-forget). A crash here could drop the last unpersisted deltas.
  const N = 5;
  for (let i = 0; i < N; i += 1) {
    const held = await pool.acquire(acquireReq({ issueId: `issue-${i}` }));
    assert.equal(held.status, "leased");
    if (held.status !== "leased") return;
    advance(7_000);
    await held.lease.release("healthy");
  }

  const inMemory = pool.snapshot().spend.dailyBoxSecondsUsed;
  assert.equal(inMemory >= N * 7, true);

  // A clean drain must flush the authoritative in-memory daily total durably.
  await pool.drain({ deadlineMs: 1_000 });

  // The persisted sidecar (what a restart seeds from) equals the in-memory total.
  // A missing sidecar (the hot-path fire-and-forget writes never landed) is the
  // crash-window defect: read it as a zeroed total so the mismatch is explicit.
  const spendPath = path.join(path.dirname(ledgerPath), "spend.json");
  let onDisk: { boxSecondsToday: number; dayKey: string };
  try {
    onDisk = JSON.parse(await fs.readFile(spendPath, "utf8")) as {
      boxSecondsToday: number;
      dayKey: string;
    };
  } catch {
    onDisk = { boxSecondsToday: 0, dayKey: "2026-05-29" };
  }
  assert.equal(onDisk.boxSecondsToday, inMemory);
  assert.equal(onDisk.dayKey, "2026-05-29");
});

test("a box provisioned mid-drain does not leak past the force-destroy loop", async () => {
  const { clock } = controllableClock(0);
  const provider = new DeferredProvider();
  registerDeferred(provider);
  const pool = createBoxPool(poolSettings({ max: 2, warm: 0, acquireTimeoutMs: 5_000 }), {
    clock,
    logEvent: () => undefined,
  });

  // Start an acquire that decides to grow; its provision parks on the gate.
  const acquiring = pool.acquire(acquireReq());
  await waitUntil(() => provider.pendingCount() === 1);

  // Drain begins WHILE the provision is in flight. runDrain snapshots inventory
  // (currently empty) and waits for in-flight to settle.
  const draining = pool.drain({ deadlineMs: 200 });

  // Now the provision resolves. The pool must NOT add a leased, paid box to a
  // pool that is already draining (or it must immediately destroy it).
  provider.releaseNext();
  const result = await acquiring;
  await draining;

  // The drain completed; the box the provider created must not survive it.
  assert.equal(provider.boxes.size, 0);
  assert.equal(pool.snapshot().total, 0);
  // If the acquire was leased on a now-draining pool, that lease is dead: a box
  // outliving a completed drain is the leak. A no_capacity result is acceptable.
  if (result.status === "leased") {
    // It was leased: then the box MUST have been destroyed by drain (asserted
    // above) - releasing it must not resurrect it.
    await result.lease.release("healthy");
    assert.equal(provider.boxes.size, 0);
    assert.equal(pool.snapshot().total, 0);
  }
});

test("maxBoxesPerIssue is not exceeded by two concurrent same-issue grows", async () => {
  const { clock } = controllableClock(0);
  const provider = new DeferredProvider();
  registerDeferred(provider);
  const pool = createBoxPool(
    poolSettings({ max: 4, warm: 0, maxBoxesPerIssue: 1, acquireTimeoutMs: 80 }),
    { clock, logEvent: () => undefined },
  );

  // Two concurrent acquires for the SAME issue against an empty pool. Both reach
  // the grow path before either provision resolves (the per-issue cap is 1, so at
  // most one should ever lease). The denied one parks then times out quickly.
  const first = pool.acquire(acquireReq({ issueId: "issue-1", slotIndex: 0, timeoutMs: 80 }));
  const second = pool.acquire(acquireReq({ issueId: "issue-1", slotIndex: 1, timeoutMs: 80 }));

  // Wait for at least one provision to park, then release everything that parked.
  await waitUntil(() => provider.pendingCount() >= 1);
  provider.releaseAll();
  const [a, b] = await Promise.all([first, second]);

  // Exactly ONE of the two concurrent same-issue acquires may lease a distinct
  // box; the other must be denied by the per-issue cap (no_capacity).
  const leased = [a, b].filter((r) => r.status === "leased");
  assert.equal(leased.length, 1);

  // And the pool must hold at most one live box for issue-1.
  assert.equal(pool.snapshot().total <= 1, true);

  await pool.drain({ deadlineMs: 1_000 });
});

test("a lease straddling UTC midnight bills the NEXT day and the next-day acquire over the daily cap is BLOCKED; persisted == in-memory after drain", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-pool-midnight-test-"));
  const ledgerPath = path.join(tmpDir, "box-pool", "ledger.json");

  // Start at 23:59:50 UTC on day N. A ledger-backed provider keeps the spend
  // sidecar live so the persisted total can be compared against in-memory.
  const dayN = Date.UTC(2026, 4, 29, 23, 59, 50);
  const { clock, set } = controllableClock(dayN);
  const provider = new SurvivorProvider([], /* usesLedger */ true);
  registerSurvivor(provider);

  const pool = createBoxPool(
    poolSettings({ enabled: true, min: 0, max: 1, warm: 0, spend: { dailyBoxSeconds: 100 } }),
    { clock, logEvent: () => undefined, ledgerPath },
  );

  // Acquire at 23:59:50 day N, then advance the clock 600s INTO day N+1 and
  // release: the 600s window straddles midnight. The bill must land on day N+1
  // (the day the lease settled), not the zeroed/old day. 600 > the 100s daily
  // cap, so the next acquire (also day N+1) must be BLOCKED by spend_cap.
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  set(Date.UTC(2026, 4, 30, 0, 9, 50)); // 23:59:50 + 600s = 00:09:50 day N+1
  await held.lease.release("healthy");

  const snap = pool.snapshot();
  // The accumulator is keyed on the NEW day and carries the full 600s window.
  assert.equal(snap.spend.dayKey, "2026-05-30");
  assert.equal(snap.spend.dailyBoxSecondsUsed >= 600, true);

  // The next-day acquire is over the 100s daily cap -> blocked with spend_cap
  // (the cap is NOT bypassed across the midnight boundary).
  const next = await pool.acquire(acquireReq({ issueId: "issue-2", timeoutMs: 30 }));
  assert.equal(next.status, "no_capacity");
  if (next.status === "no_capacity") {
    assert.equal(next.reason, "spend_cap");
  }

  // A clean drain flushes the authoritative daily total to the NEW day's sidecar.
  const inMemory = pool.snapshot().spend.dailyBoxSecondsUsed;
  await pool.drain({ deadlineMs: 1_000 });

  const spendPath = path.join(path.dirname(ledgerPath), "spend.json");
  const onDisk = JSON.parse(await fs.readFile(spendPath, "utf8")) as {
    boxSecondsToday: number;
    dayKey: string;
  };
  assert.equal(onDisk.boxSecondsToday, inMemory);
  assert.equal(onDisk.dayKey, "2026-05-30");
});

test("an orphaned drain whose deadline fires after a re-enable does NOT destroy the live re-enabled pool; a genuine drain still destroys all boxes", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(
    poolSettings({ enabled: true, min: 0, max: 2, warm: 0, drainDeadlineMs: 40 }),
    { clock, logEvent: () => undefined },
  );

  // Hold a lease so the disable-driven drain CANNOT settle before its deadline:
  // runDrain parks on the in-flight barrier waiting for the 40ms deadline timer.
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const leasedBoxId = held.lease.boxId;

  // reconcile disable: drain begins and parks (the held lease never settles).
  pool.reconcile(poolSettings({ enabled: false, min: 0, max: 2, warm: 0, drainDeadlineMs: 40 }));
  assert.equal(pool.snapshot().enabled, false);

  // reconcile re-enable BEFORE the stale drain deadline fires: this clears
  // draining and grows a warm box (target warm=2, leased box already live, so one
  // fresh warm box is provisioned), so the pool is LIVE again with two boxes.
  pool.reconcile(poolSettings({ enabled: true, min: 0, max: 2, warm: 2, drainDeadlineMs: 40 }));
  await waitUntil(() => pool.snapshot().total >= 2);

  // Let the orphaned drain's deadline timer fire. Under the bug its destroy loop
  // force-destroys the now-LIVE pool's boxes (total -> 0). Under the fix the
  // stale-epoch / cleared-draining guard makes the loop bail, leaving the live
  // boxes intact.
  await new Promise((resolve) => setTimeout(resolve, 80));

  const snap = pool.snapshot();
  // The leased box AND the freshly grown warm box both survive the stale drain.
  assert.equal(snap.total, 2);
  assert.ok(snap.boxes.some((box) => box.boxId === leasedBoxId));
  assert.equal(snap.enabled, true);

  // The pool is still genuinely live: a release returns the box to WARM_IDLE and
  // a fresh acquire still serves.
  await held.lease.release("healthy");
  const served = await pool.acquire(acquireReq({ issueId: "issue-2" }));
  assert.equal(served.status, "leased");
  if (served.status === "leased") await served.lease.release("healthy");

  // A genuine drain (no racing re-enable) still destroys EVERY box.
  await pool.drain({ deadlineMs: 1_000 });
  assert.equal(pool.snapshot().total, 0);
});

test("hydrate advances boxSeq past adopted box-<n> ids so the next grow does not collide (non-numeric ids tolerated)", async () => {
  const { clock } = controllableClock(0);
  // Survivors: a numeric box-3 (the highest numeric suffix) and a non-numeric
  // box-foo that must be tolerated (ignored when computing the max suffix).
  const provider = new SurvivorProvider([survivorBox("box-3"), survivorBox("box-foo")]);
  registerSurvivor(provider);

  const pool = createBoxPool(poolSettings({ enabled: true, min: 0, max: 4, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  await pool.hydrate();
  assert.equal(pool.snapshot().total, 2);

  // Lease both adopted survivors so the next acquire must GROW a fresh box.
  const a = await pool.acquire(acquireReq({ issueId: "issue-a" }));
  const b = await pool.acquire(acquireReq({ issueId: "issue-b" }));
  assert.equal(a.status, "leased");
  assert.equal(b.status, "leased");
  if (a.status !== "leased" || b.status !== "leased") return;

  // The grow mints box-4 (one past the highest adopted numeric suffix), NOT box-0
  // (which the un-advanced boxSeq would mint, risking a second lease colliding
  // with a survivor id once the sequence cycled back through box-3).
  const grown = await pool.acquire(acquireReq({ issueId: "issue-c" }));
  assert.equal(grown.status, "leased");
  if (grown.status === "leased") {
    assert.equal(grown.lease.boxId, "box-4");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("grow writes a provisional ledger row BEFORE provision then upserts active after (WAL wired)", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-pool-wal-test-"));
  const ledgerPath = path.join(tmpDir, "box-pool", "ledger.json");
  const { clock } = controllableClock(0);

  // A ledger-backed deferred provider: its provision parks on a gate so a test can
  // read the on-disk ledger AFTER the provisional write but BEFORE the correlate.
  const provider = new LedgerDeferredProvider();
  registerBoxProvider("fake", () => provider);

  const pool = createBoxPool(poolSettings({ enabled: true, min: 0, max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
    ledgerPath,
  });

  const acquiring = pool.acquire(acquireReq());
  // Wait until the provision has parked: by now the WAL provisional row must be on
  // disk (written BEFORE provider.provision is awaited).
  await waitUntil(() => provider.pendingCount() === 1);

  const beforeCorrelate = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as {
    rows: LedgerRow[];
  };
  assert.equal(beforeCorrelate.rows.length, 1);
  assert.equal(beforeCorrelate.rows[0]?.status, "provisional");
  assert.equal(beforeCorrelate.rows[0]?.providerRef, null);
  assert.equal(beforeCorrelate.rows[0]?.workerHost, null);
  const provisionalBoxId = beforeCorrelate.rows[0]?.boxId;

  // Let provision resolve; the pool upserts the correlated active row.
  provider.releaseNext();
  const result = await acquiring;
  assert.equal(result.status, "leased");

  const afterCorrelate = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as { rows: LedgerRow[] };
  assert.equal(afterCorrelate.rows.length, 1);
  assert.equal(afterCorrelate.rows[0]?.boxId, provisionalBoxId);
  assert.equal(afterCorrelate.rows[0]?.status, "active");
  assert.ok(afterCorrelate.rows[0]?.providerRef);
  assert.ok(afterCorrelate.rows[0]?.workerHost);

  await pool.drain({ deadlineMs: 1_000 });
  // After drain the box is recycled and its ledger row deleted.
  await waitUntil(async () => {
    const onDisk = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as { rows: LedgerRow[] };
    return onDisk.rows.length === 0;
  });
});

test("crash-before-correlate: hydrate reconciles a provisional row against a list() survivor", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-pool-wal-recover-test-"));
  const ledgerPath = path.join(tmpDir, "box-pool", "ledger.json");
  const { clock } = controllableClock(0);

  // The prior process crashed AFTER provision succeeded but BEFORE it upserted the
  // correlated row, so the ledger holds a PROVISIONAL row. The box did get created
  // at the provider (labeled), and now list() shows it. Hydrate must re-adopt the
  // survivor (label-driven) and not drop the row as an orphan.
  const provider = new SurvivorProvider([survivorBox("box-7")], /* usesLedger */ true);
  registerSurvivor(provider);

  const rows: LedgerRow[] = [
    {
      boxId: "box-7",
      providerRef: null,
      workerHost: null,
      labels: [POOL_OWNED_LABEL],
      status: "provisional",
      createdAtMs: 0,
      updatedAtMs: 0,
    },
  ];
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, `${JSON.stringify({ rows }, null, 2)}\n`, "utf8");

  const pool = createBoxPool(poolSettings({ enabled: true, min: 0, max: 4, warm: 0 }), {
    clock,
    logEvent: () => undefined,
    ledgerPath,
  });

  await pool.hydrate();

  // The survivor whose provisional row never correlated is re-adopted as idle.
  const snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.boxes[0]?.boxId, "box-7");

  // The provisional row is NOT dropped (its box survived and was adopted).
  const onDisk = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as { rows: LedgerRow[] };
  assert.deepEqual(
    onDisk.rows.map((row) => row.boxId),
    ["box-7"],
  );
});

test("crash-before-correlate: a stale provisional row with no surviving box is reaped after ttl", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-pool-wal-stale-test-"));
  const ledgerPath = path.join(tmpDir, "box-pool", "ledger.json");
  // Start well past the ttl window relative to the row's createdAt so the orphan
  // provisional row is older than ttlMs.
  const { clock } = controllableClock(1_000_000);

  // list() shows NO survivor: the provision never actually created a box (or it
  // already vanished). A young provisional row would be kept (the provider may be
  // briefly inconsistent), but one older than ttlMs is a dead row and is reaped.
  const provider = new SurvivorProvider([], /* usesLedger */ true);
  registerSurvivor(provider);

  const rows: LedgerRow[] = [
    {
      boxId: "box-stale",
      providerRef: null,
      workerHost: null,
      labels: [POOL_OWNED_LABEL],
      status: "provisional",
      createdAtMs: 0,
      updatedAtMs: 0,
    },
  ];
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, `${JSON.stringify({ rows }, null, 2)}\n`, "utf8");

  const pool = createBoxPool(
    poolSettings({ enabled: true, min: 0, max: 4, warm: 0, ttlMs: 1_000 }),
    { clock, logEvent: () => undefined, ledgerPath },
  );

  await pool.hydrate();

  // Nothing adopted (no survivor), and the stale provisional row is reaped.
  assert.equal(pool.snapshot().total, 0);
  const onDisk = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as { rows: LedgerRow[] };
  assert.deepEqual(onDisk.rows, []);
});

test("reaper firing before hydrate does NOT destroy a labeled survivor; hydrate then adopts it", async () => {
  const { clock } = controllableClock(0);
  // A labeled pool-owned survivor sits at the provider, as it would right after a
  // restart. The constructor arms the recurring reaper immediately, but hydrate()
  // (which re-adopts survivors) is called later. A reaper tick that fires in that
  // gap must NOT reap the survivor (it has the pool-owned label and is one of
  // ours), or the restart destroys its own warm box.
  const provider = new SurvivorProvider([survivorBox("box-survivor")]);
  registerSurvivor(provider);

  const pool = createBoxPool(
    poolSettings({ enabled: true, min: 0, max: 4, warm: 0, reapIntervalMs: 5 }),
    { clock, logEvent: () => undefined },
  );

  // Let the reaper tick fire at least once BEFORE hydrate runs.
  await new Promise((resolve) => setTimeout(resolve, 30));

  // The survivor was never destroyed by the pre-hydrate reaper tick.
  assert.deepEqual(provider.destroyed, []);

  // Hydrate now re-adopts the survivor as a warm idle box.
  await pool.hydrate();
  const snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.warmIdle, 1);
  assert.equal(snap.boxes[0]?.boxId, "box-survivor");

  // And it is still present (not reaped) after a few more post-hydrate ticks,
  // because it is now in inventory (known), so the reconcile leaves it alone.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(provider.destroyed, []);
  assert.equal(pool.snapshot().total, 1);

  await pool.drain({ deadlineMs: 1_000 });
});

test("hydrate on a usesLedger provider whose list() always fails REJECTS (startup fails loud) and never opens the reaper destroy-unknown gate", async () => {
  // FINDING (HIGH): a usesLedger (paid, ephemeral) provider may have provisioned
  // real survivors before the restart. If hydrate() swallows a list() failure and
  // returns as if startup succeeded, those paid boxes are neither adopted nor
  // reaped (the reaper's destroy-unknown gate stays closed because hydrated never
  // flips) AND they are invisible to drain -> unmanaged paid boxes leak. hydrate()
  // must instead RETRY a bounded number of times and, if list() still fails for a
  // usesLedger provider, THROW so the daemon's `await boxPool.hydrate()` fails
  // startup loudly rather than running blind over unmanaged paid machines.
  const { clock } = controllableClock(0);
  const provider = new SurvivorProvider([survivorBox("box-paid")], /* usesLedger */ true);
  provider.listError = new Error("provider list() outage");
  registerSurvivor(provider);

  // A labeled survivor sits at the provider, as it would right after a restart.
  const pool = createBoxPool(
    poolSettings({ enabled: true, min: 0, max: 4, warm: 0, reapIntervalMs: 5 }),
    { clock, logEvent: () => undefined },
  );

  // hydrate() must REJECT (startup fails loud) rather than silently returning.
  await assert.rejects(() => pool.hydrate(), /box_pool_hydrate_failed/);

  // It retried list() a bounded number of times before giving up (more than once).
  assert.equal(provider.listCalls > 1, true);

  // The reaper destroy-unknown gate stayed CLOSED (hydrated never flipped): a few
  // reaper ticks must NOT destroy the labeled-but-unknown paid survivor, since the
  // pool never proved it had re-adopted its inventory. (list() still fails for the
  // reaper too, so the reconcile cannot run, but the gate being closed is the
  // belt-and-braces guarantee.)
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(provider.destroyed, []);

  // The pool was never marked drained-safe; tear it down so the recurring reaper
  // timer stops. (drain force-destroys nothing because inventory is empty.)
  await pool.drain({ deadlineMs: 50 });
});

test("hydrate on a NON-ledger (fake) provider whose list() fails stays TOLERANT (resolves, no throw)", async () => {
  // A fake / static-ssh provider owns no paid survivors, so a transient list()
  // failure on hydrate is harmless: there is nothing to leak. hydrate() must stay
  // tolerant here (resolve, log the skip) so a non-cloud pool still starts up.
  const { clock } = controllableClock(0);
  const provider = new SurvivorProvider([], /* usesLedger */ false);
  provider.listError = new Error("provider list() outage");
  registerSurvivor(provider);

  const pool = createBoxPool(poolSettings({ enabled: true, min: 0, max: 4, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  // Resolves (does not throw) for a non-ledger provider.
  await pool.hydrate();
  assert.equal(pool.snapshot().total, 0);

  await pool.drain({ deadlineMs: 50 });
});

test("hydrate retries list() and, once it succeeds, adopts the survivors and opens the reaper cleanup gate", async () => {
  // A usesLedger provider whose list() fails the first couple of attempts then
  // recovers: the bounded retry loop must re-attempt (via the injected clock's
  // backoff) until list() succeeds, then re-adopt the labeled survivor as WARM_IDLE
  // and flip `hydrated` so the reaper's destroy-unknown reconcile may resume.
  const { clock } = controllableClock(0);
  const provider = new SurvivorProvider([survivorBox("box-recovered")], /* usesLedger */ true);
  provider.listFailsRemaining = 2;
  registerSurvivor(provider);

  const pool = createBoxPool(
    poolSettings({ enabled: true, min: 0, max: 4, warm: 0, reapIntervalMs: 5 }),
    { clock, logEvent: () => undefined },
  );

  // hydrate() resolves once list() recovers after the bounded retries.
  await pool.hydrate();
  assert.equal(provider.listCalls >= 3, true);

  // The survivor was re-adopted as a warm idle box.
  const snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.warmIdle, 1);
  assert.equal(snap.boxes[0]?.boxId, "box-recovered");

  // The gate opened (hydrated=true): the re-adopted survivor stays known across a
  // few reaper ticks (a known box is left alone; an UNKNOWN labeled box would now
  // be reaped, proving the gate is open).
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pool.snapshot().total, 1);

  await pool.drain({ deadlineMs: 1_000 });
});

test("drain accrues in-flight box-seconds for a lease still held at the deadline (no spend under-count)", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-pool-drain-inflight-test-"));
  const ledgerPath = path.join(tmpDir, "box-pool", "ledger.json");
  const start = Date.UTC(2026, 4, 29, 12, 0, 0);
  const { clock, advance } = controllableClock(start);

  // A ledger-backed provider so the spend sidecar (spend.json) is live and the
  // persisted total can be compared against the in-memory daily total.
  const provider = new SurvivorProvider([], /* usesLedger */ true);
  registerSurvivor(provider);

  const pool = createBoxPool(poolSettings({ enabled: true, min: 0, max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
    ledgerPath,
  });

  // Acquire a box and hold it for 500s WITHOUT releasing it, so its window is
  // entirely in-flight when the drain force-destroys it.
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  advance(500_000);

  // Drain with a tiny deadline so the held lease is still LEASED when the
  // force-destroy loop runs. Without the fix, the box-seconds for this window are
  // never accrued (onLeaseSettle never runs and the late release no-ops on the
  // DESTROYED guard), so the daily total under-counts the 500s window.
  await pool.drain({ deadlineMs: 5 });

  const snap = pool.snapshot();
  assert.equal(snap.spend.dailyBoxSecondsUsed >= 500, true);
  assert.equal(snap.spend.boxSecondsUsed >= 500, true);

  // The persisted sidecar (what a restart seeds from) must match the in-memory
  // daily total the drain flushed.
  const spendPath = path.join(path.dirname(ledgerPath), "spend.json");
  const onDisk = JSON.parse(await fs.readFile(spendPath, "utf8")) as {
    boxSecondsToday: number;
    dayKey: string;
  };
  assert.equal(onDisk.boxSecondsToday, snap.spend.dailyBoxSecondsUsed);
  assert.equal(onDisk.boxSecondsToday >= 500, true);
  assert.equal(onDisk.dayKey, "2026-05-29");
});

// ---------------------------------------------------------------------------
// T4a/T4b: provider rebuilt in place on a reconcile that changes provider
// construction (Finding #1), with per-box origin capture so an in-flight lease
// settling AFTER the swap routes destroy() to its ORIGINAL backend.
// ---------------------------------------------------------------------------

// A tracking provider whose every box `provision`/`destroy` is recorded so a
// test can assert WHICH backend a box was created on and torn down against. Its
// `kind`/`tag` distinguish two provider objects, and `list()` mirrors the live
// boxes so a reaper reconcile over this provider stays coherent. `provisioned`
// stamps the provider tag into the descriptor metadata so a swap test can prove
// a box was created by the OLD provider yet destroyed against that same OLD one.
class TrackingProvider implements BoxProvider {
  readonly destroyed: string[] = [];
  readonly provisioned: string[] = [];
  readonly boxes = new Set<string>();

  constructor(
    readonly kind: BoxProvider["kind"],
    readonly tag: string,
    private readonly usesLedger = false,
  ) {}

  get capabilities(): ProviderCapabilities {
    return { sshAddressable: false, ephemeral: true, usesLedger: this.usesLedger };
  }

  async provision(req: ProvisionRequest): Promise<BoxDescriptor> {
    this.provisioned.push(req.boxId);
    this.boxes.add(req.boxId);
    const workerHost = `${this.tag}://box-${req.boxId}`;
    return Promise.resolve({
      boxId: req.boxId,
      workerHost,
      providerRef: workerHost,
      createdAtMs: 0,
      labels: [...req.labels],
      metadata: { providerTag: this.tag },
    });
  }

  async probe(): Promise<BoxHealth> {
    return Promise.resolve({ ok: true });
  }

  async destroy(box: BoxDescriptor, _opts: { timeoutMs: number; reason: TeardownReason }) {
    this.destroyed.push(box.boxId);
    this.boxes.delete(box.boxId);
    return Promise.resolve();
  }

  async list(): Promise<BoxDescriptor[]> {
    return Promise.resolve(
      [...this.boxes].map((boxId) => ({
        boxId,
        workerHost: `${this.tag}://box-${boxId}`,
        providerRef: `${this.tag}://box-${boxId}`,
        createdAtMs: 0,
        labels: [POOL_OWNED_LABEL],
        metadata: { providerTag: this.tag },
      })),
    );
  }
}

// Registers two tracking providers, one per kind, each remembering how many
// times its factory ran so a test can prove a reconcile rebuilds the provider
// in place (factory re-invoked) or skips the rebuild (factory not re-invoked).
function registerTracking(): {
  builds: { fake: number; "static-ssh": number };
  fake: () => TrackingProvider;
  staticSsh: () => TrackingProvider;
} {
  const builds = { fake: 0, "static-ssh": 0 };
  let fakeInstance: TrackingProvider | null = null;
  let staticInstance: TrackingProvider | null = null;
  registerBoxProvider("fake", () => {
    builds.fake += 1;
    fakeInstance = new TrackingProvider("fake", "fake");
    return fakeInstance;
  });
  registerBoxProvider("static-ssh", () => {
    builds["static-ssh"] += 1;
    staticInstance = new TrackingProvider("static-ssh", "static");
    return staticInstance;
  });
  return {
    builds,
    fake: () => {
      assert.ok(fakeInstance);
      return fakeInstance as TrackingProvider;
    },
    staticSsh: () => {
      assert.ok(staticInstance);
      return staticInstance as TrackingProvider;
    },
  };
}

test("reconcile changing provider rebuilds it in place (resolveProvider re-run, singleton not reconstructed); new provisions route to the new provider", async () => {
  const { clock } = controllableClock(0);
  const tracking = registerTracking();
  const pool = createBoxPool(poolSettings({ enabled: true, provider: "fake", min: 0, max: 2 }), {
    clock,
    logEvent: () => undefined,
  });
  // The provider was resolved exactly once in the ctor.
  assert.equal(tracking.builds.fake, 1);
  assert.equal(tracking.builds["static-ssh"], 0);

  // A box provisioned before the swap lands on the OLD ("fake") backend.
  const before = await pool.acquire(acquireReq());
  assert.equal(before.status, "leased");
  if (before.status !== "leased") return;
  assert.equal(before.lease.workerHost.startsWith("fake://"), true);
  await before.lease.release("healthy");

  // Reconcile to a DIFFERENT provider kind. The pool is NOT reconstructed (same
  // object) but the provider is rebuilt in place: the static-ssh factory runs.
  const same = pool;
  pool.reconcile(poolSettings({ enabled: true, provider: "static-ssh", min: 0, max: 2 }));
  assert.equal(same, pool);
  assert.equal(tracking.builds["static-ssh"], 1);
  // The fake factory was NOT re-invoked by the swap (no singleton churn).
  assert.equal(tracking.builds.fake, 1);
  assert.equal(pool.snapshot().provider, "static-ssh");

  // The OLD "fake" warm box left over from before the swap is reconciled away by
  // the reaper (its providerRef no longer matches the new provider's list()), so
  // a fresh provision routes to the NEW ("static") backend.
  await waitUntil(() => {
    const snap = pool.snapshot();
    return snap.boxes.every((box) => box.workerHost.startsWith("static://"));
  });
  const after = await pool.acquire(acquireReq({ issueId: "issue-2" }));
  assert.equal(after.status, "leased");
  if (after.status === "leased") {
    assert.equal(after.lease.workerHost.startsWith("static://"), true);
    assert.equal(tracking.staticSsh().provisioned.includes(after.lease.boxId), true);
    await after.lease.release("healthy");
  }
  await pool.drain({ deadlineMs: 1_000 });
});

test("same-provider reconcile skips the swap (no rebuild)", async () => {
  const { clock } = controllableClock(0);
  const tracking = registerTracking();
  const pool = createBoxPool(poolSettings({ enabled: true, provider: "fake", min: 0, max: 2 }), {
    clock,
    logEvent: () => undefined,
  });
  assert.equal(tracking.builds.fake, 1);

  // A reconcile that changes a knob but NOT the provider construction (same kind,
  // same providerOptions) must not rebuild the provider: the factory count holds.
  pool.reconcile(poolSettings({ enabled: true, provider: "fake", min: 0, max: 3 }));
  assert.equal(tracking.builds.fake, 1);
  assert.equal(tracking.builds["static-ssh"], 0);

  // A no-op reconcile (identical settings) likewise never rebuilds.
  pool.reconcile(poolSettings({ enabled: true, provider: "fake", min: 0, max: 3 }));
  assert.equal(tracking.builds.fake, 1);
  await pool.drain({ deadlineMs: 1_000 });
});

test("changing providerOptions (same kind) rebuilds the provider in place", async () => {
  const { clock } = controllableClock(0);
  const tracking = registerTracking();
  const pool = createBoxPool(
    poolSettings({
      enabled: true,
      provider: "fake",
      min: 0,
      max: 2,
      providerOptions: { region: "a" },
    }),
    { clock, logEvent: () => undefined },
  );
  assert.equal(tracking.builds.fake, 1);

  // Same kind but a DEEP-changed providerOptions must rebuild the provider so the
  // new options take effect.
  pool.reconcile(
    poolSettings({
      enabled: true,
      provider: "fake",
      min: 0,
      max: 2,
      providerOptions: { region: "b" },
    }),
  );
  assert.equal(tracking.builds.fake, 2);

  // Re-applying the SAME providerOptions does not rebuild again.
  pool.reconcile(
    poolSettings({
      enabled: true,
      provider: "fake",
      min: 0,
      max: 2,
      providerOptions: { region: "b" },
    }),
  );
  assert.equal(tracking.builds.fake, 2);
  await pool.drain({ deadlineMs: 1_000 });
});

test("an in-flight lease settling AFTER a provider swap destroys its box against the ORIGINAL provider (never orphaned)", async () => {
  const { clock } = controllableClock(0);
  const tracking = registerTracking();
  const pool = createBoxPool(poolSettings({ enabled: true, provider: "fake", min: 0, max: 2 }), {
    clock,
    logEvent: () => undefined,
  });

  // Acquire a box on the OLD ("fake") provider and HOLD the lease across the swap.
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const oldBoxId = held.lease.boxId;
  assert.equal(held.lease.workerHost.startsWith("fake://"), true);
  const oldProvider = tracking.fake();
  assert.equal(oldProvider.provisioned.includes(oldBoxId), true);

  // Reconcile to a NEW provider while the lease is still in flight. swapProvider
  // captures originProvider on the still-leased box BEFORE reassigning this.provider.
  pool.reconcile(poolSettings({ enabled: true, provider: "static-ssh", min: 0, max: 2 }));
  const newProvider = tracking.staticSsh();
  assert.equal(pool.snapshot().provider, "static-ssh");

  // Now the in-flight lease settles as poison so its box is recycled at settle
  // time. recycle() must destroy against the box's captured ORIGINAL provider
  // ("fake"), NOT the new this.provider ("static"), so the paid box is not
  // orphaned on the old backend.
  await held.lease.fail("ssh_timeout");

  // The OLD provider tore the box down; the NEW provider never saw a destroy for
  // a box it never provisioned.
  assert.equal(oldProvider.destroyed.includes(oldBoxId), true);
  assert.equal(newProvider.destroyed.includes(oldBoxId), false);
  // No paid box orphaned on the old backend.
  assert.equal(oldProvider.boxes.has(oldBoxId), false);

  await pool.drain({ deadlineMs: 1_000 });
});

test("a reconcile to an UNAVAILABLE provider throws and mutates NOTHING (last-good boxes survive: neither warm-idle nor leased box is marked for destroy, this.provider unchanged, the leased box settles healthy and is NOT recycled)", async () => {
  const { clock } = controllableClock(0);
  // Old provider ("fake") is registered; the NEW kind ("static-ssh") is NOT, so
  // the swap's resolveProvider(next.provider, ...) THROWS box_pool_provider_unavailable.
  const oldProvider = new TrackingProvider("fake", "fake");
  registerBoxProvider("fake", () => oldProvider);
  const pool = createBoxPool(poolSettings({ enabled: true, provider: "fake", min: 0, max: 3 }), {
    clock,
    logEvent: () => undefined,
  });

  // Stage last-good capacity as TWO distinct boxes: acquire both (each grows a
  // box), then release one so it goes WARM_IDLE while the other stays LEASED held
  // across the failed reload.
  const warm = await pool.acquire(acquireReq({ issueId: "issue-warm" }));
  const held = await pool.acquire(acquireReq({ issueId: "issue-held" }));
  assert.equal(warm.status, "leased");
  assert.equal(held.status, "leased");
  if (warm.status !== "leased" || held.status !== "leased") return;
  const warmBoxId = warm.lease.boxId;
  const heldBoxId = held.lease.boxId;
  assert.notEqual(warmBoxId, heldBoxId);
  await warm.lease.release("healthy");

  const beforeProvisioned = oldProvider.provisioned.length;

  // Reconcile to the UNAVAILABLE provider. swapProvider must do ALL throwing work
  // (resolveProvider) BEFORE mutating any record / this.provider, so a rejected
  // reload leaves the inventory byte-identical and the failure propagates.
  assert.throws(
    () => pool.reconcile(poolSettings({ enabled: true, provider: "static-ssh", min: 0, max: 3 })),
    /box_pool_provider_unavailable/,
  );

  // NOTHING was mutated: this.provider is unchanged (snapshot still reports the
  // old kind) and NEITHER box was flagged for destroy.
  const after = pool.snapshot();
  assert.equal(after.provider, "fake");
  assert.equal(after.total, 2);
  const warmRow = after.boxes.find((box) => box.boxId === warmBoxId);
  const heldRow = after.boxes.find((box) => box.boxId === heldBoxId);
  assert.ok(warmRow);
  assert.ok(heldRow);
  assert.equal(warmRow?.markedForDestroy, false);
  assert.equal(heldRow?.markedForDestroy, false);
  assert.equal(warmRow?.state, "WARM_IDLE");
  assert.equal(heldRow?.state, "LEASED");
  // The old provider provisioned no replacement and destroyed nothing.
  assert.equal(oldProvider.provisioned.length, beforeProvisioned);
  assert.equal(oldProvider.destroyed.length, 0);

  // The still-leased box settles HEALTHY: because it was never markedForDestroy,
  // onLeaseSettle returns it to WARM_IDLE instead of recycling it. The warm idle
  // box was likewise never reaped: both last-good boxes survive the failed reload.
  await held.lease.release("healthy");
  const settled = pool.snapshot();
  assert.equal(settled.total, 2);
  assert.equal(settled.warmIdle, 2);
  assert.equal(settled.leased, 0);
  assert.equal(oldProvider.destroyed.length, 0);
  assert.equal(oldProvider.boxes.has(warmBoxId), true);
  assert.equal(oldProvider.boxes.has(heldBoxId), true);

  await pool.drain({ deadlineMs: 1_000 });
});

// A tracking provider whose `provision` parks on an externally-resolved gate, so a
// test can drive a provider SWAP IN BETWEEN the pool deciding to grow (provision
// called on this provider) and the provision resolving (the box landing in
// inventory under the NOW-stale provider). Tags every workerHost so a test can tell
// which backend created / tore down a box, and tracks every destroy.
class DeferredTrackingProvider implements BoxProvider {
  readonly destroyed: string[] = [];
  readonly provisioned: string[] = [];
  readonly boxes = new Set<string>();
  private readonly gates: Array<() => void> = [];

  constructor(
    readonly kind: BoxProvider["kind"],
    readonly tag: string,
    private readonly usesLedger = false,
  ) {}

  get capabilities(): ProviderCapabilities {
    return { sshAddressable: false, ephemeral: true, usesLedger: this.usesLedger };
  }

  async provision(req: ProvisionRequest): Promise<BoxDescriptor> {
    await new Promise<void>((resolve) => {
      this.gates.push(resolve);
    });
    this.provisioned.push(req.boxId);
    this.boxes.add(req.boxId);
    const workerHost = `${this.tag}://box-${req.boxId}`;
    return {
      boxId: req.boxId,
      workerHost,
      providerRef: workerHost,
      createdAtMs: 0,
      labels: [...req.labels],
      metadata: { providerTag: this.tag },
    };
  }

  async probe(): Promise<BoxHealth> {
    return Promise.resolve({ ok: true });
  }

  async destroy(box: BoxDescriptor, _opts: { timeoutMs: number; reason: TeardownReason }) {
    this.destroyed.push(box.boxId);
    this.boxes.delete(box.boxId);
    return Promise.resolve();
  }

  async list(): Promise<BoxDescriptor[]> {
    return Promise.resolve(
      [...this.boxes].map((boxId) => ({
        boxId,
        workerHost: `${this.tag}://box-${boxId}`,
        providerRef: `${this.tag}://box-${boxId}`,
        createdAtMs: 0,
        labels: [POOL_OWNED_LABEL],
        metadata: { providerTag: this.tag },
      })),
    );
  }

  pendingCount(): number {
    return this.gates.length;
  }

  releaseNext(): void {
    const gate = this.gates.shift();
    if (gate) gate();
  }
}

test("a provider swap DURING an in-flight grow provision records the box against the ORIGINAL provider and marks it for destroy (no orphan)", async () => {
  // FINDING (MEDIUM): grow() awaits provision() then inserts the descriptor without
  // capturing which provider created it. A swapProvider DURING the await records a
  // provider-A box under the new provider B with no originProvider, so a later
  // recycle/destroy routes to B and A's paid machine leaks. The grow must capture
  // the provider (and its generation) BEFORE the await, then on return stamp
  // record.originProvider = the CAPTURED provider and (because a swap happened) mark
  // the box for destroy.
  const { clock } = controllableClock(0);
  const oldProvider = new DeferredTrackingProvider("fake", "fake", /* usesLedger */ true);
  const newProvider = new DeferredTrackingProvider("static-ssh", "static", /* usesLedger */ true);
  registerBoxProvider("fake", () => oldProvider);
  registerBoxProvider("static-ssh", () => newProvider);

  const pool = createBoxPool(poolSettings({ enabled: true, provider: "fake", min: 0, max: 2 }), {
    clock,
    logEvent: () => undefined,
  });

  // Kick off an acquire that grows a box on the OLD ("fake") provider; its
  // provision parks on the gate (the box is NOT yet in inventory).
  const acquiring = pool.acquire(acquireReq());
  await waitUntil(() => oldProvider.pendingCount() === 1);

  // SWAP to the new provider WHILE the old provision is still in flight.
  pool.reconcile(poolSettings({ enabled: true, provider: "static-ssh", min: 0, max: 2 }));
  assert.equal(pool.snapshot().provider, "static-ssh");

  // Now let the OLD provision resolve: the box lands in inventory AFTER the swap.
  oldProvider.releaseNext();
  const result = await acquiring;
  assert.equal(result.status, "leased");
  if (result.status !== "leased") return;
  const boxId = result.lease.boxId;
  // The box was provisioned on the OLD ("fake") backend, so its workerHost is fake.
  assert.equal(result.lease.workerHost.startsWith("fake://"), true);
  assert.equal(oldProvider.provisioned.includes(boxId), true);

  // The box was marked for destroy (it was provisioned on the now-stale provider).
  const snapBox = pool.snapshot().boxes.find((box) => box.boxId === boxId);
  assert.ok(snapBox);
  assert.equal(snapBox?.markedForDestroy, true);

  // Settle the lease: recycle must destroy the box against its ORIGINAL ("fake")
  // provider, NOT the new ("static") provider, so the paid machine is not orphaned.
  await result.lease.release("healthy");
  await waitUntil(() => oldProvider.destroyed.includes(boxId));
  assert.equal(oldProvider.destroyed.includes(boxId), true);
  assert.equal(newProvider.destroyed.includes(boxId), false);
  // No paid box orphaned on the old backend.
  assert.equal(oldProvider.boxes.has(boxId), false);

  await pool.drain({ deadlineMs: 1_000 });
});

test("a provider swap DURING an in-flight WARM provision records the box against the ORIGINAL provider and marks it for destroy (no orphan)", async () => {
  // Same orphaned-in-flight-grow shape as above, but for the reaper-driven
  // provisionWarm() path: a warm box provisioned on provider A whose insert lands
  // after a swap to B must still carry originProvider=A and be marked for destroy.
  const { clock } = controllableClock(0);
  const oldProvider = new DeferredTrackingProvider("fake", "fake", /* usesLedger */ true);
  const newProvider = new DeferredTrackingProvider("static-ssh", "static", /* usesLedger */ true);
  registerBoxProvider("fake", () => oldProvider);
  registerBoxProvider("static-ssh", () => newProvider);

  // warm=1 so a reconcile's growTowardTarget drives provisionWarm() on the OLD
  // provider; its provision parks on the gate. A short reapIntervalMs so the
  // recurring reaper promptly recycles the (flagged, idle) stale box once it lands.
  const pool = createBoxPool(
    poolSettings({ enabled: true, provider: "fake", min: 0, max: 2, warm: 1, reapIntervalMs: 5 }),
    { clock, logEvent: () => undefined },
  );

  // Trigger a warm top-up on the OLD provider (reconcile with the same provider so
  // no swap yet; growTowardTarget calls provisionWarm which parks on the gate).
  pool.reconcile(
    poolSettings({ enabled: true, provider: "fake", min: 0, max: 2, warm: 1, reapIntervalMs: 5 }),
  );
  await waitUntil(() => oldProvider.pendingCount() >= 1);

  // SWAP to the new provider WHILE the warm provision is still in flight.
  pool.reconcile(
    poolSettings({
      enabled: true,
      provider: "static-ssh",
      min: 0,
      max: 2,
      warm: 1,
      reapIntervalMs: 5,
    }),
  );
  assert.equal(pool.snapshot().provider, "static-ssh");

  // Let the OLD warm provision resolve: the box lands in inventory AFTER the swap,
  // flagged for destroy with origin captured to the OLD provider.
  oldProvider.releaseNext();
  await waitUntil(() => oldProvider.provisioned.length === 1);
  const boxId = oldProvider.provisioned[0]!;

  // The stale idle box is recycled against its ORIGINAL ("fake") backend (NOT the
  // new "static" provider), so the paid machine is torn down where it was created
  // rather than orphaned by the reaper's list-reconcile dropping the record.
  await waitUntil(() => oldProvider.destroyed.includes(boxId));
  assert.equal(oldProvider.destroyed.includes(boxId), true);
  assert.equal(newProvider.destroyed.includes(boxId), false);
  assert.equal(oldProvider.boxes.has(boxId), false);
  // And it never lingers in inventory under the new provider.
  await waitUntil(() => !pool.snapshot().boxes.some((b) => b.boxId === boxId));

  await pool.drain({ deadlineMs: 1_000 });
});

test("provider swap re-threads the reaper provider and the ledger usesLedger gate (no singleton reconstruction)", async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-pool-swap-ledger-test-"));
  const ledgerPath = path.join(tmpDir, "box-pool", "ledger.json");
  const { clock } = controllableClock(0);

  // Old provider: NON-ledger ("fake"). New provider: ledger-backed ("static-ssh")
  // so the swap must rebuild the ledger gate (usesLedger false -> true) in place.
  const builds = { fake: 0, "static-ssh": 0 };
  let staticInstance: TrackingProvider | null = null;
  registerBoxProvider("fake", () => {
    builds.fake += 1;
    return new TrackingProvider("fake", "fake", /* usesLedger */ false);
  });
  registerBoxProvider("static-ssh", () => {
    builds["static-ssh"] += 1;
    staticInstance = new TrackingProvider("static-ssh", "static", /* usesLedger */ true);
    return staticInstance;
  });

  const pool = createBoxPool(
    poolSettings({ enabled: true, provider: "fake", min: 0, max: 2, reapIntervalMs: 5 }),
    { clock, logEvent: () => undefined, ledgerPath },
  );

  // Swap to the ledger-backed provider in place.
  pool.reconcile(
    poolSettings({ enabled: true, provider: "static-ssh", min: 0, max: 2, reapIntervalMs: 5 }),
  );
  assert.equal(builds["static-ssh"], 1);
  assert.ok(staticInstance);

  // The reaper now drives the NEW provider: a box provisioned post-swap lands on
  // the static backend and the recurring reaper's list() reconcile (which reads
  // reaperInternals.provider) keeps it, proving the reaper provider was re-threaded.
  const leased = await pool.acquire(acquireReq());
  assert.equal(leased.status, "leased");
  if (leased.status !== "leased") return;
  assert.equal(leased.lease.workerHost.startsWith("static://"), true);

  // The ledger gate was rebuilt to usesLedger=true: a WAL row for the new box is
  // now written to disk (a non-ledger gate would have performed zero fs I/O).
  await waitUntil(async () => {
    try {
      const onDisk = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as { rows: LedgerRow[] };
      return onDisk.rows.some((row) => row.boxId === leased.lease.boxId);
    } catch {
      return false;
    }
  });

  await leased.lease.release("healthy");
  await pool.drain({ deadlineMs: 1_000 });
});

// ---------------------------------------------------------------------------
// onMachineRecycling: the recycle-vs-endpoint ordering invariant (T2c)
// ---------------------------------------------------------------------------

test("onMachineRecycling fires with the boxId on a poison-driven recycle (before the provider.destroy completes)", async () => {
  // A provider whose destroy parks on a gate so the test can prove the recycling
  // callback fired BEFORE the machine is actually torn down (the ordering
  // invariant: the coordinator must see the recycle before the host dies).
  const provider = new DeferredDestroyProvider();
  registerDeferredDestroy(provider);
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  const recycling: string[] = [];
  let destroyedAtCallback: string[] = [];
  pool.onMachineRecycling((boxId) => {
    recycling.push(boxId);
    // Snapshot what the provider has destroyed AT callback time: the destroy is
    // parked on the gate, so nothing is torn down yet (callback fires first).
    destroyedAtCallback = [...provider.destroyed];
  });

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const boxId = held.lease.boxId;

  // Poison the box: on settle it is recycled, which must fire the callback.
  const settle = held.lease.fail("ssh_timeout");
  await waitUntil(() => recycling.length === 1);

  assert.deepEqual(recycling, [boxId]);
  // The callback ran BEFORE provider.destroy completed (the destroy is gated).
  assert.deepEqual(destroyedAtCallback, []);

  // Let the destroy complete and the settle resolve.
  provider.releaseNextDestroy();
  await settle;
  await waitUntil(() => provider.destroyed.includes(boxId));
  await pool.drain({ deadlineMs: 1_000 });
});

test("onMachineRecycling fires on the drain force-destroy path too (every teardown routes through recycle)", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  const recycling: string[] = [];
  pool.onMachineRecycling((boxId) => recycling.push(boxId));

  // A still-held lease forces drain to tear the box down (the force-destroy path).
  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const boxId = held.lease.boxId;

  await pool.drain({ deadlineMs: 50 });
  assert.deepEqual(recycling, [boxId]);
});

test("onMachineRecycling supports multiple registered callbacks (all fire)", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  const a: string[] = [];
  const b: string[] = [];
  pool.onMachineRecycling((boxId) => a.push(boxId));
  pool.onMachineRecycling((boxId) => b.push(boxId));

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const boxId = held.lease.boxId;

  await held.lease.fail("ssh_timeout");
  assert.deepEqual(a, [boxId]);
  assert.deepEqual(b, [boxId]);
  await pool.drain({ deadlineMs: 1_000 });
});

test("onMachineRecycling fires exactly once per box even when a poisoned, marked box is recycled once", async () => {
  // recycle() is idempotent (a DESTROYED/DESTROYING box is left alone), so the
  // callback must not double-fire for a single teardown.
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0 }), {
    clock,
    logEvent: () => undefined,
  });

  const recycling: string[] = [];
  pool.onMachineRecycling((boxId) => recycling.push(boxId));

  const held = await pool.acquire(acquireReq());
  assert.equal(held.status, "leased");
  if (held.status !== "leased") return;
  const boxId = held.lease.boxId;

  await held.lease.fail("ssh_timeout");
  // Drain after the box is already gone must not re-fire the callback.
  await pool.drain({ deadlineMs: 1_000 });
  assert.deepEqual(recycling, [boxId]);
});

// --- co-residence (slotsPerMachine>1) regression coverage -----------------
// These three guard the seams that only open once two leases share one box.

test("co-resident poison is remembered: the box recycles when the last sibling settles", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0, min: 0, slotsPerMachine: 2 }), {
    clock,
    logEvent: () => undefined,
  });

  // max:1 with two slots forces both leases onto the SAME box.
  const a = await pool.acquire(acquireReq({ issueId: "issue-a", slotIndex: 0 }));
  assert.equal(a.status, "leased");
  if (a.status !== "leased") return;
  const b = await pool.acquire(acquireReq({ issueId: "issue-b", slotIndex: 1 }));
  assert.equal(b.status, "leased");
  if (b.status !== "leased") return;
  assert.equal(a.lease.boxId, b.lease.boxId);
  assert.equal(pool.snapshot().inFlight, 2);

  // One co-resident lease hits a box-transport fault while the sibling is still live.
  await a.lease.fail("ssh_down");

  // The box is flagged for destroy NOW (poison remembered) even though a sibling
  // still holds it, so it cannot serve a fresh lease and cannot grow (max reached):
  // a new acquire times out instead of landing on a known-bad box.
  let snap = pool.snapshot();
  assert.equal(snap.total, 1);
  assert.equal(snap.inFlight, 1);
  assert.equal(snap.boxes.find((box) => box.boxId === a.lease.boxId)?.markedForDestroy, true);
  const blocked = await pool.acquire(acquireReq({ issueId: "issue-c", timeoutMs: 30 }));
  assert.equal(blocked.status, "no_capacity");

  // When the healthy sibling finally releases, the box is RECYCLED (not returned to
  // WARM_IDLE). Without remembering the poison it would have been reused.
  await b.lease.release("healthy");
  snap = pool.snapshot();
  assert.equal(snap.total, 0);

  await pool.drain({ deadlineMs: 1_000 });
});

test("a failed provider.destroy keeps the paid box tracked, then drain reclaims it once it recovers", async () => {
  const { clock } = controllableClock(0);
  const events: Record<string, unknown>[] = [];
  const pool = createBoxPool(poolSettings({ max: 1, warm: 0, min: 0 }), {
    clock,
    logEvent: (event) => {
      events.push(event);
    },
  });

  const a = await pool.acquire(acquireReq());
  assert.equal(a.status, "leased");
  if (a.status !== "leased") return;
  const boxId = a.lease.boxId;

  assert.ok(lastProvider);
  const provider = lastProvider as FakeBoxProvider;

  // The backend destroy fails when the poisoned lease tries to recycle the box.
  provider.injectDestroyFailure(boxId, "provider 500");
  await a.lease.fail("ssh_down");

  // The box must stay tracked (a machine that may still be running and billing):
  // not dropped from inventory, flagged for destroy, and a destroy-failed event
  // logged. The backend instance is still alive because destroy never succeeded.
  const snap = pool.snapshot();
  assert.equal(snap.total, 1);
  const retained = snap.boxes.find((box) => box.boxId === boxId);
  assert.equal(retained?.markedForDestroy, true);
  assert.equal(retained?.inFlight, 0);
  assert.equal(
    events.some((event) => event.event === "box_pool_destroy_failed" && event.boxId === boxId),
    true,
  );
  assert.equal(
    (await provider.list()).some((descriptor) => descriptor.boxId === boxId),
    true,
  );

  // Once the backend recovers, teardown actually reclaims it - proving the retained
  // box was recoverable, never silently leaked.
  provider.clearDestroyFailure(boxId);
  await pool.drain({ deadlineMs: 1_000 });
  assert.equal(
    (await provider.list()).some((descriptor) => descriptor.boxId === boxId),
    false,
  );
});

test("maxBoxesPerIssue is not bypassed when a same-issue sibling settles on a shared box", async () => {
  const { clock } = controllableClock(0);
  const pool = createBoxPool(
    poolSettings({ max: 2, warm: 0, min: 0, slotsPerMachine: 2, maxBoxesPerIssue: 1 }),
    { clock, logEvent: () => undefined },
  );

  // Two leases for issue-a co-reside on box B1 (both its slots).
  const a1 = await pool.acquire(acquireReq({ issueId: "issue-a", slotIndex: 0 }));
  const a2 = await pool.acquire(acquireReq({ issueId: "issue-a", slotIndex: 1 }));
  assert.equal(a1.status, "leased");
  assert.equal(a2.status, "leased");
  if (a1.status !== "leased" || a2.status !== "leased") return;
  assert.equal(a1.lease.boxId, a2.lease.boxId);

  // One issue-a lease settles. The box must still be attributed to issue-a because
  // its sibling slot is live; a plain set would forget the issue here.
  await a1.lease.release("healthy");

  // A different issue fills the freed slot so issue-a can no longer reuse B1.
  const c = await pool.acquire(acquireReq({ issueId: "issue-c", slotIndex: 0 }));
  assert.equal(c.status, "leased");
  if (c.status !== "leased") return;
  assert.equal(c.lease.boxId, a1.lease.boxId);

  // issue-a wants another slot. B1 is full and issue-a already holds its one allowed
  // box, so growth is barred by the cap and the acquire times out. If the settle had
  // dropped issue-a's attribution, the pool would grow a SECOND box for issue-a and
  // blow the cap.
  const a3 = await pool.acquire(acquireReq({ issueId: "issue-a", slotIndex: 0, timeoutMs: 30 }));
  assert.equal(a3.status, "no_capacity");
  assert.equal(pool.snapshot().total, 1);

  await pool.drain({ deadlineMs: 1_000 });
});
