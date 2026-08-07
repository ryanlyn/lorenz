import type { Settings } from "@lorenz/domain";

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

/**
 * Narrow, request-authenticated access to the active worker workspace.
 *
 * Tracker tools never receive SSH credentials or an unrestricted filesystem handle. Inbound
 * files can only be written beneath `.lorenz/attachments/`; outbound files can only be read from
 * `.lorenz/outbox/`.
 */
export interface ToolWorkspace {
  /** Canonical workspace path, retained for diagnostics and binding checks. */
  readonly path: string;
  /** SSH destination for a remote worker, or `null` for a local workspace. */
  readonly workerHost: string | null;
  writeAttachment(filename: string, body: ReadableStream<Uint8Array>): Promise<string>;
  withOutput<T>(
    path: string,
    use: (body: ReadableStream<Uint8Array>, size: number) => Promise<T>,
  ): Promise<T>;
}

/** Dependencies handed to a tool pack when executing one of its tools. */
export interface ToolContext {
  settings: Settings;
  fetchImpl: typeof fetch;
  /** Present only for a tool call authenticated as one active agent run. */
  workspace?: ToolWorkspace | undefined;
  /** Aborted when the MCP request is abandoned. */
  abortSignal?: AbortSignal | undefined;
}

/**
 * One named pack of agent-facing tools. Packs are registered in a {@link ToolRegistry}. The
 * MCP endpoint mounts the active tracker provider's declared default packs and any additional
 * packs explicitly configured by the workflow's `tools:` map.
 */
export interface ToolProvider {
  /** Pack name used by tracker providers' default mounts or by the workflow `tools:` map. */
  readonly name: string;
  /**
   * Absolute skill directories this pack bundles. When the pack is mounted, the composition
   * root overlays these into the workspace's skills directory alongside the configured
   * `agent.skills`, so enabling a tool ships the skill that documents how to use it.
   */
  readonly skills?: readonly string[];
  /**
   * Validate this pack's per-pack config slice. Called once at startup by
   * `validateDispatchConfig` for mounted packs that have configured options; throw with a
   * `tools.<pack>.<key> ...` message on unknown keys or invalid values.
   */
  validateOptions?(options: Record<string, unknown>): void;
  /** Tools this pack advertises for the given settings; may be empty. */
  toolSpecs(settings: Settings): ToolSpec[];
  /** Execute one of the tools declared by {@link toolSpecs}. */
  executeTool(name: string, input: unknown, context: ToolContext): Promise<ToolResult>;
}
