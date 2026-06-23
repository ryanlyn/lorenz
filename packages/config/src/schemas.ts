import { z } from "zod";
import {
  CONCURRENCY_MAX,
  ENSEMBLE_SIZE_MAX,
  MAX_TURNS_MAX,
  ONE_WEEK_MS,
  PORT_MAX,
  RENDER_INTERVAL_MAX_MS,
  isRecord,
  isValidConcurrency,
  isValidEnsembleSize,
  isValidIntervalMs,
  isValidMaxTurns,
  isValidNonNegativeTimeoutMs,
  isValidPort,
  isValidRenderIntervalMs,
  isValidTimeoutMs,
} from "@lorenz/domain";

import { normalizeWorkflowConfig } from "./aliases.js";

// Deprecations are declared as Zod `.meta()` annotations on the schema fields and sections they
// belong to, so the fact that a key is deprecated lives next to where that key is defined. The
// scanner in `deprecations.ts` reads these annotations back; it owns no key lists of its own.

/** Field-level annotation: this key is deprecated in favor of {@link replacement}. */
interface DeprecatedFieldMeta {
  /** snake_case replacement path, e.g. `agents.codex.bridge_command`. */
  replacement: string;
  /** Optional per-field guidance; falls back to the section note when omitted. */
  detail?: string;
}

/** Object-level annotation: every catchall (undeclared) key in this section is deprecated. */
interface FlatShapeDeprecationMeta {
  /** Bundle namespace that replaces the flat shape, e.g. `trackers`. */
  replacementBundle: string;
  /** Section key whose value names the suggested bundle (e.g. `kind`). */
  bundleNameKey: string;
  /** Guidance appended to each flagged key's warning. */
  note: string;
}

/** Tag a schema field as deprecated with the canonical key that replaces it. */
function deprecatedField<T extends z.ZodType>(schema: T, meta: DeprecatedFieldMeta): T {
  return schema.meta({ deprecation: meta });
}

function fieldDeprecation(schema: z.ZodType): DeprecatedFieldMeta | undefined {
  return (schema.meta() as { deprecation?: DeprecatedFieldMeta } | undefined)?.deprecation;
}

function sectionDeprecationNote(schema: z.ZodType): string | undefined {
  return (schema.meta() as { deprecatedSection?: string } | undefined)?.deprecatedSection;
}

function flatShapeDeprecation(schema: z.ZodType): FlatShapeDeprecationMeta | undefined {
  return (schema.meta() as { flatShape?: FlatShapeDeprecationMeta } | undefined)?.flatShape;
}

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

const coercedPositiveCount = numericInput
  .refine((n) => Number.isInteger(n) && n >= 1, { message: "must be a positive integer" })
  .describe("positive");

const coercedNonNegativeCount = numericInput
  .refine((n) => Number.isInteger(n) && n >= 0, { message: "must be a non-negative integer" })
  .describe("non-negative");

const optionalHookScript = z.string().nullable().optional();
const skillSourceListSchema = z.array(z.string().min(1));

// Shared keys are validated here; any other key in an agents.<kind> record is
// executor-specific and is passed through (`catchall`) to the registered agent executor
// provider's option parser. The executor selector is open-ended; whether it is supported is
// decided by the agent executor registry at dispatch validation, not by the schema.
export const agentRecordSchema = z
  .object({
    executor: z.string().min(1).optional(),
    // TODO: Remove per-agent timeout fields after configs use shared agents-level timeout defaults.
    turnTimeoutMs: coercedTimeoutMs.optional(),
    stallTimeoutMs: coercedNonNegativeTimeoutMs.optional(),
  })
  .catchall(z.unknown());

/** Per-state agent record override: like an agent record, minus the executor selector. */
export const agentRecordOverrideSchema = z
  .object({
    turnTimeoutMs: coercedTimeoutMs.optional(),
    stallTimeoutMs: coercedNonNegativeTimeoutMs.optional(),
  })
  .catchall(z.unknown());

