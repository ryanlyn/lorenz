import type { RuntimeSnapshot } from "@symphony/runtime-events";
import type {
  AgentSession,
  AgentUpdate,
  Issue,
  Settings,
  WorkflowDefinition,
} from "@symphony/domain";

export interface TrackerPort {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByIds(ids: string[]): Promise<Issue[]>;
  fetchIssuesByStates(states: string[]): Promise<Issue[]>;
}

export interface AgentExecutorPort {
  kind: string;
  startSession(input: {
    workspace: string;
    workerHost?: string | null | undefined;
    issue?: Issue;
    settings: Settings;
    resumeId?: string | null;
    onUpdate?: (update: AgentUpdate) => void;
  }): Promise<AgentSession>;
  runTurn(session: AgentSession, prompt: string, issue?: Issue): Promise<AgentUpdate[]>;
}

export interface ClockPort {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface TimerHandle {
  unref?: (() => void) | undefined;
}

export const systemClock: ClockPort = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface WorkspacePort {
  create(settings: Settings, issue: Issue, workerHost?: string | null): Promise<string>;
  remove(settings: Settings, issueIdentifier: string, workerHost?: string | null): Promise<void>;
}

export interface WorkerHostPort {
  acquire(workerHost: string): Promise<WorkerHostLease>;
}

export interface WorkerHostLease {
  workerHost: string;
  release(): Promise<void>;
}

export interface McpPort {
  issueToken(): string;
  revokeToken(token: string | null | undefined): void;
}

export interface LogSinkPort {
  append(event: Record<string, unknown>): Promise<void>;
}

export interface ProjectionSinkPort {
  snapshot(workflow: WorkflowDefinition): RuntimeSnapshot;
}

export interface RemoteShellPort {
  run(
    host: string,
    command: string,
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string }>;
}
