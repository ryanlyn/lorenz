# Async Robustness Audit

Infractions ranked by importance.

**Relevant config context:**
- `tsconfig.base.json`: `strict: true` (enables `useUnknownInCatchVariables`), `target: "ES2023"`
- `eslint.config.js`: `recommendedTypeChecked` (includes `no-floating-promises`, `no-misused-promises`),
  `return-await: "in-try-catch"`, `promise-function-async`
- **Test files have `disableTypeChecked`** — type-aware rules like `no-floating-promises` do NOT run in tests

## 1. setTimeout-based waits in tests (flake source — HIGH)

Real timing-dependent tests that will produce flakes under load.

No lint or config catches this — `disableTypeChecked` on test files means even if a rule existed,
it wouldn't fire. This is a discipline/review concern only.

| File | Line | Pattern |
|------|------|---------|
| `packages/agent-runner/test/agent-runner.test.ts` | 126 | `await new Promise(resolve => setTimeout(resolve, 5000))` — simulates long turn |
| `packages/agent-runner/test/agent-runner.test.ts` | 132 | `setTimeout(() => ac.abort(), 20)` — race with 20ms window |
| `packages/runtime/test/runtime.test.ts` | 535 | `setTimeout(() => controls.get(1)?.resolve(…), 20)` |
| `packages/runtime/test/runtime.test.ts` | 615, 647, 945 | `await new Promise(resolve => setTimeout(resolve, 20))` |
| `packages/log-file/test/log-file.test.ts` | 71, 74 | `await new Promise(resolve => setTimeout(resolve, 20))` |
| `packages/acp/test/acp-executor.test.ts` | 416 | `await new Promise(resolve => setTimeout(resolve, 10))` |
| `test/live-ssh.test.ts` | 472 | `await new Promise(resolve => setTimeout(resolve, 1_000))` |
| `packages/server/test/http-server.test.ts` | 372 | `setTimeout(() => reject(...), remaining)` inside Promise.race |

Fix: `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()`, or controlled promises.

## 2. Fire-and-forget promises (void) without error handling (MEDIUM-HIGH)

These pass lint because `no-floating-promises` accepts the `void` operator as explicit intent.
The lint is working as designed — the question is whether silent failure is acceptable.

| File | Line | Pattern |
|------|------|---------|
| `packages/runtime/src/index.ts` | 742 | `void this.appendLogEvent(…)` — if logging fails, error vanishes silently |
| `packages/codex/src/executor.ts` | 315 | `void match(parsed.data)…` — entire message dispatch is fire-and-forget |
| `packages/codex/src/executor.ts` | 342 | `void this.handleDynamicToolCall(session, message)` — tool call errors vanish |
| `packages/agent-runner/src/index.ts` | 222 | `void session.stop()` — stop failure is invisible |
| `packages/acp/src/index.ts` | 155 | `void session.connection.cancel(…)` — cancel failure is invisible |

The `void` satisfies the linter but most of these can fail in ways that should at minimum be logged.
No lint will catch this — it's an architectural decision about error visibility.

## 3. `.catch(() => null/undefined/"")` — errors swallowed silently (MEDIUM)

In production code this would be flagged by `no-floating-promises`, but these are all in test files
where `disableTypeChecked` means no type-aware lint runs.

| File | Line | Pattern |
|------|------|---------|
| `test/live-ssh.test.ts` | 90 | `.catch(() => null)` |
| `test/live-ssh.test.ts` | 165, 483 | `.catch(() => undefined)` |
| `test/live-ssh.test.ts` | 262, 277 | `.catch(() => "")` |
| `test/live-ssh.test.ts` | 469 | `.catch(() => null)` |
| `packages/server/src/index.ts` | 297 | `.catch(() => stream.abort())` — at least acts, but hides the error |

In tests this is arguably acceptable for cleanup, but line 90 silences a worker setup failure
that could mask real test breakage.

## 4. Promise.race for timeouts instead of AbortSignal.timeout (MEDIUM)

