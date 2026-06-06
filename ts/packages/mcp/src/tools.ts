import type { Settings, TrackerKind } from "@symphony/domain";

import { executeLinearTool, linearToolSpecs } from "./tools/linear.js";
import { executeLocalTool, localToolSpecs } from "./tools/local.js";
import { unsupportedToolFailure } from "./tools/failure.js";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

function trackerKind(settings: Settings): TrackerKind {
  return settings.tracker.kind ?? "linear";
}

function assertNever(value: never): never {
  throw new Error(`unhandled tracker kind: ${String(value)}`);
}

export function toolSpecs(settings: Settings): ToolSpec[] {
  const kind = trackerKind(settings);
  switch (kind) {
    case "linear":
      return linearToolSpecs();
    case "local":
      return localToolSpecs();
    case "memory":
      return [];
    default:
      return assertNever(kind);
  }
}

export async function executeTool(
  name: string,
  input: unknown,
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult> {
  const kind = trackerKind(settings);
  switch (kind) {
    case "linear":
      return executeLinearTool(name, input, settings, fetchImpl);
    case "local":
      return executeLocalTool(name, input, settings);
    case "memory":
      return unsupportedToolFailure(name, []);
    default:
      return assertNever(kind);
  }
}
