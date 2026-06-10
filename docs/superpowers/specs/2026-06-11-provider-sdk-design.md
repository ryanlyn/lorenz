# Worker Box Pool Provider SDK

Design for turning `@symphony/worker-box-pool` into a provider SDK so a third
party can ship a new box provider (their own cloud, their own VM fleet) without
touching `@symphony/domain` `PROVIDER_KINDS`, the config zod enum, the
module-global registry, or any core pool logic - while keeping config
validation helpful, startup fail-loud semantics, and the conformance guarantees
of built-ins.

The `pending://` sentinel in the claim flow is addressed by the sibling design
"2026-06-11-no-pending-sentinel-design.md" (two-phase slot reservation). The
two designs are orthogonal and independently shippable, and nothing in this
design touches the dispatch path.

All file references are to `ts/` packages; line numbers reflect the code as of
this writing and exist to anchor symbols, not to be load-bearing.

---

## 1. Problem statement

**Adding a provider means touching four core surfaces.**

> The provider registry is module-global with side-effect registration at
> import; adding a provider means touching domain PROVIDER_KINDS, the config
> enum, the registry, and the package. The pool should be an SDK where new
> providers register without touching core logic.

Concretely: `packages/domain/src/index.ts:87-92` defines a closed
`PROVIDER_KINDS` tuple and `BoxPoolProvider` union;
`packages/config/src/schemas.ts:153` validates `provider` with
`z.enum(PROVIDER_KINDS)`; `packages/worker-box-pool/src/registry.ts:11-46`
holds a module-global `Map` with `registerBoxProvider` / `resolveProvider` /
`clearBoxProviderRegistry`; and the package barrel invokes
`registerBuiltInBoxProviders()` as an import side effect
(`packages/worker-box-pool/src/index.ts:111-147`). A new provider edits all
four. The escape hatch for SDK-only clouds is worse still:
`ProviderDeps.e2bClient` / `ProviderDeps.modalTransport`
(`packages/worker-box-pool/src/types.ts:120-125`) force the leaf `types.ts`
module to import concrete provider files, and the pool never even populates
those fields (the ctor and `swapProvider` pass only `{ clock, logEvent }`,
`pool.ts:204-207, 432-435`).

A second critique was raised alongside this one: the `pending://` sentinel in
the claim flow encodes a temporal dependency between `claim()` and the later
host bind. That is a claim-flow concern, not an SDK concern - conflating the
two refactors would make neither independently shippable - so it is designed
separately in "2026-06-11-no-pending-sentinel-design.md" (two-phase slot
reservation). One finding from that analysis warrants a cross-reference here:
there is a verified latent hazard where the stall reconciler can finish a
pre-bind claim and persist the sentinel into `RetryEntry.workerHost`; the
sibling design fixes it structurally.

### Hard invariants any design must preserve

- Byte-identical behavior when `worker.box_pool` is absent or disabled.
- Exactly-once lease settlement; endpoint-close-before-lease-settle.
- `worker-box-pool` and `dispatch-coordinator` stay free of `@symphony/mcp`
  runtime deps.
- Retry affinity (prior `workerHost` preferred) keeps working.
- Capacity-blocked issues keep no-penalty re-eligibility semantics.
- Crash safety: ledger / hydrate / drain unchanged or strictly improved.
- Fail-loud startup with helpful config validation.

---

## 2. Chosen design - overview

**Provider SDK via instance registry + module-specifier loading.**
`worker.box_pool.provider` accepts either a built-in kind or a module
specifier (npm package name, `./relative` or `/absolute` path, optional
`#exportName`). The daemon dynamic-imports the module once at startup (and
on reload to a new specifier), validates it against a versioned SDK
contract, and registers it in an instance-scoped registry injected into the
pool. The module-global registry and its barrel import side effect are
deleted. Provider authors target a small, semver-stable SDK surface:
`BoxProviderModule { kind, sdkVersion, optionsSchema?, create(spec, deps) }`
where `spec` is a narrowed `ProviderSpec { kind, options }` (never the
churn-prone full `BoxPoolSettings`). A vitest-free conformance core plus a
`symphony box-pool verify` CLI gives third parties the same contract
guarantees as built-ins. The dispatch path is byte-untouched: the design's
correctness story rests precisely on the dispatch path not changing.

### 2.1 Component diagram (end state)

```
                          workflow.yml
   worker.box_pool.provider = "static-ssh"
                            | "@acme/symphony-box-provider"
                            | "./providers/acme.mjs#vm"
                              |
                              v
 +----------------------- @symphony/config -----------------------+
 | boxPoolRawSchema.provider: open string; shape refinement via   |
 | domain parseBoxProviderRef (built-in kind OR module specifier) |
 | providerOptions: open record (provider module validates)       |
 +------------------------------+---------------------------------+
                                | BoxPoolSettings (provider: string)
                                v
 +------------------------- apps/cli daemon ----------------------+
 | buildDispatchCoordinator(settings, env, { baseDir })   [async] |
 |   if (!boxPool?.enabled) return undefined   <- FIRST, no work  |
 |   registry = createBuiltInProviderRegistry()                   |
 |   await ensureProviderLoaded(provider, registry, {baseDir})    |
 |     built-in kind     -> no-op (already registered)            |
 |     module specifier  -> import() -> assertBoxProviderModule   |
 |                          -> registry.register(specifier, mod)  |
 |   logEvent: box_pool_provider_loaded {specifier, kind,         |
 |                                       sdkVersion, resolvedFrom}|
 |   createBoxPool(settings, {clock, logEvent, ledgerPath,        |
 |                            registry})                          |
 |   providerLoader closure ------------------+                   |
 +-------------------+------------------------|-------------------+
                     |                        |
                     v                        v
 +-- @symphony/worker-box-pool --+  +-- @symphony/dispatch-coordinator --+
 | BoxPoolImpl                   |  | reconcile(next): Promise<void>     |
 |  instantiateProvider(settings)|  |   if (next.enabled)                |
 |   = registry.resolve(provider)|  |     await providerLoader?.(provider)
 |   -> optionsSchema validate   |  |   pool.reconcile(next) (sync, txn) |
 |   -> module.create(spec, deps)|  +------------------------------------+
 |  (ctor + swapProvider only;   |
 |   NEVER on the acquire path)  |
 +---------------+---------------+
                 |
                 v
 +------------- provider modules (SDK consumers) -------------+
 | built-ins: fake, static-ssh, docker, fly,                  |
 |            e2b/modal (parameterized factories or           |
 |            fail-loud unconfigured placeholders)            |
 | third-party: default-exported BoxProviderModule            |
 |   { kind, sdkVersion, optionsSchema?, create }             |
 | conformance: verifyBoxProvider core (vitest-free)          |
 |   + runProviderConformanceSuite (vitest wrapper)           |
 |   + `symphony box-pool verify` CLI                         |
 +------------------------------------------------------------+
```

---

## 3. The design in detail

### 3.1 Provider reference grammar (domain)

`packages/domain/src/index.ts:87-92` today:

