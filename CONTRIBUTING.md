# Contributing

## Workspace Layout

The TypeScript workspace is a pnpm workspace rooted at the repository root. Runtime code belongs in `packages/*`;
process wiring and CLI commands belong in `apps/cli`.

Create a package when a boundary has a clear owner. Each package needs:

- `package.json` named `@lorenz/<name>` with internal dependencies declared as `workspace:*`
- `tsconfig.json` extending `../../tsconfig.base.json` with project references for internal deps
- `src/index.ts` with curated exports, not wildcard re-exports
- package-owned tests under `packages/<name>/test/`

Keep cross-package parity, workflow, and live tests under `test/`.

Use `pnpm -w typecheck`, `pnpm -w build`, `pnpm -w lint`, `pnpm -w format:check`, and
`pnpm -w test` before publishing workspace changes.

## Runtime Boundaries

Use zod schemas at external boundaries: process protocols, persisted state, tracker responses, and
HTTP request inputs. Put cross-cutting schemas in the package that owns the boundary; otherwise keep boundary-only
schemas next to the code that consumes them.

Schemas that forward wire payloads should use `z.passthrough()` so newer fields survive the hop.
Schemas for terminal inputs should be exact enough to reject invalid data while preserving existing
compatibility behavior.

When a schema exists, infer the internal TypeScript type from it. When there is no schema, keep the
existing TypeScript type as the source of truth until a boundary migration needs validation.

Use `ts-pattern` for discriminated unions and close matches with `.exhaustive()` so new variants are
handled intentionally.
