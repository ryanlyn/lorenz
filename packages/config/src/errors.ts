import type { z } from "zod";

export function configErrorMessage(error: z.ZodError, baseLabel?: string): string {
  const issue = error.issues[0];
  if (!issue) return `${baseLabel ?? "workflow"} is invalid`;
  const label = pathLabel(issue.path, baseLabel);
  switch (issue.code) {
    case "unrecognized_keys":
      return `${label} contains unsupported keys: ${issue.keys.join(", ")}`;
    case "invalid_type": {
      const expected = (issue as { expected?: string }).expected;
      const messages: Record<string, string> = {
        string: `${label} must be a string`,
        number: integerMessageForLabel(label),
        array: `${label} must be a list of strings`,
      };
      return messages[expected ?? ""] ?? `${label} must be a map`;
    }
    case "too_small":
      return integerMessageForLabel(label);
    case "custom":
      return `${label} ${issue.message}`;
    case "invalid_union": {
      const innerErrors = (issue as { errors?: unknown[][] }).errors;
      const firstInner = innerErrors?.[0]?.[0] as { expected?: string } | undefined;
      if (firstInner?.expected === "boolean") return `expected a boolean`;
      if (firstInner?.expected === "number") return integerMessageForLabel(label);
      return `${label} is invalid: ${issue.message}`;
    }
    default:
      return `${label} is invalid: ${issue.message}`;
  }
}

function integerMessageForLabel(label: string): string {
  const field = label.split(".").pop() ?? "";
  if (field === "port") return `${label} must be a valid port number (0-65535)`;
  const kind = field === "stall_timeout_ms" ? "a non-negative integer" : "a positive integer";
  return `${label} must be ${kind}`;
}

function camelToSnake(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function pathLabel(
  pathSegments: readonly (string | number | symbol)[],
  baseLabel?: string,
): string {
  const suffix = pathSegments.map((seg) => camelToSnake(String(seg))).join(".");
  if (suffix && baseLabel) return `${baseLabel}.${suffix}`;
  if (suffix) return suffix;
  return baseLabel ?? "workflow";
}