No lint catches this. `AbortSignal.timeout` is available at ES2023 target but is a runtime API
(Node 17.3+), not a language feature — TS won't suggest it.

| File | Line | Issue |
|------|------|-------|
| `packages/child-process/src/index.ts` | 10 | `Promise.race([promise, new Promise(reject => setTimeout(…))])` — classic timeout pattern that doesn't cancel the underlying work |
| `packages/server/test/http-server.test.ts` | 369 | `Promise.race([…, setTimeout reject])` |
| `packages/agent-runner/src/index.ts` | 227 | `Promise.race([executor.runTurn(…), abortPromise])` — this one actually has an AbortController, so it's better, but the "loser" still runs |

The `child-process/withTimeout` is the most concerning — the underlying promise continues running after the timeout rejects.

## 5. Mutable state shared across awaits (LOW-MEDIUM)

No lint catches this. `no-floating-promises` ensures the promises are acknowledged but doesn't
reason about shared mutable state.

| File | Line | Issue |
|------|------|-------|
| `packages/codex/src/executor.ts` | 238 | `timedOut` flag set by setTimeout, read in `.catch()` — classic mutable-state-across-async pattern, though contained within one function |
| `packages/runtime/src/index.ts` | 722-724 | `this.pollInProgress` guard + `this.pollOnce().catch(…)` — two callers (line 724, 793) fire `pollOnce()` without awaiting, relying on the `pollInProgress` flag to coalesce. If the flag is stale, double-poll is possible. |

## 6. Unsafe type assertions in catch blocks (COSMETIC)

`strict: true` enables `useUnknownInCatchVariables`, so catch variables are `unknown` — the `as`
cast is required to access `.code`. But since all usages are followed by strict equality checks
(`=== "ENOENT"`), a non-ErrnoException just evaluates `.code` as `undefined` and falls through.
Runtime-safe. No lint currently configured catches this (`no-unsafe-type-assertion` is not enabled
and would be extremely noisy if it were).

| File | Line | Pattern |
|------|------|---------|
| `packages/log-file/src/index.ts` | 205 | `(error as NodeJS.ErrnoException).code` |
| `packages/ssh/src/index.ts` | 76 | `(error as NodeJS.ErrnoException).code` |
| `packages/workspace/src/index.ts` | 205, 226 | `(error as NodeJS.ErrnoException).code` |
| `packages/workflow/src/index.ts` | 40 | `(error as NodeJS.ErrnoException).code` |
| `packages/mcp/src/tools.ts` | 72, 84 | `(error as Error).message` |

## 7. Promise.all used where allSettled may be more appropriate (LOW)

No lint catches this — it's a semantic choice. `no-floating-promises` only cares that the
result is awaited.

| File | Line | Context |
|------|------|---------|
| `packages/worker-host-pool/test/worker-host-pool.test.ts` | 190 | `Promise.all` on multiple pool operations — if one fails, the rest are orphaned |
| `test/live-ssh.test.ts` | 478 | `Promise.all` on cleanup operations — partial cleanup failure loses remaining cleanup |

Note: `packages/runtime/src/index.ts:317` already correctly uses `Promise.allSettled(dispatched)` for dispatch.

## Summary

Most of these infractions are **not catchable by the current lint/tsconfig setup**. The existing
config already handles the common cases well:
- `no-floating-promises` prevents accidental unawaited promises (but `void` is an accepted escape)
- `no-misused-promises` prevents `forEach(async fn)` in production code
- `return-await: "in-try-catch"` prevents the return-without-await bug
- `useUnknownInCatchVariables` forces explicit handling of catch variables

The real gaps are:
1. **Test files have `disableTypeChecked`** — so none of the async safety rules apply there
2. **`void` is a blessed escape hatch** — lint can't distinguish "intentional fire-and-forget" from "forgot to handle errors"
3. **setTimeout flakes** — no standard lint rule exists for this; it's a code review concern
