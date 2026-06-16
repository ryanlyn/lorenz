import { errorMessage } from "@lorenz/domain";
import type { Settings } from "@lorenz/domain";

import type { ToolContext, ToolProvider, ToolResult, ToolSpec } from "./provider.js";
import { toolFailure, unsupportedToolFailure } from "./result.js";

/**
 * Lookup table of {@link ToolProvider}s keyed by pack name. The MCP server resolves the
 * active tracker's mounted packs through a registry instead of hardcoding tool surfaces, so
 * the set of mountable packs is decided by whoever composes the application.
 */
export class ToolRegistry {
  private readonly providers = new Map<string, ToolProvider>();

  /** Register a pack. Throws when a different pack already claims the name. */
  register(provider: ToolProvider): void {
    const name = provider.name.trim();
    if (!name) throw new Error("tool provider name must not be blank");
    const existing = this.providers.get(name);
    if (existing && existing !== provider) {
      throw new Error(`tool provider already registered for name: ${name}`);
    }
    this.providers.set(name, provider);
  }

  get(name: string | undefined): ToolProvider | undefined {
    return name === undefined ? undefined : this.providers.get(name);
  }

  /** Like {@link get} but throws a config-style error listing the known pack names. */
  require(name: string): ToolProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      const known = this.names();
      const hint =
        known.length > 0
          ? ` (known tool packs: ${known.join(", ")})`
          : " (no tool packs registered - register tool packs at the composition root)";
      throw new Error(`unsupported tool pack: ${name}${hint}`);
    }
    return provider;
  }

  names(): string[] {
    return [...this.providers.keys()].sort();
  }
}

/**
 * Process-wide registry used as the default by the MCP server and the CLI. The composition
 * root registers packs here; library code only reads from it. Call sites that need
 * isolation can construct their own {@link ToolRegistry} and pass it explicitly.
 */
export const defaultToolRegistry = new ToolRegistry();

/**
 * Specs advertised by a set of mounted packs. Throws when two packs declare the same tool
 * name: a mount is a single flat tool namespace, so collisions must fail loudly at mount
 * time rather than shadow each other per call.
 */
export function mountedToolSpecs(packs: readonly ToolProvider[], settings: Settings): ToolSpec[] {
  const owners = new Map<string, string>();
  const specs: ToolSpec[] = [];
  for (const pack of packs) {
    for (const spec of pack.toolSpecs(settings)) {
      const owner = owners.get(spec.name);
      if (owner !== undefined && owner !== pack.name) {
        throw new Error(
          `tool name collision: ${spec.name} is declared by both the "${owner}" and "${pack.name}" packs`,
        );
      }
      owners.set(spec.name, pack.name);
      specs.push(spec);
    }
  }
  return specs;
}

/**
 * Route one tool call to the mounted pack that declares it. Unknown names report the full
 * supported set; a throwing pack surfaces as a failed {@link ToolResult} (JSON-RPC
 * `isError`), never as a transport-level error.
 */
export async function executeMountedTool(
  packs: readonly ToolProvider[],
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  for (const pack of packs) {
    if (pack.toolSpecs(context.settings).some((spec) => spec.name === name)) {
      try {
        return await pack.executeTool(name, input, context);
      } catch (error) {
        return toolFailure(errorMessage(error));
      }
    }
  }
  const supported = packs.flatMap((pack) =>
    pack.toolSpecs(context.settings).map((spec) => spec.name),
  );
  return unsupportedToolFailure(name, supported);
}