```ts
export const PROVIDER_KINDS = ["fake", "static-ssh", "docker", "fly", "e2b", "modal"] as const;
export type BoxPoolProvider = (typeof PROVIDER_KINDS)[number];
```

becomes:

- `BUILT_IN_PROVIDER_KINDS` (same tuple); `PROVIDER_KINDS` survives one
  release as a deprecated alias so `config/schemas.ts` compiles during
  migration.
- `export type BoxPoolProvider = BuiltInBoxProviderKind | (string & {});` -
  the open union admits any string while preserving IDE autocomplete for the
  built-ins. The closed union is what forces every new provider to touch
  domain, config, and the registry simultaneously. Nothing exhaustively
  switches on it (verified consumers: the registry map key,
  `BoxPoolSettings.provider`, `BoxProvider.kind`, `BoxPoolSnapshot.provider`,
  and the config enum), so the widening is compile-compatible everywhere.
- New pure helpers, dependency-light like the existing `isOneOf`:
  `isBuiltInBoxProviderKind(value)` and
  `parseBoxProviderRef(provider): BoxProviderRef`. Resolution rule: an exact
  built-in kind always wins (a published npm package named `docker` can never
  shadow the built-in); a `#name` suffix selects a named export; anything else
  is a module specifier. This helper is the SINGLE place the grammar lives -
  the config refinement and the daemon loader both call it, so the
  one-field-two-grammars overload has exactly one authority.

### 3.2 The SDK module contract (`worker-box-pool/src/sdk.ts`, new)

```
BOX_PROVIDER_SDK_VERSION = 1
ProviderSpec        { kind, options }                  // what create() receives
ProviderDeps        { clock, logEvent }                // slimmed; matches what the pool passes today
BoxProviderModule   { kind, sdkVersion, optionsSchema?, create(spec, deps): BoxProvider }
defineBoxProvider(module)                              // identity + shape assert (authoring sugar)
assertBoxProviderModule(value, source)                 // structural check + version handshake
```

- `create(spec, deps)` replaces `BoxProviderFactory` (`types.ts:128`). It
  receives `ProviderSpec { kind: string; options: Readonly<Record<string,
  unknown>> }` - `options` is `worker.box_pool.provider_options` verbatim -
  instead of the full `BoxPoolSettings`. Every built-in reads only
  `settings.providerOptions` (verified: `static-ssh.ts`, `docker.ts`,
  `fly.ts`, `e2b.ts`, `modal.ts`; `fake` reads none), so this narrowing is
  free and keeps the churn-prone settings type out of the semver-stable SDK
  surface.
- `ProviderDeps` is slimmed to `{ clock: ClockPort; logEvent }`. The
  `e2bClient` / `modalTransport` fields are deleted: the pool never populates
  them (it passes only `{ clock, logEvent }` at `pool.ts:204-207` and
  `:432-435`), and removing them also removes `types.ts`'s only imports of
  concrete provider files. SDK-only clouds use parameterized module factories
  instead (3.4).
- `BoxProvider`, `BoxDescriptor`, `ProvisionRequest`, `BoxHealth`,
  `ProviderCapabilities`, `TeardownReason`, `BoxOutcome`, and
  `POOL_OWNED_LABEL` (`types.ts`) are the SDK's stable type surface,
  unchanged. `BoxProvider.kind` widens with `BoxPoolProvider` automatically.
- `optionsSchema` is typed as `StandardSchemaV1<Record<string, unknown>>` - a
  ~30-line vendored interface type, so `worker-box-pool` gains no zod runtime
  dependency (its deps stay `domain` / `ports` / `ssh`). zod >= 3.24,
  valibot, and arktype all implement `~standard.validate`, so a
  provider-supplied zod schema works without instanceof / dual-package
  hazards. Validation failures surface as
  `box_pool_provider_options_invalid: <provider>: <issue paths>`. Because
  pool construction is synchronous, a `~standard.validate` that returns a
  Promise is rejected loudly with the same error class rather than awaited.
- Version handshake: `assertBoxProviderModule` rejects
  `sdkVersion !== BOX_PROVIDER_SDK_VERSION` with
  `box_pool_provider_sdk_mismatch: <specifier> targets SDK v<n>, daemon
  supports v1`. Major-only; additive fields never bump it. The handshake
  guards module SHAPE; behavioral conformance is the job of the conformance
  kit and verify CLI (3.7).

### 3.3 The registry becomes an instance (`registry.ts` rewritten)

Delete the module-level `Map`, `registerBoxProvider`, the free-function
`resolveProvider`, and `clearBoxProviderRegistry` (`registry.ts:11-46`).
Replace with:

- `createBoxProviderRegistry(initial?)` returning
  `BoxProviderRegistry { register, resolve, has, keys }` - a plain Map in a
  closure, keyed by the EXACT configured provider string (built-in kind or
  module specifier). No import side effects anywhere. Last write wins per
  key, so test stubbing stays a one-liner, scoped to the instance.
- `createBuiltInProviderRegistry()` in a new `src/builtins.ts`, absorbing the
  body of `registerBuiltInBoxProviders()` (`index.ts:111-143`): fake /
  static-ssh / docker / fly construct directly; e2b / modal keep fail-loud
  "requires an injected client/transport" construction errors whose text now
  points at the module-injection story instead of `registerBoxProvider`. The
  barrel's load-time `registerBuiltInBoxProviders()` call (`index.ts:147`) is
  deleted - importing the barrel mutates nothing.
- `static-ssh` gains an `optionsSchema` mirroring its `readSshHosts` check
  (`ssh_hosts | sshHosts` non-empty string array) so misconfiguration errors
  carry paths; docker / fly follow as backfill.

`CreateBoxPoolDeps` (`pool.ts:39-43`) gains
`registry?: BoxProviderRegistry`, defaulting permanently to
`createBuiltInProviderRegistry()`. Keeping the field optional (rather than
making it required at the end state) means every existing `createBoxPool`
call site and test stays valid forever, and the final breaking step shrinks
to just deleting the global functions.

`BoxPoolImpl`'s two `resolveProvider(...)` call sites - the ctor
(`pool.ts:204`) and `swapProvider` (`pool.ts:432`) - become a private
`instantiateProvider(settings)`:

1. `registry.resolve(settings.provider)` - a miss throws
   `box_pool_provider_unavailable: <provider> (registered: <keys>)`. The
   prefix is unchanged (the apps/cli wiring test asserts it), and the
   appended key list is a near-zero-cost operator-UX win.
2. Validate `settings.providerOptions` against `module.optionsSchema` when
   present (sync-only, as above).
3. `module.create({ kind: settings.provider, options:
   settings.providerOptions ?? {} }, { clock, logEvent })`.

Critically this preserves `swapProvider`'s transactional contract: all
throwing work (resolve + validate + create + `createLedger`) still happens
into locals BEFORE the commit point (`pool.ts:424-441`), so a rejected reload
mutates nothing. `originProvider` capture, `providerGeneration`, and recycle
routing are untouched; Node never unloads modules, so destroying a box on a
stale module-created origin provider after a swap remains safe.

### 3.4 Built-ins become ordinary SDK consumers

