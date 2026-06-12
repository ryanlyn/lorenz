# Eliminating the `pending://` sentinel: two-phase slot reservation

Status: implemented (all five stages; run_reserving lane, capacity-freed poll nudge, and the stall-reconciler regression pin included)
Scope: `ts/packages/{orchestrator,runtime,dispatch-coordinator,domain,runtime-events}` and `ts/apps/cli`

## 1. Problem statement

When the worker box pool governs capacity, `Orchestrator.claim()` must answer "which
host?" synchronously, but the pool's answer is asynchronous (a box may need to be
provisioned and probed). The current escape hatch is a fake host:

```ts
// packages/orchestrator/src/index.ts (claim, pool-governs branch)
workerHost = `pending://${issue.id}/${slotIndex}`;
```

The runtime later patches it with the real address via `Orchestrator.setWorkerHost`
once `coordinator.acquireRunSlot` binds a box, or unwinds the whole claim via
`Orchestrator.abandonClaim` when the acquire reports no capacity.

The core critique this design answers, verbatim:

> The pending:// sentinel encodes a TEMPORAL dependency: claim() hands out a fake
> host, the runtime later overwrites it (setWorkerHost) or un-claims (abandonClaim).
> Downstream code must know the sentinel exists (cleanupWorkerHost). The orchestrator
> should instead negotiate with something so a claim only ever carries a MEANINGFUL,
> CONCRETE, READY host.

The sentinel leaks far beyond the claim site:

- `cleanupWorkerHost` (packages/runtime/src/index.ts) must launder it to `null`
  before workspace/resume cleanup, or the cleanup sink would SSH to `pending://...`.
- `isLocalWorkerHost` carries a `startsWith("pending://")` special case in BOTH
  `dispatch-coordinator/src/coordinator.ts` and
  `dispatch-coordinator/src/mcpEndpointManager.ts`.
- `RunningEntry.affinityHost` exists in `@symphony/domain` solely so retry affinity
  survives the sentinel overwriting `workerHost` at claim time.
- The TUI/HTTP running lane shows a fake host during the acquire window.
- There is a live bug: `reconcileStalledRuns` (packages/runtime/src/index.ts) judges
  staleness from `lastAgentTimestamp ?? startedAt` over running entries. An
  in-acquire entry has `lastAgentTimestamp = null` and `startedAt` = claim time, so a
  slow cold provision can be stall-finished, and `Orchestrator.finish()` then
  persists `pending://...` into `RetryEntry.workerHost` - a bogus retry host and a
  bogus affinity key.

A second critique was raised alongside this one:

> The provider registry is module-global with side-effect registration at import;
> adding a provider means touching domain PROVIDER_KINDS, the config enum, the
> registry, and the package. The pool should be an SDK where new providers register
> without touching core logic.

This design deliberately does not address the provider registry. The negotiation
seam is orthogonal to provider pluggability: nothing here deepens the registry
coupling (`acquireRunSlot` talks only to `pool.acquire`), so a later SDK-ification
of providers slots in beneath this design unchanged. See open questions.

## 2. Chosen design: two-phase slot reservation

The orchestrator's claim splits into two synchronous phases with an asynchronous
negotiation between them, owned by the component that already performs it:

- Phase 1 (`claim`, synchronous, on the poll thread): when the pool governs, the
  orchestrator mints a host-less `SlotReservation` instead of a `RunningEntry`. The
  reservation holds the dispatch slot (`state.claimed` + a new `state.reserved`
  map), counts toward every concurrency cap, and carries the retry affinity. No host
  string of any kind is recorded.
- Negotiation (asynchronous, inside the detached per-run promise): the runtime
  drives the coordinator's existing `acquireRunSlot` - pool acquire, collision
  guard, tunnel-ceiling reservation, per-run MCP endpoint opened AFTER the lease
  bind - exactly as it does now. The coordinator and pool are behaviorally
  untouched.
- Phase 2 (`bindReservation`, synchronous): only when a `RunSlot` is bound does the
  orchestrator mint the `RunningEntry`, atomically, with the concrete, probe-ready
  `slot.workerHost`. The orchestrator never stores a non-real host.

A capacity refusal or acquire fault cancels the reservation via
`cancelReservation`, which frees the slot with no backoff penalty AND restores the
retry entry the reservation consumed - so affinity and the attempt counter survive a
capacity race (a strict improvement over the `abandonClaim` path, which destroyed
both).

Why this design: it is the most conservative correct shape. The pool
(`worker-box-pool/src/pool.ts`) and the coordinator's acquire machinery - the two
proven, crash-safety-critical surfaces - are untouched except for two one-line
sentinel-string deletions. All new machinery (a reservation map with a token guard,
an expiry sweep, two new orchestrator methods) is confined to one package. Cold
provision latency is byte-identical because the acquire still runs inside the
detached run promise. The alternatives considered (section 12) either rewrote the
pool core and coordinator API simultaneously while minting a new cross-package
temporal invariant, or shipped the same reservation core with correctness holes
(no token guard, no expiry, a duplicate-dispatch hazard) plus rename churn.

### Component diagram

```
poll loop (serialized by pollInProgress; claim is synchronous inside it)
   |
   v
+----------------------------- runtime (packages/runtime) ------------------------------+
| maybeDispatch(issue) --> orchestrator.claim(refreshed)                                 |
|     |                                                                                  |
|     +--> { kind: "running", entry }     static/local path, byte-identical to today:    |
|     |        (no pool governing)        run_started now, runClaim with concrete host,  |
|     |                                   NO acquire inside                              |
|     |                                                                                  |
|     +--> { kind: "reserved", reservation }   pool governs: emit run_reserving,         |
|              |                               spawn DETACHED runReservedClaim           |
|              v                               (poll loop continues immediately)         |
|         await coordinator.acquireRunSlot({ affinityKey: reservation.affinityHost,      |
|              |                              signal: handle.signal, ... })              |
|              |                                                                         |
|              +-- no_capacity / throw --> cancelReservation (restores RetryEntry)       |
|              +-- bound ----------------> bindReservation(reservation, slot.workerHost) |
|                                          --> RunningEntry (CONCRETE host) --> runner   |
+---------------------------------------------|------------------------------------------+
        ^                                     |
        | claim / bindReservation /           v
        | cancelReservation         +-- dispatch-coordinator (UNCHANGED machinery) --+
        v                           |  pool.acquire -> collision guard -> tunnel     |
+-- orchestrator ------------+      |  ceiling -> mcp endpoint open AFTER lease bind |
| state.running              |      |  -> registered RunSlot | typed no_capacity    |
| state.reserved   (NEW)     |      +----------------------+-------------------------+
| state.claimed              |                             |
| state.retryAttempts        |                             v
|                            |             +-- worker-box-pool (UNTOUCHED) ----------+
| every workerHost in every  |             | selectAndStamp / grow / FIFO waiters    |
| map is concrete or null -  |             | write-ahead ledger / hydrate / drain    |
| no sentinel can exist      |             | spend caps / reaper / recycle           |
+----------------------------+             +-----------------------------------------+
```

