import type { WorkerDriverFactory } from "./types.js";

/**
 * Lookup table of {@link WorkerDriverFactory}s keyed by `worker.worker_pool.driver`.
 * The pool resolves the configured kind through a registry instead of
 * hardcoding backends, so the set of supported worker drivers is decided by
 * whoever composes the application.
 */
export class WorkerDriverRegistry {
  private readonly factories = new Map<string, WorkerDriverFactory>();

  /** Register a factory. Throws when a different factory already claims the kind. */
  register(factory: WorkerDriverFactory): void {
    const kind = factory.kind.trim();
    if (!kind) throw new Error("worker driver kind must not be blank");
    const existing = this.factories.get(kind);
    if (existing && existing !== factory) {
      throw new Error(`worker driver already registered for kind: ${kind}`);
    }
    this.factories.set(kind, factory);
  }

  get(kind: string | undefined): WorkerDriverFactory | undefined {
    return kind === undefined ? undefined : this.factories.get(kind);
  }

  /** Like {@link get} but throws a config-style error listing the known kinds. */
  require(kind: string | undefined): WorkerDriverFactory {
    if (kind === undefined || kind === null || kind === "") {
      throw new Error("worker.worker_pool.driver is required");
    }
    const factory = this.factories.get(kind);
    if (!factory) {
      const known = this.kinds();
      const hint =
        known.length > 0
          ? ` (known kinds: ${known.join(", ")})`
          : " (no worker drivers registered - register worker driver extensions at the composition root)";
      throw new Error(`worker_pool_driver_unavailable: ${kind}${hint}`);
    }
    return factory;
  }

  kinds(): string[] {
    return [...this.factories.keys()].sort();
  }
}

/**
 * Process-wide registry used as the default by the pool and the CLI. The
 * composition root (the CLI entrypoint, or a test) registers drivers here;
 * library code only reads from it. Call sites that need isolation can
 * construct their own {@link WorkerDriverRegistry} and pass it explicitly.
 */
export const defaultWorkerDriverRegistry = new WorkerDriverRegistry();