- Each built-in provider's constructor narrows from
  `(settings: BoxPoolSettings, deps, overrides?)` to
  `(options: Record<string, unknown>, deps, overrides?)` and is wrapped as a
  `BoxProviderModule` in `builtins.ts` (`fakeBoxProviderModule`,
  `staticSshBoxProviderModule`, ...). Built-ins thereby dogfood the exact
  surface a third party uses.
- e2b / modal become PARAMETERIZED module factories for embedders:
  `e2bBoxProviderModule(io: { client: E2BSandboxClient })` and
  `modalBoxProviderModule(io: { transport: ModalTransport })`. The default
  built-in registry contains unconfigured placeholders whose `create` throws
  the existing actionable `box_pool_provider_unavailable: e2b requires an
  injected client...` message (text updated to name the module path). A
  deployment alternatively ships its own e2b module whose `create` closes
  over a real client and configures it by specifier - which is what finally
  retires `ProviderDeps.e2bClient` / `modalTransport`.

### 3.5 The loader (`worker-box-pool/src/loader.ts`, new; executed by the daemon)

`loadBoxProviderModule(specifier, { baseDir, exportName })`:

- relative / absolute paths resolve against `baseDir` via `pathToFileURL` +
  `import()`; bare names resolve through the daemon's module graph (the
  operator installs the provider package next to symphony; `./path` and
  `file:` are the escape hatches). `baseDir` is `dirname(workflow.path)` -
  the most predictable anchor for operators.
- unwraps `mod.default` (including the transpiled-CJS `default.default`
  shape) or `mod[exportName]`, then `assertBoxProviderModule`.
- returns `{ module, resolvedFrom }` so the caller logs a structured
  `box_pool_provider_loaded { specifier, kind, sdkVersion, resolvedFrom }`
  audit event recording exactly which provider code is live.
- when a bare specifier fails to resolve AND is within a small edit distance
  of a built-in kind, the error appends a `did you mean "<builtin>"?` hint -
  the mitigation for the lost zod-enum typo detection.

`ensureProviderLoaded(provider, registry, { baseDir, logEvent })`: no-op when
`registry.has(provider)` (covers built-ins and already-loaded specifiers),
else load + `registry.register(specifier, module)`. Idempotent.

**Module pinning is an explicit, observable semantic.** Node's ESM cache
means a given specifier's code is loaded once per daemon lifetime: editing
the provider FILE and reloading the workflow does NOT pick up new code.
`ensureProviderLoaded` therefore emits a
`box_pool_provider_module_pinned { specifier }` event whenever a reload
re-encounters an already-loaded specifier, and the authoring docs state the
rule plainly: changing provider CODE requires a daemon restart; changing the
CONFIG to a different specifier hot-loads the new module. Cache-busting query
strings are rejected (unbounded module-graph growth, half-initialized module
hazards). This matches the built-ins' own semantics - their code is also
fixed for the daemon lifetime - so the model is coherent rather than
surprising.

**Trust:** dynamic import runs arbitrary code in the daemon process. This
does not widen the existing trust boundary - workflow YAML already executes
arbitrary shell via workspace hooks (`hooks.afterCreate` / `beforeRun`) - but
it is documented as operator-trust territory. Loads happen ONLY at startup
and reload, never on the acquire path, and the audit event records what was
loaded from where. Process-isolated providers are future work (section 10).

### 3.6 Config and daemon wiring

- `schemas.ts:153` `provider: z.enum(PROVIDER_KINDS).optional()` becomes
  `z.string().min(1).superRefine(...)` where the refinement accepts
  `isBuiltInBoxProviderKind(v)` or a well-formed module specifier per
  `parseBoxProviderRef`, and otherwise errors listing the built-in kinds plus
  the accepted specifier forms (npm name, `@scope/name`, `./rel`, `/abs`,
  optional `#export`). `provider_options` stays an open record at the config
  layer - config cannot know third-party schemas; the module's
  `optionsSchema` is the precise validator and runs at startup and on every
  reload, both fail-loud.
- `parse.ts` is untouched: the `provider ?? "fake"` default (`parse.ts:278`),
  the static-ssh `ssh_hosts` parse-time nicety (`parse.ts:322` - fires only
  when `provider === "static-ssh"`, so zero behavior change; the static-ssh
  `optionsSchema` is the authoritative duplicate), and the
  anti-double-capacity guard (`parse.ts:82-84`) all stay.
- `buildBoxPool` / `buildDispatchCoordinator` (`apps/cli/src/daemon.ts:74-86,
  107-131`) become async. The `if (!boxPoolSettings?.enabled) return
  undefined` guard stays the FIRST statement - the disabled path performs
  zero new work, no registry, no import. Enabled path: build
  `createBuiltInProviderRegistry()`, `await ensureProviderLoaded(provider,
  registry, { baseDir, logEvent })`, pass `registry` into `createBoxPool`,
  inject a `providerLoader` closure into the coordinator deps. `main.ts:120`
  awaits the builder. A load / handshake / options failure rejects before the
  runtime, hydrate, or any provision exists - the same fail-loud point as
  today's `box_pool_provider_unavailable`.
- `DispatchCoordinator.reconcile` (`coordinator.ts:180, 583-595`) becomes
  async: `if (next.enabled) await providerLoader?.(next.provider);
  pool.reconcile(next); currentSettings = next;`. Load-before-reconcile keeps
  `pool.reconcile -> swapProvider` fully synchronous and transactional, and
  the `next.enabled` gate mirrors the pool's existing disable path
  (`pool.ts:335-346`) which skips `swapProvider` entirely. The only
  production call site (`runtime/src/index.ts:742`) gains an `await` - it
  already sits inside the async transactional reload block whose catch keeps
  last-good settings and emits `workflow_reload_failed` (`runtime:750-755`),
  so a failed module import on reload degrades exactly like today's
  provider-unavailable reload. A module registered before a later reconcile
  failure is harmless: the registry is a catalog; unused entries are inert.
- `apps/cli/src/index.ts` re-exports swap `registerBoxProvider` /
  `resolveProvider` / `clearBoxProviderRegistry` for
  `createBoxProviderRegistry` / `createBuiltInProviderRegistry` /
  `loadBoxProviderModule` / `BOX_PROVIDER_SDK_VERSION` (+
  `BoxProviderModule`, `ProviderSpec` types).

### 3.7 Conformance: kit, subpath, and verify CLI

The existing `src/conformance.ts` imports vitest and is not in the package
`exports` map at all (provider tests reach into `../../src/conformance.js`).
It splits into:

- `conformance-core.ts`: a vitest-free
  `verifyBoxProvider(makeProvider, opts): Promise<ConformanceReport>` running
  pure async checks.
- `conformance.ts`: `runProviderConformanceSuite` kept as a thin vitest
  wrapper over the core, exported via a new package.json subpath
  `"./conformance"` so vitest never enters the runtime barrel
  (`peerDependencies: { vitest: ">=2" }`, optional).

