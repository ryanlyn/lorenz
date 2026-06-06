import { z } from "zod";
import {
  AGENT_USAGE_ACCOUNTING_VALUES,
  CONCURRENCY_MAX,
  ENSEMBLE_SIZE_MAX,
  MAX_TURNS_MAX,
  ONE_WEEK_MS,
  PORT_MAX,
  RENDER_INTERVAL_MAX_MS,
  isValidConcurrency,
  isValidEnsembleSize,
  isValidIntervalMs,
  isValidMaxTurns,
  isValidNonNegativeTimeoutMs,
  isValidPort,
  isValidRenderIntervalMs,
  isValidTimeoutMs,
} from "@symphony/domain";

import { normalizeWorkflowConfig } from "./aliases.js";

const numericInput = z.union([
  z.number().refine((n) => !Number.isNaN(n), { message: "must not be NaN" }),
  z
    .string()
    .refine((s) => s.trim() !== "", { message: "must not be empty" })
    .transform(Number)
    .refine((n) => !Number.isNaN(n), { message: "must be a number" }),
]);

const coercedPort = numericInput
  .refine((n) => isValidPort(n), {
    message: `must be a valid port number (0-${PORT_MAX})`,
  })
  .describe("non-negative");

export const coercedTimeoutMs = numericInput
  .refine((n) => isValidTimeoutMs(n), {
    message: `must be a positive integer no greater than ${ONE_WEEK_MS} (1 week)`,
  })
  .describe("positive");

export const coercedNonNegativeTimeoutMs = numericInput
  .refine((n) => isValidNonNegativeTimeoutMs(n), {
    message: `must be a non-negative integer no greater than ${ONE_WEEK_MS} (1 week)`,
  })
  .describe("non-negative");

const coercedIntervalMs = numericInput
  .refine((n) => isValidIntervalMs(n), {
    message: `must be a positive integer no greater than ${ONE_WEEK_MS} (1 week)`,
  })
  .describe("positive");

const coercedRenderIntervalMs = numericInput
  .refine((n) => isValidRenderIntervalMs(n), {
    message: `must be a positive integer no greater than ${RENDER_INTERVAL_MAX_MS}`,
  })
  .describe("positive");

const coercedConcurrency = numericInput
  .refine((n) => isValidConcurrency(n), {
    message: `must be an integer between 1 and ${CONCURRENCY_MAX}`,
  })
  .describe("positive");

const coercedMaxTurns = numericInput
  .refine((n) => isValidMaxTurns(n), {
    message: `must be an integer between 1 and ${MAX_TURNS_MAX}`,
  })
  .describe("positive");

const coercedEnsembleSize = numericInput
  .refine((n) => isValidEnsembleSize(n), {
    message: `must be an integer between 1 and ${ENSEMBLE_SIZE_MAX}`,
  })
  .describe("positive");

const coercedBoolean = z.union([
  z.boolean(),
  z.literal("true").transform(() => true),
  z.literal("false").transform(() => false),
]);

const optionalHookScript = z.string().nullable().optional();

const usageAccountingSchema = z.enum(AGENT_USAGE_ACCOUNTING_VALUES);

export const acpAgentRecordSchema = z
  .object({
    executor: z.literal("acp"),
    bridgeCommand: z.string().optional(),
    command: z.string().optional(),
    usageAccounting: usageAccountingSchema.optional(),
    providerConfig: z.record(z.string(), z.unknown()).optional(),
    // TODO: Remove per-agent timeout fields after configs use shared agents-level timeout defaults.
    turnTimeoutMs: coercedTimeoutMs.optional(),
    stallTimeoutMs: coercedNonNegativeTimeoutMs.optional(),
    strictMcpConfig: coercedBoolean.optional(),
  })
  .strict();