## 3. Components and ownership

### 3.1 Orchestrator (packages/orchestrator/src/index.ts) - owns the dispatch-slot reservation

New state: `OrchestratorState.reserved: Map<string, ReservationRecord>` keyed by
`slotKey(issueId, slotIndex)`. A `ReservationRecord` holds:

```ts
interface ReservationRecord {
  issue: Issue;                 // kept whole so runningByState accounting works
  slotIndex: number;
  token: string;                // opaque per-reservation token (ABA guard)
  agentKind: AgentKind;
  ensembleSize: number;
  affinityHost: string | null;  // prior run's concrete host from the consumed retry
  retryAttempt: number | null;
  reservedAt: Date;
  expiresAtMonotonicMs: number; // defensive expiry, swept by eligibleIssues
  /** The due RetryEntry consumed at reserve time, kept so cancel can restore it. */
  consumedRetry: { key: string; entry: RetryEntry } | null;
}
```

`claim(issue)` changes its return type to a discriminated union (`ClaimResult`):

- Static/local branch (no probe, or `!capacityProbe.governs()`): exactly today's
  body - `selectWorkerHost(retry?.workerHost)`, mint the `RunningEntry`, add to
  `claimed` + `running`, delete the consumed retry entry - returned as
  `{ kind: "running", entry }`. Byte-identical when the pool is absent or disabled.
- Pool-governs branch (replaces the `pending://` mint): runs the same
  `shouldDispatchIssue` + `firstUnclaimedSlot` checks, consumes the due retry entry
  exactly where claim does today (`retryAttempts.delete(retryEntryKey)`) but stashes
  the consumed `{key, entry}` pair on the record, registers the `ReservationRecord`,
  adds the key to `state.claimed` (NOT `running`), and returns
  `{ kind: "reserved", reservation }`.
  `expiresAtMonotonicMs = monotonicMs() + (boxPool?.acquireTimeoutMs ?? 30_000) * 2 + 60_000`,
  strictly longer than any well-behaved acquire (the pool's waiter timer bounds the
  non-grow path at `acquireTimeoutMs`; the generous grace covers a grow's
  provision + readiness probes).