The check list keeps the existing four cases (provision idempotent on
`boxId`; `list()` reflects provisioned-minus-destroyed; destroy idempotent +
phantom-tolerant; probe gates unreachable) and adds four that encode exactly
the assumptions hydrate re-adoption and the reaper destroy-unknown gate rest
on - closing the honor-system gap the shape-only `sdkVersion` handshake
leaves open:

1. Label round-trip (ephemeral providers): provision with
   `[POOL_OWNED_LABEL, "symphony.test=rt"]` -> `list()` descriptors carry the
   request labels.
2. Descriptor well-formedness: non-empty `workerHost` and `providerRef`,
   `boxId` echoes the request, finite `createdAtMs`; when
   `capabilities.sshAddressable`, `workerHost` must be a destination
   `ssh <workerHost>` accepts.
3. `usesLedger` replay-safety: destroy then re-provision the SAME `boxId`
   succeeds without duplicating inventory - the contract hydrate's ledger
   replay relies on.
4. Opt-in abort-signal responsiveness: provision with a pre-aborted `signal`
   settles promptly (the pool threads `req.signal` into provision).

A new CLI command, `symphony box-pool verify`, loads the workflow settings,
builds the configured provider through the registry + loader, runs
`verifyBoxProvider` against two scratch box ids, and prints a pass/fail
report. This is the offline-validation answer for the opened config enum: an
operator proves a third-party module (or their own deployment's options)
meets the contract BEFORE enabling the pool, without any test framework. The
six built-in provider test suites switch to the `./conformance` subpath and
run the same kit a third party runs.

### 3.8 Third-party authoring story

A provider author: `npm i -D @symphony/worker-box-pool`, writes one file
default-exporting `{ kind: "acme-vm", sdkVersion: 1, optionsSchema, create }`
(optionally via `defineBoxProvider` for the early shape assert), runs
`runProviderConformanceSuite` from the `./conformance` subpath (or
`verifyBoxProvider` under any harness), publishes. The operator writes
`provider: "@acme/symphony-box-provider"` and `provider_options: {...}`.
Zero edits to domain, config, the registry, or pool logic.

### 3.9 Startup sequence (happy path; new behavior in brackets)

```
operator      config           daemon                    loader / registry        pool
   | workflow.yml |               |                            |                   |
   |------------->| parse:        |                            |                   |
   |              | provider OK as|                            |                   |
   |              | built-in kind |                            |                   |
   |              | or specifier  |                            |                   |
   |              |-------------->| buildDispatchCoordinator   |                   |
   |              |               |  disabled? return undefined (no SDK work)      |
   |              |               | [registry = createBuiltInProviderRegistry()]   |
   |              |               | [await ensureProviderLoaded(provider, ...)]    |
   |              |               |    built-in: registry.has -> no-op             |
   |              |               |    specifier: import() -> assertBoxProviderModule
   |              |               |               -> registry.register             |
   |              |               | [log box_pool_provider_loaded]                 |
   |              |               |--createBoxPool({..., registry})--------------->|
   |              |               |    registry.resolve -> [optionsSchema check]   |
   |              |               |    -> module.create(spec, deps)                |
   |              |               |    (any throw => daemon exits non-zero,        |
   |              |               |     BEFORE runtime / hydrate / any provision)  |
   |              |               |--assertSlotsPerMachineGate, new SymphonyRuntime|
   |              |               |--await coordinator.hydrate() ----------------->|
   |              |               |    ledger seed + provider.list re-adopt        |
```

### 3.10 Dispatch path (unchanged)

The claim flow, `runClaim`'s acquire-after-claim, the coordinator's RunSlot /
collision / tunnel-ceiling / endpoint-after-bind machinery
(`coordinator.ts:400-572`), and the pool's acquire path (`pool.ts:252-292`:
spend gate -> synchronous `selectAndStamp` with affinity > warm idle >
under-capacity -> `grow` with write-ahead ledger row + provision +
`probeUntilReady` -> FIFO waiters) are byte-identical. Provider RESOLUTION
happens at pool construction and `swapProvider` only - never inside
`acquire`.

### 3.11 Reload sequence and failure paths

```
runtime.reloadWorkflowIfConfigured
   | workflow changed -> slots-per-machine gate check
   | await coordinator.reconcile(next)
   |     |- next.enabled?  await providerLoader(next.provider)
   |     |     known key      -> no-op (+ box_pool_provider_module_pinned
   |     |                       when the specifier was already loaded)
   |     |     new specifier  -> import() + handshake + register
   |     |     throw          -> reconcile REJECTS before pool.reconcile
   |     |- pool.reconcile(next)        (sync; swapProvider transactional:
   |     |     resolve + optionsSchema + create + ledger into locals
   |     |     BEFORE the commit point - a throw mutates nothing)
   | success -> commit runtime settings, workflow_reloaded
   | failure -> catch: workflow_reload_failed, last-good settings AND the
   |           live pool (with its paid boxes) provably untouched
```

Failure paths introduced by this design (all pre-dispatch):

- Startup: bad specifier / unresolvable module /
  `box_pool_provider_sdk_mismatch` / `box_pool_provider_module_invalid` /
  `box_pool_provider_options_invalid` -> `buildDispatchCoordinator` rejects
  -> daemon exits non-zero before hydrate or any provision.
- Reload to a broken specifier: degrades to `workflow_reload_failed` with
  last-good kept, identical to today's provider-unavailable reload.

Existing failure paths (no capacity -> single `worker_host_capacity`
dispatch_skipped + claim drop with no retry entry and no backoff; provision
failure -> `box_pool_provision_failed` + provisional ledger row delete ->
`no_capacity: provider_error`; endpoint-open failure after bind -> tunnel
reservation released, just-bound lease settled HEALTHY, `EndpointOpenError`
-> `box_pool_acquire_error` + claim drop) are byte-identical.

---

## 4. Dispatch latency for cold provisions

Nothing in this design sits on the dispatch path. Provider resolution happens
at pool construction and `swapProvider` only - never inside `acquire` (3.10).
The only new cost - one dynamic `import()` (typically milliseconds, worst
case ~100ms for a large package) - is paid once at daemon startup and once
per reload that introduces a new specifier, never on the acquire path.

Two SDK-relevant notes:

- A misbehaving third-party provider converts to the existing typed
  `acquire_timeout -> no-penalty release` path rather than an unbounded
  stall; the `timeoutMs` / `signal` obligations of `ProvisionRequest` are
  documented SDK contract and conformance-checked (opt-in abort case).
- The reaper's warm top-up toward `max(min, warm)` remains the lever that
  moves provisioning off the dispatch path; the provider docs recommend
  `warm >= 1` for slow backends.

---

## 5. Full API sketches

