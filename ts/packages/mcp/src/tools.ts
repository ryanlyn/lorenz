import type { Settings } from "@symphony/domain";
import {
  defaultToolRegistry,
  executeMountedTool,
  mountedToolSpecs,
  type ToolProvider,
  type ToolRegistry,
  type ToolResult,
  type ToolSpec,
} from "@symphony/tool-sdk";

export type { ToolResult, ToolSpec } from "@symphony/tool-sdk";

/** The provider-neutral pack mounted for every tracker backend. */
const NEUTRAL_PACK = "tracker";

/**
 * Tool packs mounted for the given settings: the explicit `tools:` list when configured,
 * otherwise the neutral tracker pack plus the dispatch tracker's own pack when one is
 * registered. Several packs can serve one endpoint while a single tracker drives dispatch.
 * Unknown pack names fail loudly with the list of registered packs.
 */
function mountedPacks(
  settings: Settings,
  registry: ToolRegistry = defaultToolRegistry,
): ToolProvider[] {
  const names = settings.tools ?? defaultPackNames(settings, registry);
  return names.map((name) => registry.require(name));
}

function defaultPackNames(settings: Settings, registry: ToolRegistry): string[] {
  const names = [NEUTRAL_PACK];
  const kind = settings.tracker.kind;
  if (kind !== undefined && kind !== NEUTRAL_PACK && registry.get(kind) !== undefined) {
    names.push(kind);
  }
  return names;
}

/** Tools advertised over the Symphony MCP endpoint for the mounted packs. */
export function toolSpecs(
  settings: Settings,
  registry: ToolRegistry = defaultToolRegistry,
): ToolSpec[] {
  return mountedToolSpecs(mountedPacks(settings, registry), settings);
}

export async function executeTool(
  name: string,
  input: unknown,
  settings: Settings,
  fetchImpl: typeof fetch = fetch,
  registry: ToolRegistry = defaultToolRegistry,
): Promise<ToolResult> {
  return executeMountedTool(mountedPacks(settings, registry), name, input, {
    settings,
    fetchImpl,
  });
}