// Common keys are validated after the tracker provider has been selected. This schema is
// used for the legacy `tracker.kind` form and canonical `trackers.<name>` records. The declared
// keys are the core selector; the catchall carries provider passthrough options, which under
// `tracker` (the flat shape) are deprecated in favor of a `trackers.<name>` bundle - see the
// `flatShape` annotation, which the deprecation scanner reads to flag those undeclared keys.
export const trackerRecordSchema = z
  .object({
    kind: z.string().optional(),
    provider: z.string().optional(),
    endpoint: z.string().optional(),
    apiKey: z.string().optional(),
    assignee: z.string().optional(),
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
  .catchall(z.unknown())
  .meta({
    flatShape: {
      replacementBundle: "trackers",
      bundleNameKey: "kind",
      note: "Provider options under `tracker` (flat shape) are deprecated; move them into a `trackers.<name>` bundle with `provider:` selected by `tracker.kind`.",
    } satisfies FlatShapeDeprecationMeta,
  });
const trackerRawSchema = z.record(z.string(), z.unknown());
const trackersRawSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

const pollingRawSchema = z.object({ intervalMs: coercedIntervalMs.optional() }).strict();
const workspaceRawSchema = z
  .object({
    root: z.string().optional(),
    isolation: z.enum(["per-agent", "none"]).optional(),
  })
  .strict();
const workerPoolSpendRawSchema = z
  .object({
    maxConcurrentWorkers: coercedPositiveCount.optional(),
    maxWorkerSeconds: coercedPositiveCount.optional(),
    dailyWorkerSeconds: coercedPositiveCount.optional(),
  })
  .strict();
const workerPoolRawSchema = z
  .object({
    // There is no operator-facing `enabled` flag: the pool is the single dispatch path, so a
    // present `worker_pool` block is always enabled. The `.strict()` schema therefore rejects an
    // `enabled` key. (The internal `WorkerPoolSettings.enabled` field is set by the reload-drain
    // to drain a removed pool to zero, not by config.)
    //
    // The driver selector is open-ended; whether the kind is supported is decided by the
    // worker-driver registry at pool construction, not by the schema.
    driver: z.string().min(1).optional(),
    min: coercedNonNegativeCount.optional(),
    max: coercedPositiveCount.optional(),
    warm: coercedNonNegativeCount.optional(),
    maxInFlight: coercedPositiveCount.optional(),
    ttlMs: coercedTimeoutMs.optional(),
    idleReapMs: coercedTimeoutMs.optional(),
    acquireTimeoutMs: coercedTimeoutMs.optional(),
    reapIntervalMs: coercedTimeoutMs.optional(),
    staleHeartbeatMs: coercedTimeoutMs.optional(),
    drainDeadlineMs: coercedTimeoutMs.optional(),
    maxWorkersPerIssue: coercedPositiveCount.optional(),
    coResidence: coercedBoolean.optional(),
    maxConcurrentTunnels: coercedPositiveCount.optional(),
    spend: workerPoolSpendRawSchema.optional(),
  })
  .strict();
const workerRawSchema = z
  .object({
    kind: z.string().min(1).optional(),
    sshHosts: z.array(z.string()).optional(),
    sshTimeoutMs: coercedTimeoutMs.optional(),
    maxConcurrentAgentsPerHost: coercedConcurrency.optional(),
    workerPool: workerPoolRawSchema.nullish(),
  })
  .strict();
const workerProfileRawSchema = z
  .object({
    // The driver selector is open-ended; whether the kind is supported is decided by the
    // worker-driver registry at pool construction, not by the schema.
    driver: z.string().min(1),
  })
  .catchall(z.unknown());
const workersRawSchema = z.record(z.string(), workerProfileRawSchema);
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
    skills: skillSourceListSchema.optional(),
  })
  .strict();
// The top-level `codex:`/`claude:` sections are legacy sugar folded into `agents.<kind>` at
// parse time, so every field carries the canonical `agents.<kind>` key that replaces it.
const codexRawSchema = z
  .object({
    command: deprecatedField(z.string().optional(), {
      replacement: "agents.codex.bridge_command",
    }),
    turnTimeoutMs: deprecatedField(coercedTimeoutMs.optional(), {
      replacement: "agents.codex.turn_timeout_ms",
    }),
    stallTimeoutMs: deprecatedField(coercedNonNegativeTimeoutMs.optional(), {
      replacement: "agents.codex.stall_timeout_ms",
    }),
  })
  .strict()
  .meta({
    deprecatedSection:
      "The top-level `codex` section is legacy sugar; configure agent records under `agents.codex` instead.",
  });
const claudeRawSchema = z
  .object({
    command: deprecatedField(z.string().optional(), {
      replacement: "agents.claude.bridge_command",
    }),
    model: deprecatedField(z.string().optional(), {
      replacement: "agents.claude.provider_config.model",
    }),
    turnTimeoutMs: deprecatedField(coercedTimeoutMs.optional(), {
      replacement: "agents.claude.turn_timeout_ms",
    }),
    stallTimeoutMs: deprecatedField(coercedNonNegativeTimeoutMs.optional(), {
      replacement: "agents.claude.stall_timeout_ms",
    }),
    strictMcpConfig: deprecatedField(coercedBoolean.optional(), {
      replacement: "agents.claude.strict_mcp_config",
    }),
    providerConfig: deprecatedField(z.record(z.string(), z.unknown()).optional(), {
      replacement: "agents.claude.provider_config",
    }),
  })
  .strict()
  .meta({
    deprecatedSection:
      "The top-level `claude` section is legacy sugar; configure agent records under `agents.claude` instead.",
  });
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
const toolsRawSchema = z.record(z.string(), z.record(z.string(), z.unknown()));
// Skills are resolved once from the base `agent` config; per-state overrides may not retarget
// them, so they are omitted from the partial override schema (an explicit `skills` key in a
// status override is rejected by `.strict()`).
const partialAgentRawSchema = agentRawSchema.omit({ skills: true }).partial().strict();
const partialCodexRawSchema = codexRawSchema.partial().strict();
const partialClaudeRawSchema = claudeRawSchema.partial().strict();
const statusOverrideRawSchema = z
  .object({
    agent: partialAgentRawSchema.optional(),
    agents: z.record(z.string(), z.unknown()).optional(),
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
      workers: workersRawSchema.optional(),
      hooks: hooksRawSchema.optional(),
      agent: agentRawSchema.optional(),
      agents: agentsRawSchema.optional(),
      codex: codexRawSchema.optional(),
      claude: claudeRawSchema.optional(),
      observability: observabilityRawSchema.optional(),
      server: serverRawSchema.optional(),
      logging: loggingRawSchema.optional(),
      trackers: trackersRawSchema.optional(),
      tools: toolsRawSchema.optional(),
      statusOverrides: z.record(z.string(), statusOverrideRawSchema).optional(),
    })
    .passthrough(),
);