```ts
// ---------- @symphony/domain (src/index.ts) ----------
export const BUILT_IN_PROVIDER_KINDS = [
  "fake", "static-ssh", "docker", "fly", "e2b", "modal",
] as const;
/** @deprecated alias kept one release */
export const PROVIDER_KINDS = BUILT_IN_PROVIDER_KINDS;
export type BuiltInBoxProviderKind = (typeof BUILT_IN_PROVIDER_KINDS)[number];
/** Open union: built-ins keep autocomplete; any string is admissible. */
export type BoxPoolProvider = BuiltInBoxProviderKind | (string & {});
export type BoxProviderRef =
  | { type: "builtin"; kind: BuiltInBoxProviderKind }
  | { type: "module"; specifier: string; exportName: string | null };
export function isBuiltInBoxProviderKind(value: string): boolean;
/** Exact built-in always wins; '#name' selects a named export. The ONE grammar authority. */
export function parseBoxProviderRef(provider: string): BoxProviderRef;

// ---------- @symphony/worker-box-pool ----------
// src/sdk.ts (new)
export const BOX_PROVIDER_SDK_VERSION = 1;
/** Vendored Standard Schema type (~30 lines) - no zod runtime dep;
 *  zod>=3.24 / valibot / arktype satisfy it. Async validate is rejected loudly. */
export interface StandardSchemaV1<Out> {
  readonly "~standard": {
    readonly version: 1;
    validate(value: unknown):
      | { value: Out }
      | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }> }
      | Promise<never>;
  };
}
/** What create() receives instead of the full (host-owned, churn-prone) BoxPoolSettings. */
export interface ProviderSpec {
  readonly kind: string;
  readonly options: Readonly<Record<string, unknown>>; // worker.box_pool.provider_options verbatim
}
/** Slimmed: e2bClient/modalTransport removed (the pool never populated them). */
export interface ProviderDeps {
  clock: ClockPort;
  logEvent: (event: Record<string, unknown>) => void;
}
export interface BoxProviderModule {
  readonly kind: string;        // diagnostics; resolution keys on the configured string
  readonly sdkVersion: number;  // must equal BOX_PROVIDER_SDK_VERSION
  readonly optionsSchema?: StandardSchemaV1<Record<string, unknown>>;
  create(spec: ProviderSpec, deps: ProviderDeps): BoxProvider;
}
/** Identity + runtime shape assert (authoring sugar over assertBoxProviderModule). */
export function defineBoxProvider(module: BoxProviderModule): BoxProviderModule;
export function assertBoxProviderModule(value: unknown, source: string): BoxProviderModule;
// throws: box_pool_provider_module_invalid | box_pool_provider_sdk_mismatch

// src/registry.ts (rewritten - instance, no module state)
export interface BoxProviderRegistry {
  register(key: string, module: BoxProviderModule): void; // key = built-in kind OR specifier
  resolve(key: string): BoxProviderModule | undefined;
  has(key: string): boolean;
  keys(): readonly string[];
}
export function createBoxProviderRegistry(
  initial?: Record<string, BoxProviderModule>,
): BoxProviderRegistry;

// src/builtins.ts (new; absorbs registerBuiltInBoxProviders verbatim)
export function createBuiltInProviderRegistry(): BoxProviderRegistry;
export const fakeBoxProviderModule: BoxProviderModule;
export const staticSshBoxProviderModule: BoxProviderModule; // carries optionsSchema
export const dockerBoxProviderModule: BoxProviderModule;
export const flyBoxProviderModule: BoxProviderModule;
// Parameterized cloud modules for embedders (transport injected by the deployment):
export function e2bBoxProviderModule(io: { client: E2BSandboxClient }): BoxProviderModule;
export function modalBoxProviderModule(io: { transport: ModalTransport }): BoxProviderModule;

// src/loader.ts (new)
export interface LoadedBoxProviderModule { module: BoxProviderModule; resolvedFrom: string; }
export function loadBoxProviderModule(
  specifier: string,
  opts: { baseDir: string; exportName?: string | null },
): Promise<LoadedBoxProviderModule>;
export function ensureProviderLoaded(
  provider: string,
  registry: BoxProviderRegistry,
  opts: { baseDir: string; logEvent?: (event: Record<string, unknown>) => void },
): Promise<void>; // no-op when registry.has(provider); emits box_pool_provider_module_pinned on re-encounter

// src/pool.ts
export interface CreateBoxPoolDeps {
  clock: ClockPort;
  logEvent: (event: Record<string, unknown>) => void;
  ledgerPath?: string;
  /** PERMANENTLY optional; defaults to createBuiltInProviderRegistry(). */
  registry?: BoxProviderRegistry;
}
// internal: instantiateProvider(settings) =
//   registry.resolve -> optionsSchema validate -> module.create(spec, deps)
// miss throws `box_pool_provider_unavailable: <provider> (registered: <keys>)`
// (same prefix as today, so the wiring test's assertion keeps passing)

// src/conformance-core.ts (new, vitest-free)
export interface ConformanceReport {
  passed: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}
export function verifyBoxProvider(
  makeProvider: () => BoxProvider | Promise<BoxProvider>,
  opts: ConformanceSuiteOptions,
): Promise<ConformanceReport>;

// src/conformance.ts -> exported via package.json subpath "./conformance"
export interface ConformanceSuiteOptions {
  suiteName?: string;
  boxIds: readonly [string, string];
  provisionTimeoutMs?: number;
  probeTimeoutMs?: number;
  destroyTimeoutMs?: number;
  makeProvisionRequest?: (boxId: string) => ProvisionRequest;
  makeUnreachable?: () => { provider: BoxProvider; boxId: string };
  /** Opt-in: assert provision(signal: aborted) settles promptly. */
  supportsAbortSignal?: boolean;
}
export function runProviderConformanceSuite(
  makeProvider: () => BoxProvider | Promise<BoxProvider>,
  opts: ConformanceSuiteOptions,
): void; // vitest wrapper over verifyBoxProvider

// package.json:
// "exports": { ".": "./dist/index.js", "./conformance": "./dist/conformance.js" }
// "peerDependencies": { "vitest": ">=2" } (optional)

// ---------- @symphony/dispatch-coordinator (src/coordinator.ts) ----------
export interface DispatchCoordinator {
  // ...unchanged...
  reconcile(next: BoxPoolSettings): Promise<void>; // was void; awaits providerLoader first
}
export interface CreateDispatchCoordinatorDeps {
  pool: BoxPool;
  mcpEndpointManager: McpEndpointManager;
  settings: BoxPoolSettings;
  logEvent?: (event: Record<string, unknown>) => void;
  providerLoader?: (provider: string) => Promise<void>; // daemon-injected; absent => built-ins only
}

// ---------- apps/cli/src/daemon.ts ----------
export async function buildBoxPool(
  settings: Settings, env?: NodeJS.ProcessEnv, opts?: { baseDir?: string },
): Promise<BoxPool | undefined>;
export async function buildDispatchCoordinator(
  settings: Settings, env?: NodeJS.ProcessEnv, opts?: { baseDir?: string },
): Promise<DispatchCoordinator | undefined>; // baseDir = dirname(workflow.path)
// new CLI command: `symphony box-pool verify` -> builds the configured provider
// via registry + loader, runs verifyBoxProvider, prints the ConformanceReport.

// ---------- config (packages/config/src/schemas.ts) ----------
// provider: z.string().min(1).superRefine(acceptBuiltInOrModuleSpecifier).optional()
//   (refinement delegates to domain parseBoxProviderRef; error lists built-ins + forms)
// providerOptions: unchanged open record; precise validation is the module's optionsSchema

// ---------- a third party's entire package ----------
// package: @acme/symphony-box-provider (deps: @symphony/worker-box-pool only)
import {
  BOX_PROVIDER_SDK_VERSION, defineBoxProvider,
  type BoxProvider, type ProviderDeps, type ProviderSpec,
} from "@symphony/worker-box-pool";
export default defineBoxProvider({
  kind: "acme-vm",
  sdkVersion: BOX_PROVIDER_SDK_VERSION,
  optionsSchema: z.object({ fleet_id: z.string() }).loose(), // any Standard Schema
  create: (spec: ProviderSpec, deps: ProviderDeps): BoxProvider =>
    new AcmeVmProvider(spec.options, deps),
});
// their test file:
//   import { runProviderConformanceSuite } from "@symphony/worker-box-pool/conformance";
// operator config:
//   provider: "@acme/symphony-box-provider"     (or "./providers/acme.mjs#vm")
//   provider_options: { fleet_id: "fleet-7" }
```