const trackerRawSchema = z
  .object({
    kind: z.string().optional(),
    endpoint: z.string().optional(),
    apiKey: z.string().optional(),
    projectSlug: z.string().optional(),
    projectSlugs: z.array(z.string()).optional(),
    projectLabels: z.array(z.string()).optional(),
    assignee: z.string().optional(),
    path: z.string().optional(),
    idPrefix: z.string().optional(),
    activeStates: z.array(z.string()).optional(),
    terminalStates: z.array(z.string()).optional(),
    dispatch: z
      .object({
        acceptUnrouted: coercedBoolean.optional(),
        onlyRoutes: z.array(z.string()).nullable().optional(),
        routeLabelPrefix: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const pollingRawSchema = z.object({ intervalMs: coercedIntervalMs.optional() }).strict();
const workspaceRawSchema = z
  .object({
    root: z.string().optional(),
    isolation: z.enum(["per-agent", "none"]).optional(),
  })
  .strict();
const workerRawSchema = z
  .object({
    sshHosts: z.array(z.string()).optional(),
    sshTimeoutMs: coercedTimeoutMs.optional(),
    maxConcurrentAgentsPerHost: coercedConcurrency.optional(),
  })
  .strict();
const hooksRawSchema = z
  .object({
    afterCreate: optionalHookScript,
    beforeRun: optionalHookScript,
    afterRun: optionalHookScript,
    beforeRemove: optionalHookScript,
    timeoutMs: coercedTimeoutMs.optional(),
  })
  .strict();
const agentRawSchema = z
  .object({
    kind: z.string().optional(),
    maxConcurrentAgents: coercedConcurrency.optional(),
    maxTurns: coercedMaxTurns.optional(),
    maxRetryBackoffMs: coercedTimeoutMs.optional(),
    ensembleSize: coercedEnsembleSize.optional(),
  })
  .strict();
const codexRawSchema = z
  .object({
    command: z.string().optional(),
    turnTimeoutMs: coercedTimeoutMs.optional(),
    stallTimeoutMs: coercedNonNegativeTimeoutMs.optional(),
  })
  .strict();
const claudeRawSchema = z
  .object({
    command: z.string().optional(),
    turnTimeoutMs: coercedTimeoutMs.optional(),
    stallTimeoutMs: coercedNonNegativeTimeoutMs.optional(),
    strictMcpConfig: coercedBoolean.optional(),
    providerConfig: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const observabilityRawSchema = z
  .object({
    dashboardEnabled: coercedBoolean.optional(),
    refreshMs: coercedIntervalMs.optional(),
    renderIntervalMs: coercedRenderIntervalMs.optional(),
  })
  .strict();
const serverRawSchema = z
  .object({
    host: z.string().optional(),
    port: coercedPort.optional(),
    traceDir: z.string().optional(),
    staticDir: z.string().optional(),
  })
  .strict();
const loggingRawSchema = z.object({ logFile: z.string().optional() }).strict();
const agentsRawSchema = z.record(z.string(), z.unknown());
const partialAgentRawSchema = agentRawSchema.partial().strict();
const partialCodexRawSchema = codexRawSchema.partial().strict();
const partialClaudeRawSchema = claudeRawSchema.partial().strict();
const statusOverrideRawSchema = z
  .object({
    agent: partialAgentRawSchema.optional(),
    codex: partialCodexRawSchema.optional(),
    claude: partialClaudeRawSchema.optional(),
  })
  .strict();

export const workflowConfigSchema = z.preprocess(
  normalizeWorkflowConfig,
  z
    .object({
      tracker: trackerRawSchema.optional(),
      polling: pollingRawSchema.optional(),
      workspace: workspaceRawSchema.optional(),
      worker: workerRawSchema.optional(),
      hooks: hooksRawSchema.optional(),
      agent: agentRawSchema.optional(),
      agents: agentsRawSchema.optional(),
      codex: codexRawSchema.optional(),
      claude: claudeRawSchema.optional(),
      observability: observabilityRawSchema.optional(),
      server: serverRawSchema.optional(),
      logging: loggingRawSchema.optional(),
      statusOverrides: z.record(z.string(), statusOverrideRawSchema).optional(),
    })
    .passthrough(),
);

export type WorkflowConfigRaw = z.infer<typeof workflowConfigSchema>;
export type TrackerRaw = z.infer<typeof trackerRawSchema>;
export type DispatchRaw = NonNullable<TrackerRaw["dispatch"]>;
export type HooksRaw = z.infer<typeof hooksRawSchema>;
export type AgentRaw = z.infer<typeof agentRawSchema>;
export type AgentsRaw = z.infer<typeof agentsRawSchema>;
export type CodexRaw = z.infer<typeof codexRawSchema>;
export type ClaudeRaw = z.infer<typeof claudeRawSchema>;
export type StatusOverridesRaw = NonNullable<WorkflowConfigRaw["statusOverrides"]>;
export type AcpAgentRecordRaw = z.infer<typeof acpAgentRecordSchema>;
