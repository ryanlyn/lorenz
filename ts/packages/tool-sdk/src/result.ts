import type { ToolResult } from "./provider.js";

export function toolSuccess(result: unknown): ToolResult {
  return { success: true, result };
}

export function toolFailure(message: string, details: Record<string, unknown> = {}): ToolResult {
  return {
    success: false,
    error: message,
    result: { error: { message, ...details } },
  };
}

export function unsupportedToolFailure(
  name: string,
  supportedTools: readonly string[],
): ToolResult {
  const message = `Unsupported tool: ${JSON.stringify(name)}.`;
  return toolFailure(message, { supportedTools: [...supportedTools] });
}