---

## 6. Migration plan (ordered; every step lands green)

Run the repo's full check suite (lint, build, types, tests) after each step.

**Step 1 - Domain vocabulary.** Rename `PROVIDER_KINDS` ->
`BUILT_IN_PROVIDER_KINDS` (keep `PROVIDER_KINDS` as a deprecated alias so
`config/schemas.ts` compiles unchanged); widen `BoxPoolProvider` to
`BuiltInBoxProviderKind | (string & {})`; add `isBuiltInBoxProviderKind`,
`parseBoxProviderRef`, `BoxProviderRef` with unit tests in
`packages/domain/test/domain.test.ts`. The widening is compile-compatible at
every consumer (registry key, `BoxPoolSettings.provider`,
`BoxProvider.kind`, `BoxPoolSnapshot.provider`); no behavior change.

**Step 2 - SDK surface (additive).** Add `src/sdk.ts`:
`BOX_PROVIDER_SDK_VERSION`, vendored `StandardSchemaV1`, `ProviderSpec`,
slimmed SDK `ProviderDeps`, `BoxProviderModule`, `assertBoxProviderModule`,
`defineBoxProvider`. Nothing consumes it yet; unit tests cover the shape
assert and version handshake.

**Step 3 - Built-ins become SDK consumers.** Narrow the five real provider
constructors to `(options, deps, overrides?)` (verified: every built-in
reads only `settings.providerOptions`); add `src/builtins.ts` with the
per-provider modules, `createBuiltInProviderRegistry()`, parameterized
`e2bBoxProviderModule({client})` / `modalBoxProviderModule({transport})`,
and fail-loud unconfigured e2b/modal placeholders preserving today's
actionable messages (text re-pointed at the module story); give static-ssh
an `optionsSchema` mirroring `readSshHosts`. Keep the module-global
`registerBuiltInBoxProviders` working by delegating its factories to the new
modules, so every existing global-registry test passes unmodified. Update
provider unit-test constructor calls.

**Step 4 - Pool consumes the registry.** `CreateBoxPoolDeps` gains optional
`registry?`; `BoxPoolImpl` ctor and `swapProvider` route through a private
`instantiateProvider` that resolves via `deps.registry` when present and
falls back to the module-global `resolveProvider` when absent
(byte-identical for every existing caller). `instantiateProvider` validates
`providerOptions` against `module.optionsSchema` before `create` (rejecting
async schemas loudly) and appends the registered-keys list to
`box_pool_provider_unavailable` (prefix preserved). Add a pool test asserting
a rejected reconcile with invalid options mutates nothing (extends the
existing swapProvider transactional test).

**Step 5 - Loader.** Add `src/loader.ts` (`loadBoxProviderModule` with
`pathToFileURL` / `import()`, default + `#named` export unwrap including CJS
`default.default`, `assertBoxProviderModule`, did-you-mean hint;
`ensureProviderLoaded` with the pinned-module event). Unit tests against
`.mjs` fixtures (valid module, wrong sdkVersion, missing create, named
export, CJS shape). Nothing in production calls it yet.

**Step 6 - Config opens.** `schemas.ts:153` `z.enum(PROVIDER_KINDS)` ->
`z.string().min(1)` + superRefine via domain's `parseBoxProviderRef` /
`isBuiltInBoxProviderKind`, with an error listing built-ins and specifier
forms; `parse.ts` untouched (default `fake`, static-ssh ssh_hosts nicety,
anti-double-capacity guard). Update config tests: the closed-enum rejection
case becomes a malformed-specifier rejection case plus accepted
`@scope/pkg` and `./rel.mjs#name` cases.

**Step 7 - Daemon async wiring.** `buildBoxPool` / `buildDispatchCoordinator`
become async with `opts.baseDir = dirname(workflow.path)` threaded from
`runDaemon`; construct `createBuiltInProviderRegistry()`, `await
ensureProviderLoaded(...)`, pass `registry` into `createBoxPool`, inject the
`providerLoader` closure into coordinator deps (optional, unused until step 8);
`main.ts:120` awaits. Update `apps/cli/test/box-pool-wiring.test.ts` and the
root box-pool e2e tests to await the builders; add a wiring test loading a
fixture module provider end-to-end asserting `box_pool_provider_loaded` and
fail-loud on sdk mismatch.

**Step 8 - Async reconcile for hot reload.** `DispatchCoordinator.reconcile` ->
`Promise<void>`; implementation awaits `providerLoader?.(next.provider)`
when `next.enabled`, before `pool.reconcile`; `runtime/src/index.ts:742`
gains `await` (sole production call site, already inside the transactional
reload block). Tests: reload from static-ssh to a fixture module specifier
hot-swaps via `swapProvider` (origin-provider destroy still routed
correctly); a failed import on reload emits `workflow_reload_failed` and
keeps last-good; a reload re-encountering a loaded specifier emits
`box_pool_provider_module_pinned`. Every test stub of the
`DispatchCoordinator` interface updates its `reconcile` signature (the type
checker polices this).

**Step 9 - Delete the module-global (the one breaking step).** Remove
`registerBoxProvider`, the free-function `resolveProvider`,
`clearBoxProviderRegistry`, `registerBuiltInBoxProviders` + the barrel's
load-time call, the `BoxProviderFactory` type, and
`ProviderDeps.e2bClient` / `modalTransport` (plus `types.ts`'s type-only
imports of `providers/e2b.js` / `providers/modal.js`). The
`CreateBoxPoolDeps.registry` default becomes `createBuiltInProviderRegistry()`
permanently (the field stays optional, so no call-site churn). Migrate every
global-registry test (`packages/worker-box-pool/test/{index,pool,pool-props,
registry,reaper}.test.ts`, `test/providers/static-ssh.test.ts`,
`apps/cli/test/box-pool-wiring.test.ts`, `test/box-pool-live-ssh.test.ts`,
`test/box-pool-multitenant.test.ts`) to per-test instance registries,
deleting the `clearBoxProviderRegistry` isolation dance outright. Swap the
`apps/cli/src/index.ts` re-exports. This is the step the dual resolution
path dies in; it must not slip.

