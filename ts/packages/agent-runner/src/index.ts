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

import {
  agentRunTransition,
  shouldCallSessionStop,
  type AgentRunState,
  type AgentRunEvent,
} from "./agent-run-machine.js";

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

export class RunController {
  private state: AgentRunState = { kind: "idle" };

  constructor(private readonly input: RunAgentAttemptInput) {}

  /** Advance the machine; throws if the transition is invalid. */
  private advance(event: AgentRunEvent): void {
    const next = agentRunTransition(this.state, event);
    if (next === null) {
      throw new Error(
        `agent_run_machine: invalid transition from ${this.state.kind} on ${event.kind}`,
      );
    }
    this.state = next;
  }

  /** Check abort signal at state boundaries. */
  private checkAbort(): void {
    if (this.input.abortSignal?.aborted) {
      this.advance({ kind: "abort" });
      throw new Error("agent_run_aborted");
    }
  }

  async run(): Promise<RunResult> {
    const input = this.input;
    let issue = input.issue;
    const settings = input.settings ?? input.workflow.settings;
    let runtime = settingsForIssueState(settings, issue.state);
    const size = ensembleSize(issue) ?? settings.agent.ensembleSize;
    const slotIndex = input.slotIndex ?? 0;
    const workerHost = input.workerHost ?? null;

    // --- preparingWorkspace ---
    this.advance({ kind: "workspace_ready" }); // idle -> preparingWorkspace
    this.checkAbort();
    const workspace = await createWorkspaceForIssue(input.adapters, runtime, issue, {
      slotIndex,
      ensembleSize: size,
      workerHost,
    });
    input.onUpdate?.({ type: "workspace_prepared", workspacePath: workspace });

    // --- runningBeforeHook ---
    this.advance({ kind: "workspace_ready" }); // preparingWorkspace -> runningBeforeHook
    this.checkAbort();
    if (runtime.hooks.beforeRun) {
      await runHook(input.adapters, runtime.hooks.beforeRun, workspace, runtime.hooks, workerHost);
    }

    // --- checkingResumeState ---
    this.advance({ kind: "hook_done" }); // runningBeforeHook -> checkingResumeState
    this.checkAbort();
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
    const resumeId = resumeMatches ? resume.state.resumeId : null;

    // --- startingSession ---
    this.advance({ kind: "resume_checked" }); // checkingResumeState -> startingSession
    this.checkAbort();
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

    // --- runningTurn loop ---
    this.advance({ kind: "session_started" }); // startingSession -> runningTurn
    let turnCount = 0;

    try {
      while (turnCount < runtime.agent.maxTurns) {
        // Check abort before each turn
        this.checkAbort();

        const prompt =
          turnCount === 0
            ? await buildPrompt(input.workflow.promptTemplate, issue, {
                attempt: input.attempt ?? null,
                slotIndex,
                ensembleSize: size,
              })
            : continuationPrompt(turnCount + 1, runtime.agent.maxTurns);
        await runTurnWithAbort(executor, session, prompt, issue, input.abortSignal);
        turnCount += 1;

        // --- persistingMidRunState ---
        this.advance({ kind: "turn_done" }); // runningTurn -> persistingMidRunState
        await persistResumeState(input.adapters, session, runtime, issue, workspace, workerHost);

        // --- evaluatingContinuation ---
        this.advance({ kind: "state_persisted" }); // persistingMidRunState -> evaluatingContinuation

        // Evaluate whether to continue
        let shouldContinue = false;
        if (input.fetchIssue) {
          issue = await input.fetchIssue(issue);
          if (issueIsActive(issue, settings)) {
            const refreshed = settingsForIssueState(settings, issue.state);
            if (
              refreshed.agent.kind === runtime.agent.kind &&
              backendProfile(refreshed) === backendProfile(runtime)
            ) {
              runtime = refreshed;
              shouldContinue = turnCount < runtime.agent.maxTurns;
            }
          }
        }

        if (shouldContinue) {
          this.advance({ kind: "continuation_yes" }); // evaluatingContinuation -> runningTurn
        } else {
          this.advance({ kind: "continuation_no" }); // evaluatingContinuation -> stoppingSession
          break;
        }
      }

      // If we exited the while due to maxTurns, transition to stoppingSession
      if (this.state.kind === "runningTurn") {
        // maxTurns reached before entering the turn body - stop
        this.advance({ kind: "turn_done" });
        this.advance({ kind: "state_persisted" });
        this.advance({ kind: "continuation_no" });
      }
    } finally {
      // --- stoppingSession ---
      await this.stopSession(session);

      // --- runningAfterHook ---
      if (this.state.kind === "runningAfterHook" && runtime.hooks.afterRun) {
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
      if (this.state.kind === "runningAfterHook") {
        this.advance({ kind: "after_hook_done" }); // runningAfterHook -> persistingFinalState
      }
    }

    // --- persistingFinalState ---
    await persistResumeState(input.adapters, session, runtime, issue, workspace, workerHost);
    if (this.state.kind === "persistingFinalState") {
      this.advance({ kind: "final_persisted" }); // persistingFinalState -> completed
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

  /**
   * Ensure session.stop() is called exactly once, advancing the machine
   * through the stoppingSession state if it hasn't already passed through it.
   */
  private async stopSession(session: AgentSession): Promise<void> {
    // Already in stoppingSession from normal flow (continuation_no)
    if (shouldCallSessionStop(this.state)) {
      await session.stop();
      this.advance({ kind: "session_stopped" });
      return;
    }

    // Error/exception path: machine needs to transition to stoppingSession first
    if (
      this.state.kind !== "completed" &&
      this.state.kind !== "failed" &&
      this.state.kind !== "runningAfterHook" &&
      this.state.kind !== "persistingFinalState"
    ) {
      const errorNext = agentRunTransition(this.state, { kind: "error", reason: "exception" });
      if (errorNext) this.state = errorNext;
    }

    if (shouldCallSessionStop(this.state)) {
      await session.stop();
      const stopped = agentRunTransition(this.state, { kind: "session_stopped" });
      if (stopped) this.state = stopped;
    } else {
      // Already past stoppingSession (runningAfterHook, persistingFinalState, etc.)
      // or in a terminal state - session.stop() was already called or is unnecessary
      await session.stop();
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
