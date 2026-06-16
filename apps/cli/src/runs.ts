import { Command } from "commander";
import {
  commanderErrorMessage,
  configureCommandForParse,
  hasHelpFlag,
  parseNonNegativeInteger,
  parsePositiveInteger,
  parseRequiredValue,
  type ParseResult,
} from "@lorenz/cli-kit";
import { loadWorkflow } from "@lorenz/workflow";

export interface RunsCommandOptions {
  issue: string | null;
  failed: boolean;
  cost: boolean;
  retries: boolean;
  id: string | null;
  limit: number | null;
  url: string | null;
  port: number | null;
  json: boolean;
}

export interface RunsCommanderOptions {
  issue?: string;
  failed?: boolean;
  cost?: boolean;
  retries?: boolean;
  id?: string;
  limit?: number;
  url?: string;
  port?: number;
  json?: boolean;
}

export type RunsParseResult = ParseResult<RunsCommandOptions>;
export function createRunsCommand(name = "lorenz runs"): Command {
  return new Command(name)
    .description("Query Lorenz run history from the observability API.")
    .allowExcessArguments(false)
    .option("--issue <id>", "Filter by issue identifier.", parseRequiredValue("--issue"))
    .option("--failed", "Show failed runs.")
    .option("--cost", "Show token and cost summary.")
    .option("--retries", "Show retry summary by issue.")
    .option("--id <runId>", "Show one run and related attempts.", parseRequiredValue("--id"))
    .option("--limit <limit>", "Limit returned runs.", parsePositiveInteger("--limit"))
    .option("--url <url>", "Observability API base URL.", parseUrl)
    .option("--port <port>", "Observability API localhost port.", parseNonNegativeInteger("--port"))
    .option("--json", "Print raw JSON response.");
}

export function parseRunsArgs(args: string[]): RunsParseResult {
  const command = configureCommandForParse(createRunsCommand());
  if (hasHelpFlag(args)) return { status: "help", message: command.helpInformation().trimEnd() };

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    return { status: "error", message: commanderErrorMessage(error) };
  }

  return {
    status: "ok",
    options: runsOptionsFromCommanderOptions(command.opts<RunsCommanderOptions>()),
  };
}

export function runsOptionsFromCommanderOptions(parsed: RunsCommanderOptions): RunsCommandOptions {
  return {
    issue: parsed.issue ?? null,
    failed: parsed.failed ?? false,
    cost: parsed.cost ?? false,
    retries: parsed.retries ?? false,
    id: parsed.id ?? null,
    limit: parsed.limit ?? null,
    url: parsed.url ?? null,
    port: parsed.port ?? null,
    json: parsed.json ?? false,
  };
}

export async function runRunsMain(args: string[]): Promise<string> {
  const parsed = parseRunsArgs(args);
  if (parsed.status === "help") return `${parsed.message}\n`;
  if (parsed.status === "error") throw new Error(parsed.message);
  return runRunsCommand(parsed.options);
}

export async function runRunsCommand(options: RunsCommandOptions): Promise<string> {
  const url = await runsUrl(options);
  const response = await fetch(url);
  const body = (await response.json()) as Record<string, unknown>;

  if (response.status === 200) return renderOutput(body, options.json);
  if (response.status === 404) throw new Error(errorMessage(body, "Run not found"));
  if (response.status === 503) throw new Error(errorMessage(body, "Observability API unavailable"));
  throw new Error(`Unexpected response status ${response.status}`);
}

async function runsUrl(options: RunsCommandOptions): Promise<string> {
  const resolvedBaseUrl = await resolveBaseUrl(options);
  const params = new URLSearchParams();
  if (options.issue) params.set("issue", options.issue);
  if (options.failed) params.set("failed", "true");
  if (options.cost) params.set("cost", "true");
  if (options.retries) params.set("retries", "true");
  if (options.id) params.set("id", options.id);
  if (options.limit !== null) params.set("limit", String(options.limit));
  const query = params.toString();
  return `${resolvedBaseUrl}/api/v1/runs${query ? `?${query}` : ""}`;
}

async function resolveBaseUrl(options: RunsCommandOptions): Promise<string> {
  if (options.url) return trimTrailingSlash(options.url);
  const workflow = await loadWorkflow();
  if (options.port !== null && options.port > 0)
    return `http://${workflow.settings.server.host}:${options.port}`;
  const port = workflow.settings.server.port;
  if (typeof port === "number" && port > 0)
    return `http://${workflow.settings.server.host}:${port}`;
  throw new Error(
    "No observability server port configured. Pass --port/--url or set server.port in WORKFLOW.md.",
  );
}

function renderOutput(body: Record<string, unknown>, json: boolean): string {
  if (json) return `${JSON.stringify(body, null, 2)}\n`;
  const view = stringField(body, "view");
  if (view === "run") return renderRun(body);
  if (view === "cost") return renderCost(body);
  if (view === "retries") return renderRetries(body);
  if (view === "runs") return renderRuns(body);
  return `${JSON.stringify(body, null, 2)}\n`;
}