**Step 10 - Conformance, packaging, docs, e2e.** Split `conformance.ts` into the
vitest-free `verifyBoxProvider` core + the vitest wrapper; add the four new
cases (label round-trip, descriptor well-formedness, usesLedger
replay-safety, opt-in abort-signal) and enable them across all built-in
suites (a built-in that fails one is a real bug surfaced by the kit; budget
for driver fixes); add the package.json `"./conformance"` subpath + optional
vitest peer dep and point provider tests at it; add `symphony box-pool
verify` to apps/cli; write the provider-authoring section in the package
README / CONTRIBUTING (module contract, ProviderSpec, conformance
obligations - boxId idempotency, destroy tolerance, list-as-truth,
POOL_OWNED_LABEL surfacing, timeoutMs/signal - trust note, baseDir
resolution, module-pinning semantics); add a root e2e test proving an
out-of-tree fixture provider drives acquire -> run -> settle with zero core
edits.

---

## 7. What gets deleted

- `packages/worker-box-pool/src/registry.ts`: the module-level
  `const registry = new Map(...)`, `registerBoxProvider`, free-function
  `resolveProvider`, `clearBoxProviderRegistry`.
- `packages/worker-box-pool/src/index.ts`: `registerBuiltInBoxProviders()`
  and its load-time invocation (the import side effect), plus the barrel
  re-exports of the three global functions.
- `packages/worker-box-pool/src/types.ts`: `ProviderDeps.e2bClient`,
  `ProviderDeps.modalTransport`, the type-only imports of
  `./providers/e2b.js` / `./providers/modal.js`, and `BoxProviderFactory`.
- `packages/config/src/schemas.ts`: `z.enum(PROVIDER_KINDS)` (replaced by the
  refined open string).
- `apps/cli/src/index.ts`: the `registerBoxProvider` / `resolveProvider` /
  `clearBoxProviderRegistry` re-exports.
- Every `clearBoxProviderRegistry()` test-isolation call across the suites -
  the cross-test mutable-global hazard class is removed outright.
- `packages/domain`: the bare `PROVIDER_KINDS` name (one release after the
  deprecated-alias window).

---

## 8. How each hard invariant is preserved

**Byte-identical when `worker.box_pool` is absent/disabled.**
`buildBoxPool` / `buildDispatchCoordinator` keep
`if (!boxPoolSettings?.enabled) return undefined` as the FIRST statement -
the disabled path performs zero new work (no registry, no import), the
runtime gets `coordinator === undefined`, and `Orchestrator.claim` takes the
static/local branch exactly as today. Config parse defaults are untouched.
Deleting the barrel side effect changes nothing observable for a consumer
that never constructs a pool.

**Exactly-once lease settlement; endpoint-close-before-lease-settle.**
Not on any edited path. The settle chokepoints - the lease's
leaseId/settled/DESTROYED guards, the coordinator's single `settle` closure
(endpoint release first, lease settle + deregister in `finally`,
`coordinator.ts:245-263`), `runClaim`'s `finally` (`runtime:675-696`), and
the recycle ordering inside the per-box mutex - are unmodified. The design
sits entirely on the provider-construction seam, which runs before any lease
exists.

**No `@symphony/mcp` runtime deps in worker-box-pool / dispatch-coordinator.**
`worker-box-pool`'s deps stay `domain` / `ports` / `ssh`: `sdk.ts` vendors
the Standard Schema TYPE (no zod), `loader.ts` uses only `node:url` /
`node:path` + dynamic `import()`. `dispatch-coordinator`'s `@symphony/mcp`
import remains type-only; the new `providerLoader` is an injected
`(provider) => Promise<void>` closure composed by the daemon - no new
runtime edge from either package.

**Retry affinity.** The design does not edit the chain:
`RetryEntry.workerHost` -> claim's `affinityHost` (`orchestrator:176`) ->
`runClaim`'s `affinityKey` (`runtime:543`) -> `AcquireRequest.affinityKey` ->
the pool's affinity-first selection (`pool.ts:879-881`).

**Capacity-blocked no-penalty re-eligibility.** Untouched - every typed
`no_capacity` reason maps to the single `worker_host_capacity` event + claim
drop with no retry entry and no backoff. `eligibleIssues`' `canAcquire`
gating and `rescheduleRetryAfterDispatchBlock`'s backoff-for-due-retries
behavior are untouched.

**Crash safety: ledger / hydrate / drain unchanged or strictly improved.**
The write-ahead ledger (provisional row before provision, correlate after,
delete on reject), hydrate's bounded `list()` retry with fail-loud for
ledger-backed providers, survivor re-adoption, and drain's epoch-guarded
force-destroy are untouched. Strictly improved at the margins: (a) module
load + handshake + optionsSchema validation complete BEFORE `createBoxPool`,
so hydrate can never run against a provider that was never constructible;
(b) reload import failures throw BEFORE `pool.reconcile`, extending
swapProvider's nothing-mutated-on-throw guarantee to module loading;
(c) instance registries delete the `clearBoxProviderRegistry` cross-test
mutable-global hazard; (d) the new conformance cases test exactly the
assumptions hydrate/reaper rest on, for third parties and built-ins alike.

**Fail-loud startup + helpful config validation.** An unknown provider
string still throws the identical `box_pool_provider_unavailable: <provider>`
prefix at construction, now listing registered keys. The module path adds
typed `box_pool_provider_sdk_mismatch` / `box_pool_provider_module_invalid`
/ `box_pool_provider_options_invalid`, all raised in
`buildDispatchCoordinator` before the runtime exists. Config keeps a real
refinement (specifier shape + built-in list in the message) rather than
degenerating to a bare string; precise per-provider option validation moves
to where the knowledge lives - the provider module - and runs at startup AND
reload, both transactional. `symphony box-pool verify` restores an offline
check stronger than the zod enum ever was.

**Conformance guarantees of built-ins.** Built-in factories move verbatim
into `createBuiltInProviderRegistry` (same constructors, same e2b/modal
fail-loud construction errors); their suites keep running and gain the four
new cases. Third parties get the same suite via the `./conformance` subpath
(or the vitest-free core) without vitest entering the production import
graph.

---

## 9. Risks and mitigations

- **Weaker config-time typo detection.** A misspelled built-in
  (`static-shh`) now passes zod as a plausible npm name and fails at daemon
  startup instead of config parse. Mitigations: still fail-loud before any
  dispatch or provision; the loader error lists the built-in kinds and adds
  a did-you-mean hint for near-miss specifiers; `symphony box-pool verify`
  provides a stronger offline check than the enum ever did. Residual risk:
  the failure arrives one stage later for purely-offline config linting.
- **Dynamic import executes arbitrary code in the daemon process.**
  Equivalent to the trust already granted to workflow hooks, but documented
  explicitly as an operator-trust boundary; the `box_pool_provider_loaded`
  audit event and the load-only-at-startup/reload discipline are
  mitigations, not isolation. Process-isolated providers are future work.
