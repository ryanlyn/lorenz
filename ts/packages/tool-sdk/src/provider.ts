import type { Settings } from "@symphony/domain";

/**
 * JSON-Schema-shaped declaration of one agent-facing tool, served to agent sessions over
 * the MCP endpoint.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Outcome of one tool invocation. `result` is returned to the agent verbatim; `error` is a
 * human-readable summary set when `success` is false.
 */
export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

/** Dependencies handed to a tool pack when executing one of its tools. */
export interface ToolContext {
  settings: Settings;
  fetchImpl: typeof fetch;
}

/**
 * One named pack of agent-facing tools. Packs are registered in a {@link ToolRegistry} and
 * mounted on the MCP endpoint by name via the `tools:` config list; when the list is
 * omitted, the composition root mounts the provider-neutral tracker pack plus the dispatch
 * tracker's own pack. Several packs can be mounted at once while a single tracker drives
 * dispatch, so a deployment can mix tool surfaces freely.
 */
export interface ToolProvider {
  /** Pack selector matched against entries of the `tools:` config list (e.g. `"linear"`). */
  readonly name: string;
  /** Tools this pack advertises for the given settings; may be empty. */
  toolSpecs(settings: Settings): ToolSpec[];
  /** Execute one of the tools declared by {@link toolSpecs}. */
  executeTool(name: string, input: unknown, context: ToolContext): Promise<ToolResult>;
}