function renderRun(body: Record<string, unknown>): string {
  const run = recordField(body, "run");
  const lines = [
    `Run ${stringField(run, "id")}`,
    "",
    `issue=${stringField(run, "issue_identifier")} agent=${stringField(run, "agent_kind")} outcome=${stringField(run, "outcome")} attempt=${numberField(run, "retry_attempt")}`,
    `duration=${formatDuration(numberOrNull(run, "duration_ms"))} tokens=${formatInteger(tokenTotal(run))} turns=${numberField(run, "turn_count")}`,
    `session=${stringField(run, "session_id") || "n/a"} worker=${stringField(run, "worker_host") || "local"}`,
    `workspace=${stringField(run, "workspace_path") || "n/a"}`,
    `last_event=${stringField(run, "last_event") || "n/a"} at=${stringField(run, "last_event_at") || "n/a"}`,
    `failure_reason=${stringField(run, "failure_reason") || "n/a"}`,
    `log_file=${stringField(recordField(run, "log_hints"), "lorenz_log_file") || "n/a"}`,
  ];
  const related = arrayField(body, "related_runs");
  if (related.length === 0) return `${lines.join("\n")}\n`;
  return `${[
    ...lines,
    "",
    "Related runs",
    renderTable(
      ["ID", "OUTCOME", "TOKENS", "STARTED"],
      related.map((item) => {
        const relatedRun = asRecord(item);
        return [
          stringField(relatedRun, "id"),
          stringField(relatedRun, "outcome"),
          formatInteger(tokenTotal(relatedRun)),
          stringField(relatedRun, "started_at") || "n/a",
        ];
      }),
    ),
  ].join("\n")}\n`;
}

function renderCost(body: Record<string, unknown>): string {
  const summary = recordField(body, "summary");
  const byAgent = arrayField(summary, "by_agent");
  const topRuns = arrayField(summary, "top_runs");
  return `${[
    "Cost Summary",
    "",
    renderTable(
      ["AGENT", "RUNS", "DONE", "INPUT", "OUTPUT", "TOTAL", "AVG/RUN", "USD"],
      byAgent.map((item) => {
        const row = asRecord(item);
        return [
          stringField(row, "agent_kind"),
          formatInteger(numberField(row, "run_count")),
          formatInteger(numberField(row, "completed_count")),
          formatInteger(numberField(row, "input_tokens")),
          formatInteger(numberField(row, "output_tokens")),
          formatInteger(numberField(row, "total_tokens")),
          formatFloat(numberField(row, "average_total_tokens_per_run")),
          formatCost(numberOrNull(row, "estimated_cost_usd")),
        ];
      }),
    ),
    "",
    "Top Runs",
    renderTable(
      ["ID", "ISSUE", "AGENT", "OUTCOME", "TOKENS"],
      topRuns.map((item) => {
        const run = asRecord(item);
        return [
          stringField(run, "id"),
          stringField(run, "issue_identifier"),
          stringField(run, "agent_kind"),
          stringField(run, "outcome"),
          formatInteger(tokenTotal(run)),
        ];
      }),
    ),
  ].join("\n")}\n`;
}

function renderRetries(body: Record<string, unknown>): string {
  const issues = arrayField(body, "issues");
  return `${[
    "Retry Summary",
    "",
    renderTable(
      ["ISSUE", "ATTEMPTS", "LATEST", "TOKENS", "RUN ID", "FAILURE"],
      issues.map((item) => {
        const issue = asRecord(item);
        return [
          stringField(issue, "issue_identifier"),
          formatInteger(numberField(issue, "attempts")),
          stringField(issue, "latest_outcome"),
          formatInteger(numberField(issue, "total_tokens")),
          stringField(issue, "latest_run_id"),
          stringField(issue, "latest_failure_reason") || "n/a",
        ];
      }),
    ),
  ].join("\n")}\n`;
}

function renderRuns(body: Record<string, unknown>): string {
  const summary = recordField(body, "summary");
  const runs = arrayField(body, "runs");
  return `${[
    "Run History",
    "",
    `total=${numberField(summary, "total")} running=${numberField(summary, "running")} success=${numberField(summary, "success")} failed=${numberField(summary, "failed")} stalled=${numberField(summary, "stalled")} canceled=${numberField(summary, "canceled")}`,
    "",
    renderTable(
      ["ID", "ISSUE", "AGENT", "OUTCOME", "ATTEMPT", "TURNS", "TOKENS", "DURATION", "SESSION"],
      runs.map((item) => {
        const run = asRecord(item);
        return [
          stringField(run, "id"),
          stringField(run, "issue_identifier"),
          stringField(run, "agent_kind"),
          stringField(run, "outcome"),
          formatInteger(numberField(run, "retry_attempt")),
          formatInteger(numberField(run, "turn_count")),
          formatInteger(tokenTotal(run)),
          formatDuration(numberOrNull(run, "duration_ms")),
          compact(stringField(run, "session_id")),
        ];
      }),
    ),
  ].join("\n")}\n`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  return [
    formatRow(headers, widths),
    formatRow(
      widths.map((width) => "-".repeat(width)),
      widths,
    ),
    ...rows.map((row) => formatRow(row, widths)),
  ].join("\n");
}

function formatRow(columns: string[], widths: number[]): string {
  return columns.map((column, index) => column.padEnd(widths[index] ?? 0)).join("  ");
}

function errorMessage(body: Record<string, unknown>, fallback: string): string {
  return stringField(recordField(body, "error"), "message") || fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(record[key]);
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(record[key]) ? record[key] : [];
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOrNull(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tokenTotal(run: Record<string, unknown>): number {
  return numberField(recordField(run, "tokens"), "total_tokens");
}

function formatInteger(value: number): string {
  return String(Math.round(value));
}

function formatFloat(value: number): string {
  return value.toFixed(1);
}

function formatCost(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(4)}`;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "n/a";
  if (durationMs >= 1000) return `${Math.floor(durationMs / 1000)}s`;
  return `${durationMs}ms`;
}

function compact(value: string): string {
  if (!value) return "n/a";
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-5)}` : value;
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function parseUrl(value: string): string {
  return trimTrailingSlash(parseRequiredValue("--url")(value));
}
