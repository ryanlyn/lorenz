import { settingsForIssueState } from "@symphony/config";
import { issueIsActive } from "@symphony/dispatch";
import { ensembleSize } from "@symphony/issue";
import { buildPrompt, continuationPrompt } from "@symphony/prompt";
import type {
  AgentExecutor,
  AgentSession,
  AgentUpdate,
  Issue,
  Settings,
  WorkflowDefinition,
} from "@symphony/domain";

interface ResumeStateShape {
  agentKind: string;
  resumeId: string;
  sessionId?: string | null | undefined;
  issueId?: string | null | undefined;
  issueIdentifier?: string | null | undefined;
  issueState?: string | null | undefined;
  workspacePath?: string | null | undefined;
  workerHost?: string | null | undefined;
}

type ResumeReadResult =
  | { status: "missing" }
  | { status: "unavailable" }
  | { status: "error"; reason: string }
  | { status: "ok"; state: ResumeStateShape };

export interface RunAgentAttemptAdapters {
  createWorkspaceForIssue(
    settings: Settings,
    issue: Issue,
    options: { slotIndex: number; ensembleSize: number; workerHost: string | null },
  ): Promise<string>;
  runHook(
    command: string,
    workspace: string,
    hooks: Settings["hooks"],
    workerHost: string | null,
  ): Promise<void>;
  readResumeState(
    workspace: string,
    workerHost?: string | null,
    timeoutMs?: number,
  ): Promise<ResumeReadResult>;
  resumeStateMatches(
    state: ResumeStateShape,
    input: { agentKind: string; issue: Issue; workspacePath: string; workerHost: string | null },
  ): boolean;
  writeResumeState(
    workspace: string,
    state: ResumeStateShape,
    workerHost: string | null,
    timeoutMs: number,
  ): Promise<void>;
  executorFactory(settings: Settings): Promise<AgentExecutor> | AgentExecutor;
}

export interface RunResult {
  workspace: string;
  turnCount: number;
  updates: AgentUpdate[];
  resumeId?: string | null | undefined;
  agentKind: string;
  finalIssue?: Issue | undefined;
}

export interface RunAgentAttemptInput {
  issue: Issue;
  workflow: WorkflowDefinition;
  settings?: Settings;
  workerHost?: string | null;
  slotIndex?: number;
  attempt?: number | null;
  onUpdate?: (update: AgentUpdate) => void;
  fetchIssue?: (issue: Issue) => Promise<Issue>;
  abortSignal?: AbortSignal | undefined;
  adapters?: Partial<RunAgentAttemptAdapters> | undefined;
}

export async function runAgentAttempt(input: RunAgentAttemptInput): Promise<RunResult> {
  return new RunController(input).run();
}

class RunController {
  constructor(private readonly input: RunAgentAttemptInput) {}

  async run(): Promise<RunResult> {
    const input = this.input;
    let issue = input.issue;
    const settings = input.settings ?? input.workflow.settings;
    let runtime = settingsForIssueState(settings, issue.state);
    const size = ensembleSize(issue) ?? settings.agent.ensembleSize;
    const slotIndex = input.slotIndex ?? 0;
    const workerHost = input.workerHost ?? null;
    const workspace = await createWorkspaceForIssue(input.adapters, runtime, issue, {
      slotIndex,
      ensembleSize: size,
      workerHost,
    });
    input.onUpdate?.({
      type: "workspace_prepared",
      workspacePath: workspace,
      message: `workspace prepared at ${workspace}`,
    });
    if (runtime.hooks.beforeRun) {
      await runHook(input.adapters, runtime.hooks.beforeRun, workspace, runtime.hooks, workerHost);
    }

    // A shared workspace is reused by every issue, so its resume state cannot be tied to one run.
    const resumeEnabled = settings.workspace.isolation !== "none";
    let resumeId: string | null = null;
    if (resumeEnabled) {
      const resume = await readResumeState(
        input.adapters,
        workspace,
        workerHost,
        runtime.worker.sshTimeoutMs,
      );
      const resumeMatches =
        resume.status === "ok" &&
        resumeStateMatches(input.adapters, resume.state, {
          agentKind: runtime.agent.kind,
          issue,
          workspacePath: workspace,
          workerHost,
        });
      if (resume.status === "error") {
        input.onUpdate?.({
          type: "resume_state_warning",
          workspacePath: workspace,
          message: resume.reason,
        });
      } else if (resume.status === "ok" && !resumeMatches) {
        input.onUpdate?.({
          type: "resume_state_warning",
          workspacePath: workspace,
          message: "resume_state_identity_mismatch",
        });
      }
      resumeId = resumeMatches ? resume.state.resumeId : null;
    }

    const executor = await executorFor(input.adapters, runtime);
    const updates: AgentUpdate[] = [];
    const session = await executor.startSession({
      workspace,
      workerHost,
      issue,
      settings: runtime,
      resumeId,
      onUpdate: (update) => {
        updates.push(update);
        input.onUpdate?.(update);
      },
    });

    let turnCount = 0;
    try {
      while (turnCount < runtime.agent.maxTurns) {
        throwIfAborted(input.abortSignal);
        const prompt =
          turnCount === 0
            ? await buildPrompt(input.workflow.promptTemplate, issue, {
                attempt: input.attempt ?? null,
                slotIndex,
                ensembleSize: size,
              })
            : continuationPrompt(turnCount + 1, runtime.agent.maxTurns);
        const turnUpdates = await runTurnWithAbort(
          executor,
          session,
          prompt,
          issue,
          input.abortSignal,
        );
        turnCount += 1;
        if (resumeEnabled) {
          await persistResumeState(input.adapters, session, runtime, issue, workspace, workerHost);
        }

        if (
          turnCount > 1 &&
          runtime.agents[runtime.agent.kind]?.executor === "acp" &&
          !turnUpdates.some(
            (u) =>
              u.type === "session_notification" && u.message.update?.sessionUpdate === "tool_call",
          )
        ) {
          break;
        }

        if (!input.fetchIssue) break;
        issue = await input.fetchIssue(issue);
        if (!issueIsActive(issue, settings)) break;
        const refreshed = settingsForIssueState(settings, issue.state);
        if (
          refreshed.agent.kind !== runtime.agent.kind ||
          backendProfile(refreshed) !== backendProfile(runtime)
        ) {
          break;
        }
        runtime = refreshed;
      }
    } finally {
      await session.stop();
      if (runtime.hooks.afterRun) {
        try {
          await runHook(
            input.adapters,
            runtime.hooks.afterRun,
            workspace,
            runtime.hooks,
            workerHost,
          );
        } catch {
          // after_run is best effort by SPEC.
        }
      }
    }

    if (resumeEnabled) {
      await persistResumeState(input.adapters, session, runtime, issue, workspace, workerHost);
    }

    return {
      workspace,
      turnCount,
      updates,
      resumeId: session.resumeId,
      agentKind: runtime.agent.kind,
      finalIssue: issue,
    };
  }
}

