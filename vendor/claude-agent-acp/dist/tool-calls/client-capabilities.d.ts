import type { ClientCapabilities as AcpClientCapabilities } from "@agentclientprotocol/sdk";
/**
 * The client choices that decide the shape of a tool call report.
 *
 * The agent reads them once from `initialize.clientCapabilities`. The public
 * `toAcpNotifications` functions take the ACP capabilities and read them on
 * each call. The {@link AcpToolCallRenderer} reads nothing else, so one object
 * holds every capability choice of a tool call report.
 */
export declare class ClientCapabilities {
    /** The client renders a terminal from `_meta.terminal_info`, `terminal_output`, and `terminal_exit`. */
    readonly terminalOutput: boolean;
    /** The client appends `_meta.terminal_output_delta` instead of `terminal_output` chunks. */
    readonly terminalOutputDelta: boolean;
    /** The client accepts an exact git patch in a diff (`jetbrains.air` `diffPatch`). */
    readonly diffPatch: boolean;
    /** The capabilities that only JetBrains AIR declares. */
    readonly air: AirCapabilities;
    constructor(
    /** The client renders a terminal from `_meta.terminal_info`, `terminal_output`, and `terminal_exit`. */
    terminalOutput?: boolean,
    /** The client appends `_meta.terminal_output_delta` instead of `terminal_output` chunks. */
    terminalOutputDelta?: boolean,
    /** The client accepts an exact git patch in a diff (`jetbrains.air` `diffPatch`). */
    diffPatch?: boolean,
    /** The capabilities that only JetBrains AIR declares. */
    air?: AirCapabilities);
    static from(capabilities: AcpClientCapabilities | null | undefined): ClientCapabilities;
}
/** The capabilities of JetBrains AIR, read from `_meta.jetbrains.air`. */
export interface AirCapabilities {
    /**
     * The client declared `_meta.jetbrains.air`. Only then does a report follow
     * the tool call contract of `docs/air-extensions.md`. Every other client
     * gets the fields of the upstream adapter, and only the unchanged fields of
     * an update are left out.
     */
    readonly client: boolean;
    /**
     * AIR renders `rawInput` itself. A tool call report for AIR then carries no
     * display copy of the input in `content`.
     */
    readonly rawInputRendering: boolean;
    /**
     * AIR reads the plan of an ExitPlanMode from the file that
     * `rawInput.planFilePath` names. A report then carries the path and not the
     * plan text, when the plan file exists.
     */
    readonly planFile: boolean;
}
//# sourceMappingURL=client-capabilities.d.ts.map