`bindReservation(reservation, workerHost): RunningEntry | null` - synchronous.
Verifies `reserved.get(key)?.token === reservation.token` (the ABA guard: a
cancel + re-reserve + late bind must not activate against the successor's record).
On mismatch returns null and the caller releases the bound slot healthy. Otherwise
it mints the `RunningEntry` with the CONCRETE host (same field initialization as
today's claim, `startedAt = clock.now()` so run seconds no longer bill the
provision wait), moves the key from `reserved` to `running`, and seeds
`usageDeltaBases`.

`cancelReservation(reservation): void` - idempotent, token-checked. Deletes the
record and the `claimed` key, writing NO new retry entry and NO backoff. It then
RESTORES the consumed retry entry (`if (!retryAttempts.has(consumedRetry.key))
retryAttempts.set(consumedRetry.key, consumedRetry.entry)`), so a capacity-missed
slot keeps its `RetryEntry.workerHost` affinity and attempt counter. The restored
entry's deadline already passed, so the issue is immediately re-eligible - the
no-penalty re-eligibility `abandonClaim` provided, plus affinity retention it lost.
Restore-then-delete composes safely with `cleanupIssue`, which deletes all retry
entries for the issue after cancelling its reservations.

Concurrency-cap parity: today the sentinel entry sits in `running` during the
acquire window, so it counts toward `global_concurrency_cap` and
`local_concurrency_cap`. The `reserved` map restores that at the exactly two
computation sites:

- `eligibleIssues`: `runningCount = running.size + reserved.size`; fold each
  reservation's `normalizeStateName(record.issue.state)` into `runningByState`.
- `claim`'s `shouldDispatchIssue` precheck: the same fold.

`claimedSlots` already contains reserved keys because reserve does `claimed.add`.

Guards on existing code paths (each one is load-bearing):

- `releaseStaleClaimsForRetry` deletes any claimed key with no running entry.
  Claimed-without-running is now a legitimate state, so it MUST skip keys present in
  `reserved` - otherwise a due retry on one ensemble slot would free another slot's
  live reservation and allow a duplicate same-`(issueId, slotIndex)` reservation.
- `cleanupIssue` additionally cancels every reservation for the issue (delete from
  `reserved` + `claimed`; the subsequent `deleteRetryAttemptsForIssue` removes any
  restored entry), so tracker reconciliation mid-acquire works. The in-flight
  acquire then resolves and its `bindReservation` returns null.
- `refreshRunningIssue` also updates `reserved` records' `issue` so per-state cap
  accounting never reads a stale issue state during a long acquire.
- Expiry sweep: `eligibleIssues` (which already runs `cleanupRetryAttempts`)
  cancels any reservation past `expiresAtMonotonicMs` (with retry restore). This
  replaces the recovery property the sentinel design got by accident from
  `reconcileStalledRuns`: a hung acquire (e.g. a wedged endpoint open) can no longer
  strand a concurrency slot until `stop()`. A late successful acquire after the
  sweep is token-guarded to a null bind and the slot is released healthy.

`snapshot()` gains `reserving: ReservationSnapshotEntry[]` so the TUI/HTTP surface
shows in-acquire runs honestly (they no longer appear in `running` with a fake
host).

### 3.2 DispatchCoordinator (packages/dispatch-coordinator) - already the capacity-side negotiation; no structural change

`acquireRunSlot` IS the negotiation the orchestrator needed: the pool's synchronous
`selectAndStamp` (affinity > warm idle > under-capacity grow > FIFO waiter), the
`reservedProvisions` single-flight, the `(issueId, slotIndex)` co-residence
collision guard, the tunnel-ceiling reservation taken in the same tick as the
check, the endpoint-open-AFTER-lease-bind ordering, and the
lease-settled-healthy-before-throw handling of `EndpointOpenError` /
`RunSlotCollisionError` all stay byte-identical.

The only source edits in this package are sentinel-string deletions:

```ts
// coordinator.ts and mcpEndpointManager.ts, after:
function isLocalWorkerHost(workerHost: string): boolean {
  return workerHost.length === 0;   // the pending:// clause is deleted
}
```

A pool lease's `workerHost` is always a real ssh address, so only the empty-string
local check remains. No `@symphony/mcp` runtime import is added anywhere;
`AgentMcpEndpointLease` stays type-only and `acquireAgentMcpEndpointForRun` stays
injected from `apps/cli/src/daemon.ts`.

A later, optional consolidation (migration stage 4) absorbs the capacity probe into
the coordinator itself: `governs()` and `canAcquire()` become coordinator methods,
the orchestrator takes the coordinator directly as its authority, and the
`capacityProbe()` accessor, the module-level `probe` const, and the duplicate
`isEnabled()` are deleted. The `acquireRunSlot` name is deliberately kept - renaming
it buys nothing and churns every coordinator and e2e test.

### 3.3 Runtime (packages/runtime/src/index.ts) - sequences the two phases

`maybeDispatch` branches on the `ClaimResult` union:

- `null`: unchanged `dispatch_skipped stale_before_dispatch`.
- `{ kind: "running" }`: today's path verbatim - `run_started`,
  `onIssueDispatched`, spawn `runClaim` with the concrete/static host and NO acquire
  inside. The `coordinator.isEnabled()` gate inside `runClaim` disappears: the
  branch decision is made once, at claim time, by the same `governs()` predicate,
  so disabled-pool-after-reload behavior is identical with the branch moved one
  frame earlier.
- `{ kind: "reserved" }`: emit a new additive `run_reserving` event,
  `onIssueDispatched`, mint the `ActiveRunHandle` (abort plumbing unchanged - the
  handle's signal still reaches the pool's FIFO waiter), and spawn the detached
  `runReservedClaim`. The poll loop continues immediately; a cold provision never
  blocks the poll thread, exactly as today.

`runReservedClaim` (replacing today's acquire block inside `runClaim`):

1. `acquired = await coordinator.acquireRunSlot({ issueId, slotIndex, labels,
   affinityKey: reservation.affinityHost, timeoutMs: acquireTimeoutMs,
   signal: handle.signal, settings: this.workflow.settings,
   needsMcpEndpoint: true })` - the request shape is unchanged; affinity now comes
   from the reservation instead of the deleted `RunningEntry.affinityHost`.
2. `no_capacity` -> `dispatch_skipped <id> worker_host_capacity` (every typed reason
   maps to this one event, as today) -> `cancelReservation` (restores the retry
   entry) -> `syncRetryTimer(issue.id)` so the restored due entry schedules a prompt
   re-poll -> `handle.release()` -> return. No `run_started` was ever emitted, no
   history recorded.
3. Thrown acquire fault (`EndpointOpenError`, `RunSlotCollisionError`,
   provider/ledger fault) -> `dispatch_skipped <id> box_pool_acquire_error <msg>`
   -> `cancelReservation` -> `handle.release()` -> return. The coordinator already
   settled any just-bound lease healthy before throwing; nothing crossed the
   boundary, so there is nothing for the runtime to settle.
4. `bound` -> `entry = orchestrator.bindReservation(reservation, slot.workerHost)`,
   in the same JS tick as the acquire's resolution (no await between them). If null
   (cancelled/expired during the acquire): `await slot.release("healthy")` (the
   RunSlot's settled-once guard makes this exactly-once),
   `dispatch_skipped <id> reservation_lapsed`, `handle.release()`, return. The box
   goes back to warm inventory; nothing leaks.
5. Otherwise emit `run_started`, then run today's runner/finish/catch/finally body
   verbatim with `effectiveWorkerHost = slot.workerHost`. The finally settle
   (`slot.fail("box_poisoned")` / `slot.release("healthy")`, stall-poison override)
   is untouched.

`reconcileTrackedIssues` uses `entry.workerHost` directly (always concrete or null;
`cleanupWorkerHost` is deleted) and additionally folds `snapshot().reserving`
issues into its `tracked` map with `workerHost: null, workspacePath: null`, so an
issue that goes terminal mid-acquire is still aborted and cleaned up (parity with
today, where the sentinel running entry was tracked and laundered to null).

`reconcileStalledRuns` needs no change: it iterates `snapshot().running`, and a
reserving slot has no running entry, which structurally fixes the
sentinel-into-`RetryEntry.workerHost` bug. A regression test pins it (stage 2).

### 3.4 Domain and events

- `@symphony/domain`: delete `RunningEntry.affinityHost` (affinity travels on the
  reservation) and scrub the `pending://` doc comments. `RetryEntry.workerHost`
  semantics are unchanged: `finish()` records the bound entry's concrete host, which
  feeds the next reservation's `affinityHost` -> `acquireRunSlot.affinityKey` ->
  pool `pickRecord` sticky re-land.
- `@symphony/runtime-events`: add `"run_reserving"` to `RUNTIME_EVENT_TYPES` and
  `reserving?: ReservationSnapshotEntry[]` to `RuntimeSnapshot`. Both additive.
- `apps/cli/src/daemon.ts`: wiring is unchanged (`buildBoxPool` /
  `buildDispatchCoordinator`); only the `pending://` doc comments are scrubbed.

## 4. Reservation lifecycle

```
                      claim(issue), pool governs
 (unclaimed) -----------------------------------------> RESERVED
      ^          claimed.add(key); reserved.set(key)   token, expiry,
      |          due RetryEntry consumed -> stashed    counted in caps,
      |                                                host-less
      |                                                  |        |
      |  cancelReservation:                              |        | bindReservation(token ok):
      |   - no_capacity refusal                          |        | RunningEntry minted with
      |   - thrown acquire fault                         |        | CONCRETE slot.workerHost,
      |   - expiry sweep (hung acquire)                  |        | startedAt = now,
      |   - cleanupIssue (terminal/missing mid-acquire)  |        | reserved -> running
      |  restores the consumed RetryEntry                |        v
      +<-------------------------------------------------+     RUNNING
      |                                                   (concrete host; visible to
      |                                                    stall reconciler from here)
      |                  finish() / cleanupIssue                   |
      +<------------------------------------------------------------+

 Late bind after cancel/expiry: bindReservation sees a token mismatch -> null;
 the caller releases the bound RunSlot healthy (settled-once guarded) and emits
 dispatch_skipped reservation_lapsed. Safe but wasteful churn; never a leak.
```

Serialization argument: polls are serialized by `pollInProgress`, and within a poll
`maybeDispatch` runs `orchestrator.claim` synchronously before spawning the run
promise. The first reservation's key is in `state.claimed` before any other
dispatch evaluation runs, so `firstUnclaimedSlot` / `shouldDispatchIssue` reject a
second reservation of the same slot. Bind happens in the same JS tick as the
acquire's resolution, so the only bind failure mode is the token-mismatch path.

## 5. Sequences

### 5.1 Happy path (pool governs, warm or cold box)

```
poll loop        orchestrator              runReservedClaim          coordinator              pool
   |                  |                    (detached promise)             |                     |
   |--claim(issue)--->|                           |                       |                     |
   |                  | reserve: claimed.add      |                       |                     |
   |                  | reserved.set(key,rec)     |                       |                     |
   |                  | due retry consumed->rec   |                       |                     |
   |<-{reserved,res}--|                           |                       |                     |
   | run_reserving    |                           |                       |                     |
   | onIssueDispatched|                           |                       |                     |
   |--spawn---------------------------------->    |                       |                     |
   | (poll continues; cold provision               |                       |                     |
   |  never blocks the poll thread)               |--acquireRunSlot------>|                     |
   |                  |                           |  (affinityKey,signal) |--pool.acquire------>|
   |                  |                           |                       |   selectAndStamp /  |
   |                  |                           |                       |   grow / waiter     |
   |                  |                           |                       |<---lease------------|
   |                  |                           |                       | collision guard     |
   |                  |                           |                       | tunnel reservation  |
   |                  |                           |                       | endpoint open AFTER |
   |                  |                           |                       | lease bind          |
   |                  |                           |<--{bound, slot}-------|                     |
   |                  |<-bindReservation(res, slot.workerHost)            |                     |
   |                  |  token ok: RunningEntry   |                       |                     |
   |                  |  (CONCRETE host,          |                       |                     |
   |                  |   startedAt = now),       |                       |                     |
   |                  |  reserved -> running      |                       |                     |
   |                  |--entry------------------->|                       |                     |
   |                  |                           | run_started; runner   |                     |
   |                  |<--applyUpdate/heartbeat---|  executes             |                     |
   |                  |<--finish(): RetryEntry.workerHost = concrete host |                     |
   |                  |                           |--slot.release/fail--->| endpoint closed     |
   |                  |                           |   (finally, once)     | BEFORE lease settle |
   |                  |                           |                       |--settle------------>|
```

### 5.2 Failure path A: no capacity

1. `acquireRunSlot` resolves `{ status: "no_capacity", reason }`
   (`acquire_timeout` | `spend_cap` | `pool_disabled` | `provider_error` |
   `tunnel_exhausted`; the pool's waiter timer or `handle.signal` bounds the wait at
   `acquireTimeoutMs`).
2. Runtime: `addEvent("dispatch_skipped", "<id> worker_host_capacity")` - one event
   for every reason, as today - then `cancelReservation(reservation)`: slot freed,
   no backoff, and the consumed RetryEntry is RESTORED so affinity and the attempt
   counter survive. `syncRetryTimer`, `handle.release()`, return. No history, no
   `run_started` (today's phantom started-then-skipped pair disappears).
3. Next poll: the issue is immediately re-eligible; `eligibleIssues` re-gates on
   `canAcquire()`. If capacity stays exhausted, the pre-existing penalty path is
   untouched: the issue blocks as `worker_host_capacity` and its due retries get
   `rescheduleRetryAfterDispatchBlock` backoff, exactly as today.

### 5.3 Failure path B: provision / endpoint-open fault after capacity work started

- The pool's grow fails: `acquireRunSlot` resolves `no_capacity:provider_error`
  (the pool already deleted the provisional ledger row and attempted destroy
  internally) -> path A.
- `EndpointOpenError` / `RunSlotCollisionError` / ledger fault: `acquireRunSlot`
  THROWS, after internally settling the just-bound lease HEALTHY and releasing its
  tunnel reservation (unchanged coordinator code). Runtime catch:
  `dispatch_skipped <id> box_pool_acquire_error <msg>` -> `cancelReservation`
  (restore) -> `handle.release()` -> return. No partial run, no history, the box
  was never poisoned.

### 5.4 Failure path C: late bind (replaces setWorkerHost's silent no-op)

- The issue was cleaned up, the runtime stopped, or the reservation expired while
  the acquire was in flight: `cleanupIssue` / the expiry sweep cancelled the
  reservation (token retired). The acquire still resolves `bound`.
- `bindReservation` returns null (token mismatch). Runtime:
  `await slot.release("healthy")` (exactly-once via the slot's settled flag),
  `dispatch_skipped <id> reservation_lapsed`, `handle.release()`, return. The box
  returns to warm inventory.
- This is strictly better than today, where the acquire would launch the runner
  against an already-aborted signal just to tear it down immediately.

### 5.5 Cross-cutting race: stop/cleanup during the acquire

`stop()` / `abortIssueRuns` / `cleanupIssue` abort `handle.signal`; an in-flight
pool waiter resolves `acquire_timeout` -> path A. If the bind already resolved,
path C. The recycle-driven `slot.fail` path and the drain barrier
(`pendingRecycleFails`) are untouched.

## 6. API sketches

```ts
// ── packages/orchestrator/src/index.ts ─────────────────────────────────────

/** Phase-1 hold on a dispatch slot while the coordinator negotiates capacity.
 *  Host-less by design: the orchestrator never records a non-concrete host. */
export interface SlotReservation {
  readonly issueId: string;
  readonly identifier: string;
  readonly slotIndex: number;
  /** Opaque per-reservation token; bind/cancel are no-ops on mismatch (ABA guard). */
  readonly token: string;
  readonly agentKind: AgentKind;
  readonly ensembleSize: number;
  /** Prior run's CONCRETE workerHost from the consumed RetryEntry; threads into
   *  AcquireRunSlotRequest.affinityKey. */
  readonly affinityHost: string | null;
  readonly retryAttempt: number | null;
  /** Defensive expiry (acquireTimeoutMs * 2 + 60s grace); swept by eligibleIssues. */
  readonly expiresAtMonotonicMs: number;
}

export type ClaimResult =
  /** Static/local path (no governing pool): byte-identical to the previous claim. */
  | { kind: "running"; entry: RunningEntry }
  /** Pool governs: slot held; the host arrives via bindReservation after the
   *  coordinator binds a RunSlot. */
  | { kind: "reserved"; reservation: SlotReservation };

export interface OrchestratorState {
  running: Map<string, RunningEntry>;
  reserved: Map<string, ReservationRecord>;  // NEW - counted in EVERY cap check
  claimed: Set<string>;                      // contains running AND reserved keys
  retryAttempts: Map<string, RetryEntry>;
  // ... unchanged
}

export class Orchestrator {
  claim(issue: Issue): ClaimResult | null;   // null = not eligible (as today)

  /** Phase 2: atomically mint the RunningEntry with the CONCRETE bound host.
   *  Returns null when the reservation was cancelled/expired meanwhile
   *  (caller releases the bound slot healthy). */
  bindReservation(reservation: SlotReservation, workerHost: string): RunningEntry | null;

  /** Frees the slot with NO backoff and RESTORES the consumed RetryEntry
   *  (affinity + attempt counter survive). Idempotent, token-checked.
   *  Replaces abandonClaim. */
  cancelReservation(reservation: SlotReservation): void;

  // DELETED: setWorkerHost(issueId, slotIndex, host)
  // DELETED: abandonClaim(issueId, slotIndex)

  snapshot(): {
    running: RunningEntry[];
    reserving: ReservationSnapshotEntry[];   // NEW, additive
    retrying: RetryEntry[];
    blocked: DispatchBlockEntry[];
    usageTotals: UsageTotals;
    rateLimits: unknown;
  };
}

export interface ReservationSnapshotEntry {
  issueId: string;
  identifier: string;
  slotIndex: number;
  affinityHost: string | null;
  retryAttempt: number | null;
  reservedAtIso: string;
}

// ── packages/runtime/src/index.ts (consumption sketch) ─────────────────────

// maybeDispatch branches on ClaimResult:
//   null            -> dispatch_skipped stale_before_dispatch (unchanged)
//   kind "running"  -> run_started + runClaim(entry, slot = none)  (today verbatim)
//   kind "reserved" -> run_reserving + spawn runReservedClaim(issue, reservation, ...)

private async runReservedClaim(
  issue: Issue,
  reservation: SlotReservation,
  runId: string,
  handle: ActiveRunHandle,
): Promise<void>;
// inside:
//   acquireRunSlot({ issueId, slotIndex: reservation.slotIndex, labels: issue.labels,
//     affinityKey: reservation.affinityHost,
//     timeoutMs: settings.worker.boxPool?.acquireTimeoutMs ?? 30_000,
//     signal: handle.signal, settings: this.workflow.settings, needsMcpEndpoint: true })
//   no_capacity -> dispatch_skipped worker_host_capacity + cancelReservation + return
//   throw       -> dispatch_skipped box_pool_acquire_error + cancelReservation + return
//   bound       -> bindReservation(reservation, slot.workerHost)
//                    ?? (slot.release("healthy") + dispatch_skipped reservation_lapsed)
//                 then run_started + the existing runner/finish/finally body

// DELETED: cleanupWorkerHost(workerHost)   (the pending:// -> null launderer)
// DELETED: runClaim's affinityHost parameter and the coordinator.isEnabled() gate

// ── packages/dispatch-coordinator ───────────────────────────────────────────
// AcquireRunSlotRequest, AcquireRunSlotResult, NoCapacityReason, RunSlot,
// EndpointOpenError, RunSlotCollisionError, createRunSlot, the tunnel ceiling,
// reconcile/drain/hydrate/snapshot: ALL UNCHANGED.
function isLocalWorkerHost(workerHost: string): boolean {
  return workerHost.length === 0;            // pending:// clause deleted
}
// src/mcpEndpointManager.ts: the same one-line deletion.

// Stage-4 consolidation (optional): the coordinator absorbs the probe -
//   interface DispatchCoordinator extends CapacityProbe { ... }  // governs/canAcquire
// the runtime passes the coordinator itself as the orchestrator authority, and
// capacityProbe(), the module probe const, and isEnabled() are deleted.

// ── packages/domain/src/index.ts ────────────────────────────────────────────
// RunningEntry: DELETED field `affinityHost`. RetryEntry unchanged.

// ── packages/runtime-events/src/index.ts ────────────────────────────────────
// RUNTIME_EVENT_TYPES: + "run_reserving"                  (additive)
// RuntimeSnapshot:     + reserving?: ReservationSnapshotEntry[]  (additive)
```

## 7. Invariants preserved

1. Byte-identical when `worker.box_pool` is absent/disabled. With no coordinator
   (or `governs() === false` after a disabling reload), `claim()` takes the
   unchanged static branch: same `selectWorkerHost`, same `RunningEntry` fields,
   same `run_started` timing, same `runClaim` body with no acquire. No reservation
   object is ever created on this path, and the `cleanupWorkerHost` deletion is
   inert because nothing ever produced a sentinel.
2. Exactly-once lease settlement; endpoint-close-before-lease-settle. The
   coordinator and pool are untouched. The RunSlot's single `settled` flag plus the
   lease's leaseId/generation/DESTROYED guards remain the authority. The one new
   settle call site (`slot.release("healthy")` on a null bind) goes through the
   same guard and returns before the runner block, so it can never double-fire
   against the finally settle. The recycle-driven `slot.fail` ordering (endpoint
   close -> lease settle -> deregister, inside the per-box mutex callback) is
   unchanged.
3. No `@symphony/mcp` runtime deps in worker-box-pool / dispatch-coordinator. The
   only edits in those packages are string-literal deletions inside existing
   functions. `AgentMcpEndpointLease` stays type-only; `acquireAgentMcpEndpointForRun`
   stays injected from the daemon.
4. Retry affinity. Reserve consumes the due RetryEntry exactly where claim does
   today and carries `retry.workerHost` as `reservation.affinityHost`; the runtime
   threads it as `affinityKey`; the pool's `pickRecord` affinity-first selection is
   unchanged; `finish()` writes the bound entry's CONCRETE host into the new
   RetryEntry. Strictly improved twice over: a run can no longer record a sentinel
   as its retry host in any interleaving, and a capacity miss no longer destroys
   the affinity/attempt state (cancel restores the entry).
5. Capacity-blocked no-penalty re-eligibility. `cancelReservation` writes no new
   retry record and no backoff; the restored entry is already due, so the issue is
   immediately re-claimable - the observable guarantee `abandonClaim` provided. The
   pre-existing penalty path is preserved unchanged: `eligibleIssues` with
   `canAcquire() === false` still blocks as `worker_host_capacity` and still runs
   `rescheduleRetryAfterDispatchBlock`.
6. Crash safety (ledger/hydrate/drain). `worker-box-pool/src/pool.ts` is untouched:
   write-ahead provisional rows, correlate, hydrate's authoritative `list()`
   reconcile, drain epochs, and spend flush are all unchanged. Strictly improved on
   the runtime side: reservations are process-memory only (like today's pending
   claims) but can no longer pollute history/snapshots/cleanup with fake hosts, so
   post-restart workspace/resume cleanup never attempts an SSH to a sentinel.
7. Cold-provision dispatch latency: unchanged in both directions. The acquire
   (cold `provision` + readiness probes, bounded by `acquireTimeoutMs` via the
   pool's waiter timer and `handle.signal`) runs inside the spawned, non-awaited
   per-run promise exactly as today; reserve and bind are synchronous and add zero
   awaits; concurrent acquires keep the pool's single-flight/FIFO behavior. The
   poll loop never awaits a provision. The only visible difference is bookkeeping:
   during a cold provision the run shows in `snapshot().reserving` instead of as a
   running entry with a fake host.

## 8. Intentional behavioral deltas (pool-governed path only)

1. `run_started` fires after bind (post-acquire) instead of pre-acquire, and a
   capacity-refused dispatch no longer emits a phantom `run_started` followed by
   `dispatch_skipped`. The additive `run_reserving` event marks dispatch intent.
2. In-acquire runs appear in `snapshot().reserving` (honest, host-less) instead of
   `running` (fake host).
3. `startedAt` / `secondsRunning` exclude the provision wait - more accurate spend
   accounting, but a small step change for dashboards comparing before/after.
4. The stall reconciler can no longer fire during the acquire window (no running
   entry exists), which fixes the latent sentinel-into-`RetryEntry.workerHost` bug.
   A hung acquire is bounded by `acquireTimeoutMs`, the abort signal, and the new
   reservation expiry sweep instead.
5. A capacity-missed slot now retains its retry entry (affinity + attempt count).
   One knock-on: if a later eligibility pass is capacity-blocked, that restored due
   retry picks up `rescheduleRetryAfterDispatchBlock` backoff - which is the
   standard pre-existing behavior for due retries at the eligibility gate, now
   applied consistently instead of being skipped because the entry had been
   destroyed.
6. A new `dispatch_skipped <id> reservation_lapsed` detail string appears for the
   late-bind path (previously this interleaving silently launched-then-tore-down a
   runner).

## 9. Migration plan (every stage lands green: lint, build, types, tests via the repo check task)

Stage 1 - orchestrator: dormant reservation machinery.
Add `OrchestratorState.reserved`, `SlotReservation` / `ReservationSnapshotEntry` /
`ReservationRecord`, `bindReservation`, `cancelReservation` (with retry restore),
and an internal `reserveSlot(issue)` helper. Fold reservations into
`runningCount` / `runningByState` at both computation sites (`eligibleIssues` and
`claim`). Teach `releaseStaleClaimsForRetry` to skip reserved keys. Extend
`cleanupIssue` (cancel the issue's reservations) and `refreshRunningIssue` (update
reserved records' issue). Add the expiry sweep to `eligibleIssues`. Add `reserving`
to `snapshot()`. `claim()`, `setWorkerHost`, and `abandonClaim` are untouched, so
`reserved` is always empty in production and every existing test passes.
New unit tests in `packages/orchestrator/test/orchestrator.test.ts`:
reserve/bind/cancel round-trip; token-guarded late bind; cancel restores the
consumed RetryEntry (and does not clobber a newer one); reserved slots counted
against `maxConcurrentAgents` and per-state caps; `releaseStaleClaimsForRetry`
skips a live reservation; expiry sweep cancels and restores; `cleanupIssue`
cancels mid-acquire. Plus the cap-parity property test: drive interleaved
reserve/bind/cancel/finish sequences asserting
`running.size + reserved.size <= maxConcurrentAgents` and
`claimed === union(running.keys, reserved.keys)` at every step.

Stage 2 - runtime cutover to two-phase (the one behavior-flipping stage).
Change `Orchestrator.claim` to return the `ClaimResult` union (static branch ->
`{ kind: "running" }`; the `pending://` branch replaced by `reserveSlot` ->
`{ kind: "reserved" }`). Rework `maybeDispatch` to branch on the union and split
`runClaim` into the static path (no acquire, byte-identical) and
`runReservedClaim` (acquire -> cancel on refusal/fault with retry restore ->
bind -> release-healthy-and-skip on null bind -> `run_started` -> existing
runner/finish/finally body). Thread `reservation.affinityHost` as `affinityKey`.
Fold `snapshot().reserving` issues into `reconcileTrackedIssues`. Add
`run_reserving` to `runtime-events` and `reserving` to `RuntimeSnapshot`.
`setWorkerHost` / `abandonClaim` become uncalled but still compile.
Test updates in `packages/runtime/test/runtime.test.ts`: the
"pending:// sentinel is visible between claim and acquire" test becomes a
reservation-visibility test (absent from `running`, present in `reserving`,
concrete host after bind); the two reconcile-skips-sentinel tests become
"reserved issue reconciles with null workerHost" tests; capacity-refusal tests
assert NO `run_started` and that the retry entry survives with its affinity.
New regression tests pinning the fixed latent bug: a reserving slot is never
stall-finished, and `RetryEntry.workerHost` is always concrete-or-null in every
interleaving. Update `ts/test/box-pool-e2e-memory.test.ts`,
`box-pool-multitenant.test.ts`, and `apps/cli/test/box-pool-wiring.test.ts` for the
new event ordering. This is the largest stage; land it as one PR.

Stage 3 - delete the sentinel machinery.
Remove `setWorkerHost`, `abandonClaim`, and all `pending://` construction from the
orchestrator (and the "deferring the real address" doc text on `CapacityProbe`).
Delete `cleanupWorkerHost` and its two call sites from the runtime. Drop the
`startsWith("pending://")` clauses from both `isLocalWorkerHost` functions
(coordinator and per-run endpoint manager; the empty-string guard stays). Delete
`RunningEntry.affinityHost` from `@symphony/domain` and its claim/runtime
passthroughs. Scrub `pending://` from comments in `daemon.ts`, coordinator,
endpoint manager, and domain. Sweep remaining tests that assert sentinels
(orchestrator sentinel/setWorkerHost/abandonClaim tests, coordinator pending-host
routing tests, `box-pool-endpoint-isolation.test.ts`,
`box-pool-endpoint-real-manager.test.ts` - local routing is now keyed only on the
empty string). Acceptance gate: `grep -rn 'pending://' ts/ --include='*.ts'`
returns zero hits.

Stage 4 - authority consolidation (optional, recommended).
Make `DispatchCoordinator` itself satisfy the orchestrator's capacity-authority
interface: add `governs()` (= `pool.isEnabled()`) and `canAcquire()`
(= `pool.canAcquire()`) as coordinator methods, pass the coordinator directly to
the `Orchestrator` constructor, then delete `capacityProbe()`, the module-level
`probe` const, and the duplicate `isEnabled()`. Update `wrapBoxPoolInCoordinator`
and the wiring/probe tests. Deliberately NOT renamed: `acquireRunSlot` keeps its
name (a rename would churn the full coordinator and e2e test surface for zero
behavioral payoff).

Stage 5 - observability and latency polish (optional, independent).
Surface the `reserving` lane in TUI/HTTP consumers (e.g. "provisioning box...").
Add a small additive pool hook `onCapacityAvailable(cb)` fired where
`wakeWaiters()` fires today, forwarded by the coordinator, wired by the runtime to
`queuePendingPoll` - so an issue skipped on `worker_host_capacity` re-dispatches
within one scheduler turn of a box landing warm instead of waiting out
`polling.intervalMs`. Update CONTRIBUTING/README prose describing claim ->
setWorkerHost with reserve -> acquire -> bind. Run the live-ssh and multitenant
suites (`ts/test/box-pool-live-ssh.test.ts`, `box-pool-multitenant.test.ts`)
end-to-end.

## 10. What gets deleted

`pending://`-era symbols, exhaustively:

- `Orchestrator.setWorkerHost(issueId, slotIndex, host)`
  (packages/orchestrator/src/index.ts).
- `Orchestrator.abandonClaim(issueId, slotIndex)` (same file) - replaced by
  `cancelReservation`, which additionally restores the consumed retry entry.
- The `pending://${issue.id}/${slotIndex}` minting branch inside
  `Orchestrator.claim`, and the "deferring the real address to a later
  setWorkerHost" sentence in the `CapacityProbe` doc comment.
- `cleanupWorkerHost(workerHost)` (packages/runtime/src/index.ts) and both call
  sites in `reconcileTrackedIssues` (which pass `entry.workerHost` directly).
- `runClaim`'s `affinityHost` parameter and `maybeDispatch`'s
  `claim.affinityHost ?? null` passthrough; the `coordinator.isEnabled()` acquire
  gate inside `runClaim` (the branch decision moves to claim time).
- `RunningEntry.affinityHost` (packages/domain/src/index.ts) and the `pending://`
  doc comments around it.
- The `startsWith("pending://")` clause of `isLocalWorkerHost` in
  packages/dispatch-coordinator/src/coordinator.ts AND
  packages/dispatch-coordinator/src/mcpEndpointManager.ts (empty-string guard
  stays); the `pending://` mentions in the tunnel-ceiling comment and the
  per-run-endpoint doc text.
- The `pending://` comments in apps/cli/src/daemon.ts (`buildDispatchCoordinator`
  doc block and the endpoint-manager wiring comment).
- Sentinel-asserting tests, replaced rather than dropped: the runtime
  sentinel-visibility test and both reconcile-skips-sentinel tests; the
  orchestrator sentinel/setWorkerHost/abandonClaim tests; the coordinator
  pending-host routing test; sentinel assertions in the box-pool e2e and endpoint
  isolation suites.
- With stage 4: `DispatchCoordinator.capacityProbe()`, the module-level `probe`
  const, and `DispatchCoordinator.isEnabled()` (folded into `governs()`).

Explicitly NOT deleted: `pool.acquire` and the FIFO waiter machinery,
`acquireRunSlot` and its typed `NoCapacityReason` set, `EndpointOpenError`,
`RunSlotCollisionError`, the tunnel-ceiling reservation, the write-ahead ledger,
and the provider registry. The proven capacity machinery stays where it is.

## 11. Risks and mitigations

- Cap-parity regression: if any site computing `runningCount` / `runningByState`
  misses the `reserved` fold-in, dispatch can exceed `maxConcurrentAgents` during
  acquire windows. There are exactly two computation sites (`eligibleIssues`,
  `claim`); both change in the same commit, pinned by a dedicated unit test and the
  stage-1 cap-parity property test.
- `releaseStaleClaimsForRetry` freeing a live reservation: claimed-without-running
  is now a legitimate state, and without the skip-reserved guard a due retry on one
  ensemble slot would free another slot's reservation, enabling duplicate
  same-slot dispatch. The guard plus a regression test land in stage 1, before any
  behavior flips.
- Expiry sweep racing a slow-but-successful acquire: a too-tight grace window means
  the token-guarded null bind releases a healthy box and skips the run - safe but
  wasteful churn. The deadline strictly dominates `acquireTimeoutMs` (2x + 60s
  grace) because a grow's provision + readiness probes can legitimately outlast the
  waiter timer; the `reservation_lapsed` event makes occurrences visible so the
  grace can be tuned.
- Event-stream/UI shape change: `run_started` moves post-bind and in-acquire runs
  move to the `reserving` lane. Consumers that timestamp dispatch from
  `run_started` (TUI, dashboards, docs-workflows tests) must be updated; mitigated
  by the additive `run_reserving` event, the additive snapshot lane, and a
  changelog note covering the `startedAt`/`secondsRunning` accounting shift.
- Retry-restore semantics: restoring the entry means a subsequently
  capacity-blocked issue applies the standard due-retry backoff at the eligibility
  gate, where the old destroy-the-entry path skipped it. This is the documented,
  intended consistency fix (section 8.5); a test pins the behavior so it cannot
  drift silently.
- Stale reservation issue data: a long acquire could otherwise hold a stale
  `issue.state` in cap accounting; mitigated by extending `refreshRunningIssue` to
  reserved records.
- Test churn volume: roughly fifteen test files reference the sentinel, claim
  shape, or `abandonClaim`/`setWorkerHost`. The staging keeps every stage green;
  stage 2 is the largest and lands as a single PR to avoid a half-flipped runtime.
- Hidden external callers of `setWorkerHost` / `abandonClaim` /
  `RunningEntry.affinityHost` (e.g. downstream forks of snapshot consumers) break
  at compile time; the union return type on `claim()` makes any missed caller a
  loud tsc error rather than runtime drift.

## 12. Rejected alternatives

Synchronous warm-inventory broker. In this shape, `claim()` consults an injected
broker whose `tryAcquire` binds synchronously from warm, probe-ready inventory
(the pool's `selectAndStamp` head) and returns a real host or a typed
`no_capacity`; a miss seeds a demand registry that grows the pool in the
background, and the per-run endpoint opens as the run's first await. It has the
best end state on paper: the FIFO waiter machinery is deleted, claim is fully
synchronous, warm dispatch gets faster, and the provider contract narrows to
provision-probe-warm. It was rejected because it concurrently rewrites the
crash-safety-critical pool core AND the coordinator API while changing scheduling
semantics (cold dispatch becomes skip-now-rebind-later dependent on a poll nudge;
provisioning runs stop counting toward `maxConcurrentAgents`; `acquireTimeoutMs`
silently changes meaning to a demand TTL), making the migration impossible to
bisect if an e2e regression appears. Worse, it replaces the sentinel's temporal
coupling with a new one: a stamped `BoxLease` plus tunnel reservation parked in
coordinator state whose safety depends on an unenforced
"no await between claim and the run's first await" invariant spanning three
packages - the same disease this redesign exists to eliminate - and its
tunnel-ceiling refusal settles a lease via fire-and-forget, turning a settle
rejection into an unhandled promise rejection. Its genuinely good ideas survive
here as grafts: retry-entry preservation on a capacity miss (ported as the
cancel-time restore), the warm-capacity poll nudge (stage 5), and the
selection-time collision filter (open question 2).

Coordinator-owned dispatch authority. The same reserve/bind/activate core as the
chosen design, with the coordinator additionally absorbing the capacity probe and
renaming `acquireRunSlot` to `bind` and `CapacityProbe` to `DispatchAuthority`. It
was rejected because the reservation machinery is underspecified exactly where it
is dangerous: it never addresses `releaseStaleClaimsForRetry`, so as written a due
retry on one slot frees another slot's live reservation and permits duplicate
same-slot dispatch; its activate guard is a bare `reserved.has(key)` with no token,
so a cancel + re-reserve + late bind activates against the successor's record (and
its post-activate `!handle.isActive` arm strands a just-minted running entry); and
it has no expiry on the bind window, so a wedged endpoint open leaks a reservation
invisibly until shutdown - while deferring the observability lane that would reveal
it. The rename program churns the full coordinator test surface for zero behavioral
payoff. Its best contributions are adopted: the probe-into-coordinator
consolidation (stage 4, without the renames), the cap-parity property test
(stage 1), and the verified diagnosis of the stall-reconciler sentinel bug, which
this design fixes structurally and pins with a regression test.

Keeping the sentinel but containing it (status quo plus). Centralizing the
sentinel checks behind one helper and documenting the claim -> setWorkerHost ->
abandonClaim protocol would shrink the leak surface without any migration. Rejected
because it cannot fix the category of bug: any state that stores a fake host can be
observed by code that does not know it is fake (the stall reconciler already
proves this), and every new snapshot consumer re-inherits the hazard. The temporal
protocol - claim hands out a value that is a lie until a later patch - remains, and
no amount of containment makes a lie safe to persist into retry state or hand to an
SSH cleanup sink.

## 13. Open questions

1. Provider-registry SDK-ification (the second critique): the module-global
   registry, the closed `PROVIDER_KINDS` config enum, and side-effect registration
   at barrel import are untouched here. The natural follow-up is config-driven
   factory injection (providers registered at daemon wiring, the config enum
   widened to a validated string), which slots in beneath this design since the
   negotiation only ever touches `pool.acquire`. Should that land as its own spec?
2. Should the coordinator's `(issueId, slotIndex)` co-residence guard become a
   selection-time filter threaded into the pool's `pickRecord` (a colliding box is
   never stamped), retiring `RunSlotCollisionError`'s bind-then-assert? It is a
   clean, isolated pool improvement, deliberately excluded here to keep the pool
   untouched.
3. Expiry grace tuning: is `acquireTimeoutMs * 2 + 60s` right for the slowest real
   provider (provision + readiness probes), or should the grow path also honor the
   abort signal so the acquire itself is firmly bounded and the sweep can tighten?
4. Should `run_reserving` carry the affinity host and retry attempt in its payload
   for dashboards, or is the snapshot `reserving` lane sufficient?
5. Should the snapshot distinguish "no capacity, pool growing" from "no capacity,
   capped" (e.g. surfacing the pool's growth headroom alongside the blocked lane)
   so operators can tell a transient miss from a hard cap without reading event
   volume?
6. Does any downstream consumer depend on `secondsRunning` including provision
   wait (spend dashboards)? If so, the `reservedAt` timestamp in the reserving
   lane can be used to reconstruct the old accounting during the transition.
