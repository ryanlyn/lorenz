import { isRecord } from "@symphony/domain";

/**
 * A small query DSL backing the read tools of the structured trackers
 * (`local_query` today). It is the composable, side-effect-free analog of `linear_graphql`'s
 * read power: a query can never mutate the backend, so it carries no trust-boundary or
 * atomicity risk and the agent can filter/project/sort/page freely.
 *
 * The DSL is intentionally total - no regex, no `eval`, no JSONPath - and is evaluated in
 * memory over already-parsed records (a board `Issue[]`).
 * Nesting depth and node count are bounded so a hostile or runaway filter cannot blow up.
 */

type Scalar = string | number | boolean | null;

type Predicate =
  | { field: string; op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; value: Scalar }
  | { field: string; op: "in" | "nin"; value: Scalar[] }
  | { field: string; op: "contains"; value: string; ci?: boolean }
  | { field: string; op: "exists"; value: boolean };

export type Filter = Predicate | { and: Filter[] } | { or: Filter[] } | { not: Filter };

interface OrderBy {
  field: string;
  dir: "asc" | "desc";
}

export interface QuerySpec {
  where?: Filter;
  orderBy: OrderBy[];
  limit: number;
  offset: number;
}

const MAX_FILTER_DEPTH = 12;
const MAX_FILTER_NODES = 200;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const COMPARE_OPS = new Set(["eq", "ne", "lt", "lte", "gt", "gte"]);
const SET_OPS = new Set(["in", "nin"]);

/**
 * Validate untrusted agent input into a typed {@link Filter}, reconstructing each node so no
 * stray properties survive. Throws a clear `Error` on malformed input or when the tree exceeds
 * the depth/node bounds.
 */
export function parseFilter(input: unknown): Filter {
  return parseNode(input, 1, { nodes: 0 });
}

function parseNode(input: unknown, depth: number, state: { nodes: number }): Filter {
  if (depth > MAX_FILTER_DEPTH) {
    throw new Error(`filter nesting exceeds ${MAX_FILTER_DEPTH} levels`);
  }
  if (++state.nodes > MAX_FILTER_NODES) {
    throw new Error(`filter has more than ${MAX_FILTER_NODES} nodes`);
  }
  if (!isRecord(input)) throw new Error("filter: each node must be an object");

  const hasAnd = "and" in input;
  const hasOr = "or" in input;
  const hasNot = "not" in input;
  if (hasAnd || hasOr || hasNot) {
    if (Object.keys(input).length !== 1) {
      throw new Error("filter: a combinator node must have exactly one of 'and', 'or', or 'not'");
    }
    if (hasNot) return { not: parseNode(input.not, depth + 1, state) };
    const key = hasAnd ? "and" : "or";
    const arr = input[key];
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error(`filter: '${key}' must be a non-empty array of filters`);
    }
    const parsed = arr.map((node) => parseNode(node, depth + 1, state));
    return hasAnd ? { and: parsed } : { or: parsed };
  }

  const field = input.field;
  const op = input.op;
  if (typeof field !== "string" || field === "") {
    throw new Error("filter: predicate 'field' must be a non-empty string");
  }
  if (typeof op !== "string") throw new Error("filter: predicate 'op' must be a string");

  if (COMPARE_OPS.has(op)) {
    if (!isScalar(input.value)) {
      throw new Error(`filter: '${op}' value must be a string, number, boolean, or null`);
    }
    return { field, op: op as "eq" | "ne" | "lt" | "lte" | "gt" | "gte", value: input.value };
  }
  if (SET_OPS.has(op)) {
    const value = input.value;
    if (!Array.isArray(value) || !value.every(isScalar)) {
      throw new Error(`filter: '${op}' value must be an array of scalars`);
    }
    return { field, op: op as "in" | "nin", value: value };
  }
  if (op === "contains") {
    if (typeof input.value !== "string") {
      throw new Error("filter: 'contains' value must be a string");
    }
    if (input.ci !== undefined && typeof input.ci !== "boolean") {
      throw new Error("filter: 'contains' ci must be a boolean");
    }
    return input.ci === undefined
      ? { field, op: "contains", value: input.value }
      : { field, op: "contains", value: input.value, ci: input.ci };
  }
  if (op === "exists") {
    if (typeof input.value !== "boolean") {
      throw new Error("filter: 'exists' value must be a boolean");
    }
    return { field, op: "exists", value: input.value };
  }
  throw new Error(`filter: unknown op '${op}'`);
}

/** Evaluate a validated {@link Filter} against a record. Side-effect free. */
export function matchesFilter(record: Record<string, unknown>, filter: Filter): boolean {
  if ("and" in filter) return filter.and.every((f) => matchesFilter(record, f));
  if ("or" in filter) return filter.or.some((f) => matchesFilter(record, f));
  if ("not" in filter) return !matchesFilter(record, filter.not);
  return matchesPredicate(record, filter);
}