- **ESM/CJS interop and module resolution surprises.** Bare specifiers
  resolve through the daemon's module graph (pnpm strict `node_modules` can
  hide a provider installed elsewhere) and transpiled modules ship
  `default.default`. Mitigated by the loader's unwrap logic, fixture tests
  for both shapes, and the documented `./relative` / `file:` escape hatch
  anchored at `dirname(workflow.path)`. This is the most likely support
  burden; the authoring docs lead with the path-based form.
- **Module pinning across reloads.** An operator who edits a provider file
  and reloads gets old code. Made explicit and observable: the
  `box_pool_provider_module_pinned` event fires on every reload that
  re-encounters a loaded specifier, and the docs state the
  restart-to-pick-up-code rule. Cache-busting is deliberately rejected.
- **Async-ification ripple + dual resolution path during migration.** The
  builder/reconcile signature changes touch many tests (steps 7-9), and
  steps 4-8 keep both the global fallback and the instance registry alive.
  The bridge MUST die in step 9 or it becomes a permanent footgun; step 9
  exists as a single dedicated step for exactly this reason.
- **`sdkVersion` is shape-only.** A module that passes the handshake but
  violates provision idempotency or `list()` labeling breaks hydrate/reaper
  invariants at runtime. Mitigations: the conformance kit + `verify` CLI
  encode those exact obligations; the docs state that `list()` MUST surface
  `POOL_OWNED_LABEL` and provision MUST be boxId-idempotent; the pool's
  defensive guards (ownership gate, `probeUntilReady`) remain the backstop.
- **Standard Schema edge cases.** Providers on validators that cannot
  produce a Standard Schema simply omit `optionsSchema` (they keep
  fail-loud `create` throws instead); a `~standard.validate` returning a
  Promise is rejected loudly at construction rather than awaited (pool
  construction is synchronous and must never deadlock `swapProvider`).
- **Registry keyed on the raw configured string.** Two specifiers resolving
  to the same module (`./p.mjs` vs `/abs/p.mjs`) register twice - harmless
  for correctness (`providerConstructionChanged` treats it as a provider
  change; `originProvider` routing destroys each box on the backend that
  created it) but a cosmetic config rewrite recycles the warm pool, costing
  a re-provision cycle. Documented; specifier normalization is an open
  question.

---

## 10. Rejected alternatives

**A separate `provider_modules` config list with kind-keyed registration.**
In this shape the operator lists module specifiers in
`worker.box_pool.provider_modules`, the daemon imports them all, and
`provider:` names a kind that one of them registered. It cleanly separates
"which kind" from "where the code lives" and avoids overloading one field
with two grammars. Rejected because it is strictly more moving parts for the
same outcome: a second config field threaded through schemas/aliases/parse
and `BoxPoolSettings`, a registry captured at pool construction that makes
adding a module NOT hot-reloadable (an operator surprise the single-field
design avoids - a new specifier loads on reload), no version handshake as
proposed, and a cross-referencing failure mode (a `provider:` kind that no
listed module registers) that the single-field grammar makes
unrepresentable. Its genuinely good parts - `ProviderSpec` narrowing, the
slimmed `ProviderDeps`, parameterized e2b/modal factories, the
kind-enumerating error, and the four conformance cases - are adopted here.

**Exec-template and stdio-bridge providers as the primary extension
mechanism.** Operator-supplied shell templates (`provision` / `destroy` /
`list` as commands with a small JSON stdout contract) and an NDJSON child
process bridge give the best operator debuggability (every op is a
replayable argv) and, for the bridge, real crash containment - and the
crash-safety analysis holds because the write-ahead ledger never crosses the
process boundary. Rejected as the PRIMARY mechanism because it is two new
security-sensitive runtimes in one program: shell substitution of
tracker-controlled `issue.labels` into `bash -lc` is a command-injection
surface whose correctness rests entirely on perfect escaping, the `{label}`
template lint cannot verify a list filter is semantically correct (a wrong
filter lets the reaper destroy foreign machines), and the stdio protocol is
a versioned public wire contract with respawn/backoff lifecycle. Deferred,
not dismissed: once the instance registry and SDK land, an exec or stdio
provider ships as an ordinary provider module with zero core edits, and the
`verify` CLI this design adds is exactly the guard such a provider needs.

**Keeping the module-global registry with embedder-only registration.**
The minimal refactor - built-ins registered explicitly at daemon wiring,
third parties register by embedding or forking the daemon. Highest trust
posture and smallest diff, but it is not a user-facing extension mechanism:
"write TypeScript and rebuild the daemon" fails the direction outright, and
the mutable process-global keeps the cross-test leakage and the
import-side-effect coupling this design exists to delete.

**Making `sshAddressable` load-bearing in `checkSlotsPerMachineGate` now.**
Feeding the resolved provider's `sshAddressable` capability into the
co-residence gate is a coherent hardening idea, but as proposed it was
incorrect: the coordinator's `capabilities` is a const captured once at
construction (`coordinator.ts:395`), so the runtime reload guard would
consult a stale capability after a provider swap; and it forced flipping
`FakeBoxProvider`'s pinned `sshAddressable: false` purely to keep existing
co-residence tests green, making a test double's capability a production
gate input. Deferred behind a live-getter redesign of
`DispatchCoordinator.capabilities` (open question); the conformance kit's
descriptor well-formedness case meanwhile asserts the ssh-consumable
`workerHost` contract directly.

**Process-isolated provider plugins in v1.** `BoxProvider`'s five-method
surface is already RPC-shaped, and isolation would genuinely improve the
trust story for dynamic loading. Rejected for v1 because shipping a wire
protocol, child lifecycle (respawn, backoff, in-flight rejection), and
version negotiation roughly triples the scope while the in-process module
SDK does not preclude it: a future stdio bridge is just another provider
module on this same seam.

---

## 11. Open questions

1. **Specifier normalization.** Should the loader resolve specifiers to a
   canonical file URL and key the registry (and
   `providerConstructionChanged`) on that, so a cosmetic config rewrite does
   not recycle the warm pool? Costs: resolution differences between bare and
   path specifiers make canonicalization non-trivial.
2. **Offline validation entry point.** Should a future
   `symphony config validate` subsume `box-pool verify`'s load + handshake +
   optionsSchema stages (without provisioning scratch boxes) so CI can lint
   workflows that reference third-party providers?
3. **Live coordinator capabilities.** Converting
   `DispatchCoordinator.capabilities` from a captured const to a live getter
   would unblock provider-capability-aware gates (e.g. `sshAddressable` for
   `slotsPerMachine > 1`). Worth doing when the first capability consumer
   arrives.
4. **Conformance enforcement level.** `verify` is advisory. Should the
   daemon offer an opt-in paranoid mode that runs the non-destructive subset
   of `verifyBoxProvider` against a freshly constructed provider at startup
   before hydrate?
5. **Exec/stdio provider modules.** Which of the deferred bring-your-own-CLI
   (exec template) and any-language bridge (stdio) providers to ship first as
   out-of-tree modules on this seam, and whether either belongs in-tree once
   hardened.
6. **Deprecated alias window.** How long `PROVIDER_KINDS` (the alias) and
   the step 4-8 global-registry fallback shims live before step 9 lands; the
   intent is one release, enforced by the migration ordering.