/** A deprecated config key discovered by reading the schema annotations, with its replacement. */
export interface ConfigDeprecation {
  /** snake_case config path as written in front matter, e.g. `codex.command`. */
  configPath: string;
  /** Recommended replacement key or shape, e.g. `agents.codex.bridge_command`. */
  replacement: string;
  /** Extra guidance appended to the formatted warning. */
  detail?: string | undefined;
}

// Sections whose deprecated keys are declared field-by-field via `deprecatedField`/`.meta`.
const ANNOTATED_DEPRECATION_SECTIONS: ReadonlyArray<{ section: string; schema: z.ZodObject }> = [
  { section: "codex", schema: codexRawSchema },
  { section: "claude", schema: claudeRawSchema },
];

/**
 * Read the deprecation annotations off the schemas for a normalized (alias-resolved) config and
 * return one entry per deprecated key in use. The facts all live on the schemas; this walker
 * only reports what they declare.
 */
export function schemaConfigDeprecations(normalized: Record<string, unknown>): ConfigDeprecation[] {
  const out: ConfigDeprecation[] = [];
  for (const { section, schema } of ANNOTATED_DEPRECATION_SECTIONS) {
    collectAnnotatedFields(normalized[section], section, schema, out);
  }
  collectFlatShape(normalized.tracker, "tracker", trackerRecordSchema, out);
  return out;
}

function collectAnnotatedFields(
  rawSection: unknown,
  section: string,
  schema: z.ZodObject,
  out: ConfigDeprecation[],
): void {
  if (!isRecord(rawSection)) return;
  const shape: Record<string, z.ZodType> = schema.def.shape;
  const note = sectionDeprecationNote(schema);
  for (const key of Object.keys(rawSection)) {
    const field = shape[key];
    if (!field) continue;
    const dep = fieldDeprecation(field);
    if (!dep) continue;
    out.push({
      configPath: `${section}.${toSnakeKey(key)}`,
      replacement: dep.replacement,
      detail: dep.detail ?? note,
    });
  }
}

function collectFlatShape(
  rawSection: unknown,
  section: string,
  schema: z.ZodObject,
  out: ConfigDeprecation[],
): void {
  if (!isRecord(rawSection)) return;
  const flat = flatShapeDeprecation(schema);
  if (!flat) return;
  const coreKeys = new Set(Object.keys(schema.def.shape));
  const bundle = suggestedBundleName(rawSection[flat.bundleNameKey]);
  for (const key of Object.keys(rawSection)) {
    if (coreKeys.has(key)) continue;
    out.push({
      configPath: `${section}.${toSnakeKey(key)}`,
      replacement: `${flat.replacementBundle}.${bundle}.${toSnakeKey(key)}`,
      detail: flat.note,
    });
  }
}

function suggestedBundleName(kind: unknown): string {
  return typeof kind === "string" && kind.trim() !== "" ? kind.trim() : "<name>";
}

function toSnakeKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export type WorkflowConfigRaw = z.infer<typeof workflowConfigSchema>;
export type WorkersRaw = z.infer<typeof workersRawSchema>;
export type TrackerRaw = z.infer<typeof trackerRawSchema>;
export type TrackersRaw = z.infer<typeof trackersRawSchema>;
export type TrackerRecordRaw = z.infer<typeof trackerRecordSchema>;
export type DispatchRaw = NonNullable<TrackerRecordRaw["dispatch"]>;
export type HooksRaw = z.infer<typeof hooksRawSchema>;
export type AgentRaw = z.infer<typeof agentRawSchema>;
export type AgentsRaw = z.infer<typeof agentsRawSchema>;
export type ToolsRaw = z.infer<typeof toolsRawSchema>;
export type CodexRaw = z.infer<typeof codexRawSchema>;
export type ClaudeRaw = z.infer<typeof claudeRawSchema>;
export type StatusOverridesRaw = NonNullable<WorkflowConfigRaw["statusOverrides"]>;
export type AgentRecordRaw = z.infer<typeof agentRecordSchema>;
export type AgentRecordOverrideRaw = z.infer<typeof agentRecordOverrideSchema>;
export type WorkerPoolRaw = z.infer<typeof workerPoolRawSchema>;
