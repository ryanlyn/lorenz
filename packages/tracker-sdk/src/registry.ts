import type { Settings } from "@lorenz/domain";

import type { TrackerProvider } from "./provider.js";

/**
 * Lookup table of {@link TrackerProvider}s keyed by provider name. The core resolves the
 * configured tracker through a registry instead of hardcoding backends, so the set of
 * supported trackers is decided by whoever composes the application.
 */
export class TrackerRegistry {
  private readonly providers = new Map<string, TrackerProvider>();

  /** Register a provider. Throws when a different provider already claims the kind. */
  register(provider: TrackerProvider): void {
    const kind = provider.kind.trim();
    if (!kind) throw new Error("tracker provider kind must not be blank");
    const existing = this.providers.get(kind);
    if (existing && existing !== provider) {
      throw new Error(`tracker provider already registered for kind: ${kind}`);
    }
    this.providers.set(kind, provider);
  }

  get(kind: string | undefined): TrackerProvider | undefined {
    return kind === undefined ? undefined : this.providers.get(kind);
  }

  /** Resolve the provider for parsed settings. */
  providerFor(settings: Settings): TrackerProvider | undefined {
    return this.get(settings.tracker.kind);
  }

  /** Like {@link get} but throws a config-style error listing the known kinds. */
  require(kind: string | undefined): TrackerProvider {
    if (kind === undefined || kind === null || kind === "") {
      throw new Error("tracker.kind is required");
    }
    const provider = this.providers.get(kind);
    if (!provider) {
      const known = this.kinds();
      const hint =
        known.length > 0
          ? ` (known kinds: ${known.join(", ")})`
          : " (no tracker providers registered - register tracker extensions at the composition root)";
      throw new Error(`unsupported tracker.kind: ${kind}${hint}`);
    }
    return provider;
  }

  kinds(): string[] {
    return [...this.providers.keys()].sort();
  }
}

/**
 * Process-wide registry used as the default by config parsing, the MCP server, and the CLI.
 * The composition root (the CLI entrypoint, or a test) registers providers here; library
 * code only reads from it. Call sites that need isolation can construct their own
 * {@link TrackerRegistry} and pass it explicitly.
 */
export const defaultTrackerRegistry = new TrackerRegistry();
