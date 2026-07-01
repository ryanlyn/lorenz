import { redactDiagnosticText } from "@lorenz/domain";

const MAX_ERROR_BODY_LOG_BYTES = 1000;

export function linearErrorContext(query: string, body?: unknown): string {
  const parts: string[] = [];
  const operation = operationName(query);
  if (operation) parts.push(`operation=${operation}`);
  if (body !== undefined) parts.push(`body=${summarizeErrorBody(body)}`);
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

function operationName(query: string): string | null {
  return /\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query)?.[1] ?? null;
}

function summarizeErrorBody(body: unknown): string {
  const text = typeof body === "string" ? body : stringifyErrorBody(body);
  const compact = redactDiagnosticText(text).replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_ERROR_BODY_LOG_BYTES) return compact;
  return `${compact.slice(0, MAX_ERROR_BODY_LOG_BYTES)}...<truncated>`;
}

function stringifyErrorBody(body: unknown): string {
  try {
    return JSON.stringify(body) ?? String(body);
  } catch {
    return String(body);
  }
}