function matchesPredicate(record: Record<string, unknown>, p: Predicate): boolean {
  // An unknown/undefined field is "absent": every comparison is false, mirroring linear_graphql's
  // "ask for a field you do not have, get null" ergonomics. Only `exists:false` matches absence.
  const present =
    Object.prototype.hasOwnProperty.call(record, p.field) && record[p.field] !== undefined;
  if (!present) return p.op === "exists" && p.value === false;

  const raw = record[p.field];
  switch (p.op) {
    case "exists":
      return p.value === true;
    case "eq":
      return scalarEq(raw, p.value);
    case "ne":
      return !scalarEq(raw, p.value);
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const c = compare(raw, p.value);
      if (c === null) return false;
      if (p.op === "lt") return c < 0;
      if (p.op === "lte") return c <= 0;
      if (p.op === "gt") return c > 0;
      return c >= 0;
    }
    case "in":
      return p.value.some((v) => scalarEq(raw, v));
    case "nin":
      return !p.value.some((v) => scalarEq(raw, v));
    case "contains":
      if (typeof raw === "string") return strIncludes(raw, p.value, p.ci);
      if (Array.isArray(raw)) return raw.some((el) => strIncludes(String(el), p.value, p.ci));
      return false;
  }
}

/**
 * Parse the shared query envelope (`where`, `order_by`, `limit`, `offset`) from raw tool args.
 * `select`, and any tracker-specific args, are parsed by the calling tool.
 */
export function parseQuerySpec(args: Record<string, unknown>): QuerySpec {
  const spec: QuerySpec = { orderBy: [], limit: DEFAULT_LIMIT, offset: 0 };
  if (args.where !== undefined && args.where !== null) spec.where = parseFilter(args.where);
  if (args.order_by !== undefined) spec.orderBy = parseOrderBy(args.order_by);
  if (args.limit !== undefined) spec.limit = parseLimit(args.limit);
  if (args.offset !== undefined) spec.offset = parseOffset(args.offset);
  return spec;
}

/** Filter, then (stably) sort, then page a record list. Returns the page plus the pre-page total. */
export function applyQuery<T extends Record<string, unknown>>(
  records: T[],
  spec: QuerySpec,
): { rows: T[]; total: number } {
  let filtered = spec.where
    ? records.filter((r) => matchesFilter(r, spec.where!))
    : records.slice();
  if (spec.orderBy.length > 0) filtered = sortRecords(filtered, spec.orderBy);
  const total = filtered.length;
  return { rows: filtered.slice(spec.offset, spec.offset + spec.limit), total };
}

/** Validate an optional `select` projection: an array of field-name strings, or undefined. */
export function parseSelect(input: unknown): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input) || !input.every((s) => typeof s === "string")) {
    throw new Error("select must be an array of field-name strings");
  }
  return input;
}

/** Project a record down to the named fields, dropping any the record does not have. */
export function pickFields(
  record: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(record, f)) out[f] = record[f];
  }
  return out;
}

function parseOrderBy(input: unknown): OrderBy[] {
  if (!Array.isArray(input)) throw new Error("order_by must be an array");
  return input.map((item) => {
    if (!isRecord(item) || typeof item.field !== "string" || item.field === "") {
      throw new Error("order_by items must be { field: string, dir?: 'asc' | 'desc' }");
    }
    if (item.dir !== undefined && item.dir !== "asc" && item.dir !== "desc") {
      throw new Error("order_by dir must be 'asc' or 'desc'");
    }
    return { field: item.field, dir: item.dir === "desc" ? "desc" : "asc" };
  });
}

function parseLimit(input: unknown): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(input, MAX_LIMIT);
}

function parseOffset(input: unknown): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0) {
    throw new Error("offset must be a non-negative integer");
  }
  return input;
}

function sortRecords<T extends Record<string, unknown>>(records: T[], orderBy: OrderBy[]): T[] {
  return [...records].sort((a, b) => {
    for (const { field, dir } of orderBy) {
      const c = compare(a[field], b[field]);
      if (c !== null && c !== 0) return dir === "desc" ? -c : c;
    }
    return 0;
  });
}

function scalarEq(a: unknown, b: Scalar): boolean {
  return a === b;
}

/** Compare two values when both are numbers or both are strings; otherwise incomparable (null). */
function compare(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

function strIncludes(haystack: string, needle: string, ci?: boolean): boolean {
  return ci ? haystack.toLowerCase().includes(needle.toLowerCase()) : haystack.includes(needle);
}

function isScalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
