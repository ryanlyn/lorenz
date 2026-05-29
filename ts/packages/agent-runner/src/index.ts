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

import { agentRunTransition, type AgentRunState, type AgentRunEvent } from "./agent-run-machine.js";

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

// Mutable context threaded through the interpreter loop
interface RunContext {
  issue: Issue;
  runtime: Settings;
  workspace: string | null;
  session: AgentSession | null;
  executor: AgentExecutor | null;
  updates: AgentUpdate[];
  turnCount: number;
  resumeId: string | null;
}

export class RunController {
  private state: AgentRunState = { kind: "idle" };

  constructor(private readonly input: RunAgentAttemptInput) {}

  private advance(event: AgentRunEvent): void {
    const next = agentRunTransition(this.state, event);
    if (next === null) {
      throw new Error(
        `agent_run_machine: invalid transition from ${this.state.kind} on ${event.kind}`,
      );
    }
    this.state = next;
  }

  async run(): Promise<RunResult> {
    const input = this.input;
    const settings = input.settings ?? input.workflow.settings;
    const ctx: RunContext = {
      issue: input.issue,
      runtime: settingsForIssueState(settings, input.issue.state),
      workspace: null,
      session: null,
      executor: null,
      updates: [],
      turnCount: 0,
      resumeId: null,
    };

    while (this.state.kind !== "completed" && this.state.kind !== "failed") {
      if (
        this.input.abortSignal?.aborted &&
        this.state.kind !== "stoppingSession" &&
        this.state.kind !== "runningAfterHook" &&
        this.state.kind !== "persistingFinalState"
      ) {
        this.advance({ kind: "abort" });
        continue;
      }
      await this.execute(ctx);
    }

    if (this.state.kind === "failed") {
      throw new Error(this.state.reason);
    }

    if (!ctx.workspace) {
      throw new Error("agent_run_aborted");
    }

    return {
      workspace: ctx.workspace,
      turnCount: ctx.turnCount,
      updates: ctx.updates,
      resumeId: ctx.session?.resumeId,
      agentKind: ctx.runtime.agent.kind,
      finalIssue: ctx.issue,
    };
  }

  private async execute(ctx: RunContext): Promise<void> {
    const input = this.input;
    const settings = input.settings ?? input.workflow.settings;
    const size = ensembleSize(input.issue) ?? settings.agent.ensembleSize;
    const slotIndex = input.slotIndex ?? 0;
    const workerHost = input.workerHost ?? null;

    switch (this.state.kind) {
      case "idle": {
        this.advance({ kind: "start" });
        return;
      }

      case "preparingWorkspace": {
        ctx.workspace = await createWorkspaceForIssue(input.adapters, ctx.runtime, ctx.issue, {
          slotIndex,
          ensembleSize: size,
          workerHost,
        });
        input.onUpdate?.({ type: "workspace_prepared", workspacePath: ctx.workspace });
        this.advance({ kind: "workspace_ready" });
        return;
      }

      case "runningBeforeHook": {
        if (ctx.runtime.hooks.beforeRun) {
          await runHook(
            input.adapters,
            ctx.runtime.hooks.beforeRun,
            ctx.workspace!,
            ctx.runtime.hooks,
            workerHost,
          );
        }
        this.advance({ kind: "hook_done" });
        return;
      }

      case "checkingResumeState": {
        const resume = await readResumeState(
          input.adapters,
          ctx.workspace!,
          workerHost,
          ctx.runtime.worker.sshTimeoutMs,
        );
        const resumeMatches =
          resume.status === "ok" &&
          resumeStateMatches(input.adapters, resume.state, {
            agentKind: ctx.runtime.agent.kind,
            issue: ctx.issue,
            workspacePath: ctx.workspace!,
            workerHost,
          });
        if (resume.status === "error") {
          input.onUpdate?.({
            type: "resume_state_warning",
            workspacePath: ctx.workspace!,
            message: resume.reason,
          });
        } else if (resume.status === "ok" && !resumeMatches) {
          input.onUpdate?.({
            type: "resume_state_warning",
            workspacePath: ctx.workspace!,
            message: "resume_state_identity_mismatch",
          });
        }
        ctx.resumeId = resumeMatches ? resume.state.resumeId : null;
        this.advance({ kind: "resume_checked" });
        return;
      }

      case "startingSession": {
        ctx.executor = await executorFor(input.adapters, ctx.runtime);
        ctx.session = await ctx.executor.startSession({
          workspace: ctx.workspace!,
          workerHost,
          issue: ctx.issue,
          settings: ctx.runtime,
          resumeId: ctx.resumeId,
          onUpdate: (update) => {
            ctx.updates.push(update);
            input.onUpdate?.(update);
          },
        });
        this.advance({ kind: "session_started" });
        return;
      }

      case "runningTurn": {
        const prompt =
          ctx.turnCount === 0
            ? await buildPrompt(input.workflow.promptTemplate, ctx.issue, {
                attempt: input.attempt ?? null,
                slotIndex,
                ensembleSize: size,
              })
            : continuationPrompt(ctx.turnCount + 1, ctx.runtime.agent.maxTurns);
        await runTurnWithAbort(ctx.executor!, ctx.session!, prompt, ctx.issue, input.abortSignal);
        ctx.turnCount += 1;
        this.advance({ kind: "turn_done" });
        return;
      }

      case "persistingMidRunState": {
        await persistResumeState(
          input.adapters,
          ctx.session!,
          ctx.runtime,
          ctx.issue,
          ctx.workspace!,
          workerHost,
        );
        this.advance({ kind: "state_persisted" });
        return;
      }

      case "evaluatingContinuation": {
        let shouldContinue = false;
        if (input.fetchIssue) {
          ctx.issue = await input.fetchIssue(ctx.issue);
          if (issueIsActive(ctx.issue, settings)) {
            const refreshed = settingsForIssueState(settings, ctx.issue.state);
            if (
              refreshed.agent.kind === ctx.runtime.agent.kind &&
              backendProfile(refreshed) === backendProfile(ctx.runtime)
            ) {
              ctx.runtime = refreshed;
              shouldContinue = ctx.turnCount < ctx.runtime.agent.maxTurns;
            }
          }
        }
        if (shouldContinue) {
          this.advance({ kind: "continuation_yes" });
        } else {
          this.advance({ kind: "continuation_no" });
        }
        return;
      }

      case "stoppingSession": {
        if (ctx.session) {
          await ctx.session.stop();
        }
        this.advance({ kind: "session_stopped" });
        return;
      }

      case "runningAfterHook": {
        if (ctx.workspace && ctx.runtime.hooks.afterRun) {
          try {
            await runHook(
              input.adapters,
              ctx.runtime.hooks.afterRun,
              ctx.workspace,
              ctx.runtime.hooks,
              workerHost,
            );
          } catch {
            // after_run is best effort by SPEC.
          }
        }
        this.advance({ kind: "after_hook_done" });
        return;
      }

      case "persistingFinalState": {
        if (ctx.session && ctx.workspace) {
          await persistResumeState(
            input.adapters,
            ctx.session,
            ctx.runtime,
            ctx.issue,
            ctx.workspace,
            workerHost,
          );
        }
        this.advance({ kind: "final_persisted" });
        return;
      }

      case "completed":
      case "failed":
        return;
    }
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
