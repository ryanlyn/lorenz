import type { Query } from "@anthropic-ai/claude-agent-sdk";
export declare const AGENT_FILE_CHANGE_REPORT_CAPABILITY = "agentFileChangeReport";
export declare const AGENT_FILE_CHANGE_REPORT_MAX_BYTES: number;
export declare const AGENT_FILE_CHANGE_REPORT_TIMEOUT_MS = 2000;
export type FileChangeReportTurnState = {
    requestId: string;
    phase: "requested" | "collecting" | "finished";
};
export type NativeFileChangeReportTurn = {
    promptUuid: string;
    fileChangeReport?: FileChangeReportTurnState;
};
export type FileChangeReportWorkspace = {
    cwd: string;
    additionalDirectories: string[];
};
export type AgentFileChangeReportResult = {
    version: 1;
    requestId: string;
} & ({
    status: "reported";
    paths: string[];
    declaredComplete: boolean;
    truncated: boolean;
} | {
    status: "unavailable";
    reason: FileChangeReportUnavailableReason;
});
export type FileChangeReportUnavailableReason = "cancelled" | "timeout" | "invalidOutput" | "notReported" | "providerError";
type NativeFileChangeReporterOptions = {
    cwd: string;
    additionalDirectories: string[];
    publish: (result: AgentFileChangeReportResult) => Promise<void>;
    logError: (message: string) => void;
    timeoutMs?: number;
};
export type NativeFileChangeReporter = {
    request(meta: unknown): FileChangeReportTurnState | undefined;
    report(turn: NativeFileChangeReportTurn | null | undefined, query: Pick<Query, "rewindFiles">): Promise<void>;
    finish(state: FileChangeReportTurnState | undefined, reason: FileChangeReportUnavailableReason): void;
};
export declare function agentFileChangeReportRequestId(meta: unknown): string | undefined;
export declare function supportsAgentFileChangeReport(capabilities: unknown): boolean;
export declare function agentFileChangeReportMeta(result: AgentFileChangeReportResult): Record<string, unknown>;
export declare function createNativeFileChangeReporter(options: NativeFileChangeReporterOptions): NativeFileChangeReporter;
export {};
//# sourceMappingURL=file-change-audit.d.ts.map
