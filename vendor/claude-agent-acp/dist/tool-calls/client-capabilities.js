import { AIR_DIFF_PATCH_CAPABILITY, AIR_PLAN_FILE_CAPABILITY, AIR_RAW_INPUT_RENDERING_CAPABILITY, clientSupportsAirCapability, isAirClient, } from "../air-extension.js";
/**
 * The client choices that decide the shape of a tool call report.
 *
 * The agent reads them once from `initialize.clientCapabilities`. The public
 * `toAcpNotifications` functions take the ACP capabilities and read them on
 * each call. The {@link AcpToolCallRenderer} reads nothing else, so one object
 * holds every capability choice of a tool call report.
 */
export class ClientCapabilities {
    terminalOutput;
    terminalOutputDelta;
    diffPatch;
    air;
    constructor(
    /** The client renders a terminal from `_meta.terminal_info`, `terminal_output`, and `terminal_exit`. */
    terminalOutput = false,
    /** The client appends `_meta.terminal_output_delta` instead of `terminal_output` chunks. */
    terminalOutputDelta = false,
    /** The client accepts an exact git patch in a diff (`jetbrains.air` `diffPatch`). */
    diffPatch = false,
    /** The capabilities that only JetBrains AIR declares. */
    air = NO_AIR) {
        this.terminalOutput = terminalOutput;
        this.terminalOutputDelta = terminalOutputDelta;
        this.diffPatch = diffPatch;
        this.air = air;
    }
    static from(capabilities) {
        const meta = capabilities?._meta;
        const terminalOutputDelta = meta?.["terminal_output_delta"] === true;
        return new ClientCapabilities(terminalOutputDelta || meta?.["terminal_output"] === true, terminalOutputDelta, clientSupportsAirCapability(capabilities, AIR_DIFF_PATCH_CAPABILITY), {
            client: isAirClient(capabilities),
            rawInputRendering: clientSupportsAirCapability(capabilities, AIR_RAW_INPUT_RENDERING_CAPABILITY),
            planFile: clientSupportsAirCapability(capabilities, AIR_PLAN_FILE_CAPABILITY),
        });
    }
}
const NO_AIR = {
    client: false,
    rawInputRendering: false,
    planFile: false,
};
