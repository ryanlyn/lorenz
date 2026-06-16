import { assert } from "@lorenz/test-utils";
import { test } from "vitest";

import { withDerivedMaxInFlight } from "@lorenz/domain";
import type {
  WorkerDriverKind,
  WorkerPoolSettings,
  RunningEntry,
  WorkerSettings,
} from "@lorenz/domain";

// A full WorkerPoolSettings literal: every required field plus the optional spend/driverOptions/cap.
// `slotsPerMachine` is the single own field; `maxInFlight` is installed as a derived getter.
const workerPoolFixture: WorkerPoolSettings = withDerivedMaxInFlight({
  enabled: true,
  driver: "static-ssh",
  min: 0,
  max: 4,
  warm: 1,
  slotsPerMachine: 1,
  ttlMs: 3_600_000,
  idleReapMs: 300_000,
  acquireTimeoutMs: 30_000,
  reapIntervalMs: 15_000,
  staleHeartbeatMs: 600_000,
  drainDeadlineMs: 30_000,
  maxWorkersPerIssue: 2,
  spend: {
    maxConcurrentWorkers: 4,
    maxWorkerSeconds: 7_200,
    dailyWorkerSeconds: 86_400,
  },
  driverOptions: {
    ssh_hosts: ["user@host-a:22", "user@host-b:22"],
  },
});

// A minimal WorkerPoolSettings literal: only the required fields, optionals omitted.
const minimalWorkerPoolFixture: WorkerPoolSettings = withDerivedMaxInFlight({
  enabled: false,
  driver: "fake",
  min: 0,
  max: 1,
  warm: 1,
  slotsPerMachine: 1,
  ttlMs: 3_600_000,
  idleReapMs: 300_000,
  acquireTimeoutMs: 30_000,
  reapIntervalMs: 15_000,
  staleHeartbeatMs: 600_000,
  drainDeadlineMs: 30_000,
});

// The co-residence opt-in and tunnel ceiling are additive optionals (STEP 3); a
// literal that sets them stays valid and `withDerivedMaxInFlight` carries them through.
const coResidentWorkerPoolFixture: WorkerPoolSettings = withDerivedMaxInFlight({
  enabled: true,
  driver: "fake",
  min: 0,
  max: 4,
  warm: 0,
  slotsPerMachine: 2,
  ttlMs: 3_600_000,
  idleReapMs: 300_000,
  acquireTimeoutMs: 30_000,
  reapIntervalMs: 15_000,
  staleHeartbeatMs: 600_000,
  drainDeadlineMs: 30_000,
  coResidence: true,
  maxConcurrentTunnels: 8,
});

// WorkerSettings.workerPool is additive and optional - existing configs omit it entirely.
const workerWithoutPool: WorkerSettings = {
  sshHosts: [],
  sshTimeoutMs: 60_000,
};
const workerWithPool: WorkerSettings = {
  sshHosts: [],
  sshTimeoutMs: 60_000,
  workerPool: minimalWorkerPoolFixture,
};

const runningEntryFixture: RunningEntry = {
  issue: {
    id: "issue-1",
    identifier: "MT-1",
    title: "Fixture",
    state: "Todo",
    stateType: "unstarted",
    labels: [],
    blockers: [],
  },
  identifier: "MT-1",
  slotIndex: 0,
  ensembleSize: 1,
  agentKind: "codex",
  turnCount: 0,
  startedAt: new Date(0),
  usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
  lastReportedInputTokens: 0,
  lastReportedOutputTokens: 0,
  lastReportedTotalTokens: 0,
  retryAttempt: null,
};

// The driver selector is an open string: which kinds are supported is decided by
// the worker-driver registry at the composition root, not by the domain type.
const customDriverKind: WorkerDriverKind = "acme-cloud";

test("WorkerDriverKind is open: any registry-resolvable string compiles", () => {
  assert.equal(customDriverKind, "acme-cloud");
});

