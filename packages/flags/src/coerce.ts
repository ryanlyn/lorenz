import { z } from "zod";

// `@lorenz/config` keeps its `numericInput`/`coercedBoolean` private to `schemas.ts`, and
// cross-package imports may not reach into another package's `src/`, so `flags` re-derives the
// primitives locally. The numeric string branch is deliberately stricter than the config one: it
// trims, then validates against an explicit decimal/exponent form before `Number()`, so `" "`,
// `"0x10"`, `"Infinity"`, `"NaN"`, and stray text fail loudly instead of silently coercing. A flag
// value either parses to the obvious number or is rejected with a clear message.
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A finite number, or a strictly-decimal numeric string (env/CLI string inputs). */
const numericInput: z.ZodType<number, string | number> = z.union([
  z.number().refine(Number.isFinite, { message: "must be a finite number" }),
  z
    .string()
    .trim()
    .refine((s) => s !== "" && DECIMAL.test(s), { message: "must be a number" })
    .transform(Number)
    .refine(Number.isFinite, { message: "must be a finite number" }),
]);

/** A boolean, or the exact strings "true"/"false". The shared {@link parseBoolToken} normalizes
 *  case for CLI/env/file inputs before this schema runs, so this union is the schema of record for
 *  native-boolean and exact-string parity with `@lorenz/config`. */
export const coercedBoolean: z.ZodType<boolean, string | boolean> = z.union([
  z.boolean(),
  z.literal("true").transform(() => true),
  z.literal("false").transform(() => false),
]);

export const coercedInt: z.ZodType<number, string | number> = numericInput.refine(
  (n) => Number.isInteger(n),
  { message: "must be an integer" },
);

export const coercedFloat: z.ZodType<number, string | number> = numericInput;

/** The single boolean-token policy shared by CLI/env/file feature parsing and `flag.bool` inputs:
 *  trim + case-insensitive `true`/`false`. Native booleans pass through. Returns `undefined` for
 *  non-boolean tokens so the caller can report a friendly, per-source error. */
export function parseBoolToken(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return undefined;
  const lowered = raw.trim().toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  return undefined;
}
