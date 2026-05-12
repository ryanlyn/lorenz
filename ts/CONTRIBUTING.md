# Contributing

## Runtime Boundaries

Use zod schemas at external boundaries: process protocols, persisted state, tracker responses, and
HTTP request inputs. Put cross-cutting schemas under `src/schemas/`; otherwise keep boundary-only
schemas next to the code that consumes them.

Schemas that forward wire payloads should use `z.passthrough()` so newer fields survive the hop.
Schemas for terminal inputs should be exact enough to reject invalid data while preserving existing
compatibility behavior.

When a schema exists, infer the internal TypeScript type from it. When there is no schema, keep the
existing TypeScript type as the source of truth until a boundary migration needs validation.

Use `ts-pattern` for discriminated unions and close matches with `.exhaustive()` so new variants are
handled intentionally.
