import { ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk";
import { ContextCompactionMetadata } from "./context-compaction-meta.js";
type CompactionStatus = "completed" | "failed";
/**
 * How compaction reaches the client.
 *
 * - `compaction_update`: the ACP session-compaction contract (ID-addressed
 *   `compaction_update` / `compaction_summary_chunk`), used when the v1 client
 *   advertises `clientCapabilities.session.compaction`.
 * - `tool_call`: the legacy synthetic "Compact conversation" tool call, kept
 *   for clients that do not advertise the capability.
 */
export type CompactionPresentation = "tool_call" | "compaction_update";
type SendUpdate = (notification: SessionNotification) => Promise<void>;
export type ContextCompactionLifecycleOptions = {
    sessionId: string;
    presentation?: CompactionPresentation;
    /** Receives failures of the send that must not propagate: the turn-boundary
     *  `cancelled` terminal. */
    logError?: (message: string, error: unknown) => void;
    /** The client is AIR. Only AIR gets the compaction facts, under `_meta.jetbrains.air`. */
    airClient?: boolean;
};
export declare function clientSupportsCompactionUpdates(capabilities?: ClientCapabilities | null): boolean;
/**
 * Reduce Claude's compaction output to the user-displayable summary.
 *
 * The PostCompact hook reports the model's raw output, which wraps the
 * summary in `<summary>` tags (often preceded by an `<analysis>` block). The
 * persisted transcript instead frames the same summary with continuation
 * instructions for the model. Neither framing belongs in the ACP `summary`,
 * and a continuation prompt whose framing is not recognized yields no summary
 * at all rather than model-facing instructions.
 */
export declare function compactionSummaryText(raw: string): string | undefined;
/** True for the post-compaction user message Claude Code persists (and
 *  `getSessionMessages` returns) with the summary of the dropped history. */
export declare function isCompactSummaryMessage(message: unknown): boolean;
/**
 * Translates Claude's compaction signals into one idempotent ACP lifecycle.
 *
 * The SDK can duplicate terminal compact_result messages and can omit the
 * opening status on replay. State therefore lives until the owning turn's
 * result (or abort), while a new compacting status after a terminal outcome
 * starts a fresh lifecycle.
 */
export declare class ContextCompactionLifecycle {
    private readonly sendUpdate;
    private activeCompaction;
    private outputDelivered;
    private duplicateErrorOutput;
    /** After interruption, uncorrelated terminal frames and hooks may still
     *  arrive from the abandoned work, including an opening we never consumed.
     *  Wait for a known new turn before accepting them again. */
    private interrupted;
    /** Summary reported by PostCompact before the opening status was consumed.
     *  Deliberately survives `reset()`: the CLI awaits the hook before emitting
     *  the compaction's terminal frames, so a pending summary always belongs to
     *  a compaction whose frames are still ahead of the consumer — possibly
     *  queued behind a previous turn's result. */
    private pendingSummary;
    private readonly sessionId;
    readonly presentation: CompactionPresentation;
    private readonly logError;
    private readonly airClient;
    constructor(sendUpdate: SendUpdate, options: ContextCompactionLifecycleOptions);
    get hasDeliveredOutput(): boolean;
    /**
     * Close the lifecycle at a turn boundary (result, cancel, idle-abandon).
     *
     * A `compaction_update` entity still `in_progress` here never received its
     * terminal signal from the runtime and gets its one terminal status,
     * `cancelled`. The legacy tool call is deliberately left as it was (an
     * `in_progress` call): ACP `ToolCallStatus` has no cancelled state and that
     * presentation's behavior predates this lifecycle. Never throws — a failed
     * send is logged, so callers can settle the turn unconditionally.
     */
    reset(): Promise<void>;
    /** Abandon the current work before settling its prompt or tearing down the
     *  stream. Unlike a normal result boundary, its pending hooks are not safe
     *  to carry into the next compaction. A hook has no command ID, so even an
     *  early hook for the next compaction must be omitted until the stream gives
     *  us a new live turn boundary. Idempotent and best-effort. */
    interrupt(): Promise<void>;
    /** A live command's dispatch/echo proves the interrupted command's tail
     *  has drained in the SDK's FIFO stream. Do not reset normal lifecycle
     *  state: compaction may already have started before the user echo. */
    resume(): void;
    /**
     * Claude also emits a failed manual compaction's error as local-command
     * stdout. Consume that one duplicate after the lifecycle carried it,
     * without hiding unrelated command output.
     */
    consumeDuplicateErrorOutput(content: string): boolean;
    start(compactionId: string): Promise<void>;
    /**
     * Streaming progress from the API's compaction content block.
     *
     * Under `compaction_update` the block's text is the retained summary and
     * streams as `compaction_summary_chunk`s — but only into an entity the CLI
     * announced with its `compacting` status. The block alone carries no
     * terminal signal, so opening an entity from it would leave nothing but the
     * turn-boundary `cancelled` to close a compaction that succeeded. The legacy
     * tool call keeps its historical behavior: open on first sight, re-assert
     * `in_progress` once.
     */
    heartbeat(fallbackId: string, summaryChunk?: string): Promise<void>;
    /**
     * The PostCompact hook's summary. The CLI awaits the hook before emitting
     * the compaction's terminal frames, so the summary lands while its
     * compaction is `in_progress` and rides on the terminal update. Anything
     * else — no entity yet, or the entity is a previous, already-terminal
     * compaction of the same turn whose status frame the consumer is still
     * catching up to — belongs to the compaction whose frames are ahead of the
     * consumer, and waits for it. Only the `compaction_update` presentation
     * carries the summary; the legacy tool call never exposed it. Never throws:
     * it runs detached from a hook callback. Returns whether a summary was
     * retained.
     */
    recordSummary(rawSummary: unknown): boolean;
    finish(compactionId: string, status: CompactionStatus, metadata?: Omit<ContextCompactionMetadata, "version">, enrichTerminal?: boolean): Promise<void>;
    /** Make `compactionId` the active entity, moving a pending hook summary onto
     *  it, and mark compaction output as delivered for the owning turn. */
    private open;
    private send;
    private sendQuietly;
}
export declare function contextCompactionMetadataFromBoundary(compactMetadata: {
    trigger: "manual" | "auto";
    pre_tokens: number;
    post_tokens?: number;
    duration_ms?: number;
}): Omit<ContextCompactionMetadata, "version">;
export {};
//# sourceMappingURL=context-compaction.d.ts.map
