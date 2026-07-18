export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordAt(value: unknown, path: readonly string[]): Record<string, unknown> | null {
  const found = valueAt(value, path);
  return isRecord(found) ? found : null;
}

export function arrayAt(value: unknown, path: readonly string[]): unknown[] | null {
  const found = valueAt(value, path);
  return Array.isArray(found) ? found : null;
}

export function stringAt(value: unknown, path: readonly string[]): string | null {
  const found = valueAt(value, path);
  return typeof found === "string" && found.trim() !== "" ? found : null;
}

export function numberAt(value: unknown, path: readonly string[]): number | null {
  const found = valueAt(value, path);
  return typeof found === "number" && Number.isFinite(found) ? found : null;
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}
