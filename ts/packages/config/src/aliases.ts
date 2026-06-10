import { isRecord as isPlainRecord } from "@symphony/domain";

const trackerAliases = {
  api_key: "apiKey",
  project_slug: "projectSlug",
  id_prefix: "idPrefix",
  project_slugs: "projectSlugs",
  project_labels: "projectLabels",
  active_states: "activeStates",
  terminal_states: "terminalStates",
};
const dispatchAliases = {
  accept_unrouted: "acceptUnrouted",
  only_routes: "onlyRoutes",
  route_label_prefix: "routeLabelPrefix",
};
const pollingAliases = { interval_ms: "intervalMs" };
const workspaceAliases = {};
const workerAliases = {
  ssh_hosts: "sshHosts",
  ssh_timeout_ms: "sshTimeoutMs",
  max_concurrent_agents_per_host: "maxConcurrentAgentsPerHost",
  box_pool: "boxPool",
};
// NOTE: providerOptions (provider_options) is renamed at the box_pool level only;
// the normalizer is a flat per-key map that does not recurse into nested maps, so
// the CONTENTS of provider_options pass through to providers verbatim (snake_case
// preserved). StaticSshBoxProvider therefore accepts both ssh_hosts and sshHosts.
const boxPoolAliases = {
  max_in_flight: "maxInFlight",
  ttl_ms: "ttlMs",
  idle_reap_ms: "idleReapMs",
  acquire_timeout_ms: "acquireTimeoutMs",
  reap_interval_ms: "reapIntervalMs",
  stale_heartbeat_ms: "staleHeartbeatMs",
  drain_deadline_ms: "drainDeadlineMs",
  max_boxes_per_issue: "maxBoxesPerIssue",
  co_residence: "coResidence",
  max_concurrent_tunnels: "maxConcurrentTunnels",
  provider_options: "providerOptions",
};
const boxPoolSpendAliases = {
  max_concurrent_boxes: "maxConcurrentBoxes",
  max_box_seconds: "maxBoxSeconds",
  daily_box_seconds: "dailyBoxSeconds",
};
export const hooksAliases = {
  after_create: "afterCreate",
  before_run: "beforeRun",
  after_run: "afterRun",
  before_remove: "beforeRemove",
  timeout_ms: "timeoutMs",
};
const agentAliases = {
  max_concurrent_agents: "maxConcurrentAgents",
  max_turns: "maxTurns",
  max_retry_backoff_ms: "maxRetryBackoffMs",
  ensemble_size: "ensembleSize",
};
const agentsAliases = {
  turn_timeout_ms: "turnTimeoutMs",
  stall_timeout_ms: "stallTimeoutMs",
};
const codexAliases = {
  turn_timeout_ms: "turnTimeoutMs",
  stall_timeout_ms: "stallTimeoutMs",
};
const claudeAliases = {
  turn_timeout_ms: "turnTimeoutMs",
  stall_timeout_ms: "stallTimeoutMs",
  strict_mcp_config: "strictMcpConfig",
  provider_config: "providerConfig",
};
const acpAgentAliases = {
  bridge_command: "bridgeCommand",
  usage_accounting: "usageAccounting",
  provider_config: "providerConfig",
};
const agentRecordAliases = {
  ...codexAliases,
  ...claudeAliases,
  ...acpAgentAliases,
};
const observabilityAliases = {
  dashboard_enabled: "dashboardEnabled",
  refresh_ms: "refreshMs",
  render_interval_ms: "renderIntervalMs",
};
const loggingAliases = { log_file: "logFile" };

export function normalizeWorkflowConfig(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  const raw = normalizeAliases(value, { status_overrides: "statusOverrides" });
  const normalized: Record<string, unknown> = { ...raw };

  normalizeNested(normalized, "tracker", trackerAliases);
  normalizeNested(normalized, "polling", pollingAliases);
  normalizeNested(normalized, "workspace", workspaceAliases);
  normalizeNested(normalized, "worker", workerAliases);
  normalizeNested(normalized, "hooks", hooksAliases);
  normalizeNested(normalized, "agent", agentAliases);
  normalizeNested(normalized, "agents", agentsAliases);
  normalizeNested(normalized, "codex", codexAliases);
  normalizeNested(normalized, "claude", claudeAliases);
  normalizeNested(normalized, "observability", observabilityAliases);
  normalizeNested(normalized, "server", {});
  normalizeNested(normalized, "logging", loggingAliases);

  if (isPlainRecord(normalized.tracker)) {
    normalizeNested(normalized.tracker, "dispatch", dispatchAliases);
  }
  if (isPlainRecord(normalized.worker)) {
    normalizeNested(normalized.worker, "boxPool", boxPoolAliases);
    if (isPlainRecord(normalized.worker.boxPool)) {
      normalizeNested(normalized.worker.boxPool, "spend", boxPoolSpendAliases);
    }
  }
  if (isPlainRecord(normalized.agents)) {
    normalized.agents = Object.fromEntries(
      Object.entries(normalized.agents).map(([name, agent]) => [
        name,
        isPlainRecord(agent) ? normalizeAliases(agent, agentRecordAliases) : agent,
      ]),
    );
  }
  if (isPlainRecord(normalized.statusOverrides)) {
    normalized.statusOverrides = Object.fromEntries(
      Object.entries(normalized.statusOverrides).map(([state, override]) => {
        if (!isPlainRecord(override)) return [state, override];
        const normalizedOverride: Record<string, unknown> = { ...override };
        normalizeNested(normalizedOverride, "agent", agentAliases);
        normalizeNested(normalizedOverride, "codex", codexAliases);
        normalizeNested(normalizedOverride, "claude", claudeAliases);
        return [state, normalizedOverride];
      }),
    );
  }
  return normalized;
}

function normalizeNested(
  raw: Record<string, unknown>,
  key: string,
  aliases: Record<string, string>,
): void {
  if (isPlainRecord(raw[key])) raw[key] = normalizeAliases(raw[key], aliases);
}

function normalizeAliases(
  raw: Record<string, unknown>,
  aliases: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (Object.prototype.hasOwnProperty.call(raw, alias)) {
      out[canonical] = raw[alias];
      delete out[alias];
    }
  }
  return out;
}
