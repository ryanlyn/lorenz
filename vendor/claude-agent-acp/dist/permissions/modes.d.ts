import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
interface PermissionModeLogger {
    error: (...args: unknown[]) => void;
}
export declare const ALLOW_BYPASS: boolean;
/** When `allowBypass` is false, `bypassPermissions` clamps to `default` so the SDK
 *  is never spawned in a mode it would reject. */
export declare function resolvePermissionMode(defaultMode?: unknown, logger?: PermissionModeLogger, allowBypass?: boolean): PermissionMode;
export {};
//# sourceMappingURL=modes.d.ts.map