test("WorkerPoolSettings shape compiles with and without optionals", () => {
  assert.equal(workerPoolFixture.driver, "static-ssh");
  assert.equal(workerPoolFixture.slotsPerMachine, 1);
  assert.equal(workerPoolFixture.spend?.dailyWorkerSeconds, 86_400);
  assert.deepEqual(workerPoolFixture.driverOptions?.ssh_hosts, [
    "user@host-a:22",
    "user@host-b:22",
  ]);
  assert.equal(minimalWorkerPoolFixture.spend, undefined);
  assert.equal(minimalWorkerPoolFixture.maxWorkersPerIssue, undefined);
});

test("WorkerPoolSettings.coResidence and maxConcurrentTunnels are optional and additive", () => {
  // Absent on the minimal/default fixtures: omitting them stays valid (no widening of the
  // single-tenant path) and the derived maxInFlight getter still holds.
  assert.equal(minimalWorkerPoolFixture.coResidence, undefined);
  assert.equal(minimalWorkerPoolFixture.maxConcurrentTunnels, undefined);
  assert.equal(workerPoolFixture.coResidence, undefined);
  assert.equal(workerPoolFixture.maxConcurrentTunnels, undefined);

  // Present on the co-resident fixture: both carry through and maxInFlight still mirrors
  // slotsPerMachine (the factory installs the getter regardless of the new optionals).
  assert.equal(coResidentWorkerPoolFixture.coResidence, true);
  assert.equal(coResidentWorkerPoolFixture.maxConcurrentTunnels, 8);
  assert.equal(coResidentWorkerPoolFixture.slotsPerMachine, 2);
  assert.equal(coResidentWorkerPoolFixture.maxInFlight, 2);
  assert.equal(
    coResidentWorkerPoolFixture.maxInFlight,
    coResidentWorkerPoolFixture.slotsPerMachine,
  );
});

test("WorkerPoolSettings.maxInFlight is a derived getter that always equals slotsPerMachine", () => {
  // Default 1: the derived alias mirrors the canonical field.
  assert.equal(workerPoolFixture.slotsPerMachine, 1);
  assert.equal(workerPoolFixture.maxInFlight, 1);
  assert.equal(workerPoolFixture.maxInFlight, workerPoolFixture.slotsPerMachine);

  // Build with a non-default value: maxInFlight tracks it with no second field to set.
  const multi = withDerivedMaxInFlight({
    enabled: true,
    driver: "fake",
    min: 0,
    max: 4,
    warm: 0,
    slotsPerMachine: 3,
    ttlMs: 3_600_000,
    idleReapMs: 300_000,
    acquireTimeoutMs: 30_000,
    reapIntervalMs: 15_000,
    staleHeartbeatMs: 600_000,
    drainDeadlineMs: 30_000,
  });
  assert.equal(multi.slotsPerMachine, 3);
  assert.equal(multi.maxInFlight, 3);

  // It is a live getter, not a snapshot: mutating slotsPerMachine re-derives maxInFlight,
  // so the two can never drift even if a later writer bumps the canonical field.
  multi.slotsPerMachine = 5;
  assert.equal(multi.maxInFlight, 5);
  assert.equal(multi.maxInFlight, multi.slotsPerMachine);

  // maxInFlight is read-only at runtime (no setter) so it cannot be assigned out of sync.
  const descriptor = Object.getOwnPropertyDescriptor(multi, "maxInFlight");
  assert.ok(descriptor);
  assert.equal(typeof descriptor?.get, "function");
  assert.equal(descriptor?.set, undefined);
});

test("WorkerSettings.workerPool is optional and additive", () => {
  assert.equal(workerWithoutPool.workerPool, undefined);
  assert.equal(workerWithPool.workerPool?.driver, "fake");
});

test("RunningEntry.workerHost is optional and concrete-or-null", () => {
  assert.equal(runningEntryFixture.workerHost, undefined);
  const withHost: RunningEntry = { ...runningEntryFixture, workerHost: "user@host-a:22" };
  assert.equal(withHost.workerHost, "user@host-a:22");
});
