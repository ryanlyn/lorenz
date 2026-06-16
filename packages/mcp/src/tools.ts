import type { Settings } from "@lorenz/domain";
import {
  defaultToolRegistry,
  executeMountedTool,
  mountedToolSpecs,
  type ToolProvider,
  type ToolRegistry,
  type ToolResult,
  type ToolSpec,
} from "@lorenz/tool-sdk";
import { defaultTrackerRegistry, type TrackerRegistry } from "@lorenz/tracker-sdk";

export type { ToolResult, ToolSpec } from "@lorenz/tool-sdk";

/** The provider-neutral pack mounted for every tracker backend. */
const NEUTRAL_PACK = "tracker";

/**
 * Tool packs mounted for the given settings: the neutral tracker pack, the dispatch
 * tracker's declared default packs, plus any extra packs explicitly configured by the
 * workflow's `tools:` map.
 */
function mountedPacks(
  settings: Settings,
  registry: ToolRegistry = defaultToolRegistry,
  trackers: TrackerRegistry = defaultTrackerRegistry,
): ToolProvider[] {
  const names = mountedPackNames(settings, registry, trackers);
  return names.map((name) => registry.require(name));
}

function mountedPackNames(
  settings: Settings,
  registry: ToolRegistry,
  trackers: TrackerRegistry,
): string[] {
  const names = new Set<string>();
  if (registry.get(NEUTRAL_PACK) !== undefined) names.add(NEUTRAL_PACK);

  const tracker = trackers.get(settings.tracker.kind);
  const defaultPacks = tracker?.defaultToolPacks?.(settings);
  if (defaultPacks !== undefined) {
    for (const pack of defaultPacks) names.add(pack);
  } else {
    const kind = settings.tracker.kind;
    if (kind !== undefined && kind !== NEUTRAL_PACK && registry.get(kind) !== undefined) {
      names.add(kind);
    }
  }

  for (const pack of Object.keys(settings.toolOptions ?? {})) {
    names.add(pack);
  }
  return [...names];
}

/** Tools advertised over the MCP endpoint for the mounted packs. */
export function toolSpecs(
  settings: Settings,
  registry: ToolRegistry = defaultToolRegistry,
  trackers: TrackerRegistry = defaultTrackerRegistry,
): ToolSpec[] {
  return mountedToolSpecs(mountedPacks(settings, registry, trackers), settings);
}

/**
 * Skill directories bundled by the mounted tool packs, in mount order and de-duplicated.
 * The composition root unions these with the configured `agent.skills` before overlaying
 * them into a prepared workspace, so enabling a tool also ships its companion skill.
 */
export function mountedSkillSources(
  settings: Settings,
  registry: ToolRegistry = defaultToolRegistry,
  trackers: TrackerRegistry = defaultTrackerRegistry,
): string[] {
  const seen = new Set<string>();
  for (const pack of mountedPacks(settings, registry, trackers)) {
    for (const skill of pack.skills ?? []) seen.add(skill);
  }
  return [...seen];
}

export async function executeTool(
  name: string,
  input: unknown,
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
  registry: ToolRegistry = defaultToolRegistry,
  trackers: TrackerRegistry = defaultTrackerRegistry,
): Promise<ToolResult> {
  return executeMountedTool(mountedPacks(settings, registry, trackers), name, input, {
    settings,
    fetchImpl,
  });
}