async function runTurnWithAbort(
  executor: AgentExecutor,
  session: AgentSession,
  prompt: string,
  issue: Issue,
  abortSignal: AbortSignal | undefined,
): Promise<AgentUpdate[]> {
  if (!abortSignal) return executor.runTurn(session, prompt, issue);
  throwIfAborted(abortSignal);
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<AgentUpdate[]>((_resolve, reject) => {
    onAbort = () => {
      reject(new Error("agent_run_aborted"));
      void session.stop().catch((err) => {
        process.stderr.write(`session.stop failed: ${err}\n`);
      });
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([executor.runTurn(session, prompt, issue), abortPromise]);
  } finally {
    if (onAbort) abortSignal?.removeEventListener("abort", onAbort);
  }
}

function throwIfAborted(abortSignal: AbortSignal | undefined): void {
  if (!abortSignal?.aborted) return;
  throw new Error("agent_run_aborted");
}

async function executorFor(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  settings: Settings,
): Promise<AgentExecutor> {
  if (adapters?.executorFactory) return adapters.executorFactory(settings);
  throw new Error("agent_runner_adapter_missing: executorFactory");
}

function backendProfile(settings: Settings): string {
  return JSON.stringify(settings.agents[settings.agent.kind] ?? null);
}

async function persistResumeState(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  session: AgentSession,
  runtime: Settings,
  issue: Issue,
  workspace: string,
  workerHost: string | null,
): Promise<void> {
  if (!session.resumeId) return;
  await writeResumeState(
    adapters,
    workspace,
    {
      agentKind: runtime.agent.kind,
      resumeId: session.resumeId,
      sessionId: session.sessionId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueState: issue.state,
      workspacePath: workspace,
      workerHost,
    },
    workerHost,
    runtime.worker.sshTimeoutMs,
  );
}

async function createWorkspaceForIssue(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  settings: Settings,
  issue: Issue,
  options: { slotIndex: number; ensembleSize: number; workerHost: string | null },
): Promise<string> {
  if (adapters?.createWorkspaceForIssue)
    return adapters.createWorkspaceForIssue(settings, issue, options);
  throw new Error("agent_runner_adapter_missing: createWorkspaceForIssue");
}

async function runHook(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  command: string,
  workspacePath: string,
  hooks: Settings["hooks"],
  workerHost: string | null,
): Promise<void> {
  if (adapters?.runHook) return adapters.runHook(command, workspacePath, hooks, workerHost);
  throw new Error("agent_runner_adapter_missing: runHook");
}

async function readResumeState(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  workspacePath: string,
  workerHost: string | null,
  timeoutMs: number,
): Promise<ResumeReadResult> {
  if (adapters?.readResumeState)
    return adapters.readResumeState(workspacePath, workerHost, timeoutMs);
  throw new Error("agent_runner_adapter_missing: readResumeState");
}

function resumeStateMatches(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  state: ResumeStateShape,
  input: { agentKind: string; issue: Issue; workspacePath: string; workerHost: string | null },
): boolean {
  if (adapters?.resumeStateMatches) return adapters.resumeStateMatches(state, input);
  return (
    state.agentKind === input.agentKind &&
    state.issueId === input.issue.id &&
    state.issueIdentifier === input.issue.identifier &&
    state.issueState === input.issue.state &&
    state.workspacePath === input.workspacePath &&
    (state.workerHost ?? null) === input.workerHost
  );
}

async function writeResumeState(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  workspacePath: string,
  state: ResumeStateShape,
  workerHost: string | null,
  timeoutMs: number,
): Promise<void> {
  if (adapters?.writeResumeState) {
    return adapters.writeResumeState(workspacePath, state, workerHost, timeoutMs);
  }
  throw new Error("agent_runner_adapter_missing: writeResumeState");
}
