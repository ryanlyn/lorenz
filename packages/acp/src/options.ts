import { isOneOf, isRecord, type AgentConfig } from "@lorenz/domain";

export const AGENT_USAGE_ACCOUNTING_VALUES = ["per-turn", "cumulative"] as const;

export type AgentUsageAccounting = (typeof AGENT_USAGE_ACCOUNTING_VALUES)[number];

/** ACP-executor-specific keys of an `agents.<kind>` config record, validated by the provider. */
export interface AcpAgentOptions {
  /** Shell command launched per session (run via `bash -lc` in the workspace, or over SSH on remote workers). Also selects the provider-config overlay format: `claude-agent-acp` consumes a settings.json-shaped overlay, anything else config.toml-shaped overrides. */
  bridgeCommand: string;
  /** Shape of `PromptResponse.usage` emitted by this ACP bridge. Lorenz always converts it to cumulative per-run totals before handing it to the orchestrator. */
  usageAccounting: AgentUsageAccounting;
  /** Free-form provider configuration delivered to the bridge via the session request's `_meta`. */
  providerConfig?: Record<string, unknown> | undefined;
  /** When true, launch the bridge with only the MCP servers Lorenz injected (no user-side MCP config). */
  strictMcpConfig?: boolean | undefined;
}

/** Typed view over `AgentConfig.options` for records driven by the ACP executor. */
export function acpAgentOptions(config: AgentConfig): AcpAgentOptions {
  const options = config.options;
  const bridgeCommand = typeof options.bridgeCommand === "string" ? options.bridgeCommand : "";
  const usageAccounting = usageAccountingValue(options.usageAccounting);
  const providerConfig = isRecord(options.providerConfig) ? options.providerConfig : undefined;
  return {
    bridgeCommand,
    usageAccounting: usageAccounting ?? inferUsageAccounting(bridgeCommand),
    ...(providerConfig !== undefined ? { providerConfig } : {}),
    ...(typeof options.strictMcpConfig === "boolean"
      ? { strictMcpConfig: options.strictMcpConfig }
      : {}),
  };
}

const ACP_OPTION_KEYS = ["bridgeCommand", "usageAccounting", "providerConfig", "strictMcpConfig"];

/**
 * Validate and normalize the ACP executor's slice of an `agents.<kind>` config record
 * (aliases already applied, kind defaults already merged underneath). Backs
 * `acpExecutorProvider.parseOptions`.
 */
export function parseAcpAgentOptions(options: Record<string, unknown>): Record<string, unknown> {
  const unknown = Object.keys(options).filter((key) => !ACP_OPTION_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new Error(`unsupported agent option(s) for the acp executor: ${unknown.join(", ")}`);
  }
  const bridgeCommand = stringOption(options, "bridgeCommand") ?? "";
  const usageAccounting =
    parseUsageAccounting(options.usageAccounting) ?? inferUsageAccounting(bridgeCommand);
  const providerConfig = recordOption(options, "providerConfig");
  const strictMcpConfig = booleanOption(options, "strictMcpConfig") ?? true;
  return {
    bridgeCommand,
    usageAccounting,
    ...(providerConfig !== undefined ? { providerConfig } : {}),
    strictMcpConfig,
  };
}

export function isClaudeCompatibleBridgeCommand(bridgeCommand: string): boolean {
  return /(^|\s|\/)claude-agent-acp(\s|$)/.test(bridgeCommand);
}

/** Bridges known to report per-turn usage deltas; anything else defaults to cumulative. */
function inferUsageAccounting(bridgeCommand: string): AgentUsageAccounting {
  if (/(^|\s|\/)(codex-acp|claude-agent-acp)(\s|$)/.test(bridgeCommand)) return "per-turn";
  return "cumulative";
}

function usageAccountingValue(value: unknown): AgentUsageAccounting | undefined {
  return typeof value === "string" && isOneOf(value, AGENT_USAGE_ACCOUNTING_VALUES)
    ? value
    : undefined;
}

function parseUsageAccounting(value: unknown): AgentUsageAccounting | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = usageAccountingValue(value);
  if (parsed === undefined) {
    throw new Error(
      `agent option usageAccounting must be one of: ${AGENT_USAGE_ACCOUNTING_VALUES.join(", ")}`,
    );
  }
  return parsed;
}

function stringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`agent option ${key} must be a string`);
  return value;
}

function recordOption(
  options: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = options[key];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error(`agent option ${key} must be a map`);
  return value;
}

/** Accepts booleans plus the YAML-friendly `"true"` / `"false"` strings. */
function booleanOption(options: Record<string, unknown>, key: string): boolean | undefined {
  const value = options[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`agent option ${key} must be a boolean`);
}
