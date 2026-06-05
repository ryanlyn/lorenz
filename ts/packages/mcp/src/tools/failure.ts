import type { ToolResult } from "../tools.js";

export function unsupportedToolFailure(
  name: string,
  supportedTools: readonly string[],
): ToolResult {
  const message = `Unsupported tool: ${JSON.stringify(name)}.`;
  return {
    success: false,
    error: message,
    result: { error: { message, supportedTools: [...supportedTools] } },
  };
}
