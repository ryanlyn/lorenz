import { settingsForIssueState } from "@lorenz/config";
import { issueIsActive } from "@lorenz/dispatch";
import type { AgentMcpEndpointLease } from "@lorenz/mcp";
import { ensembleSize } from "@lorenz/issue";
import { buildPrompt, continuationPrompt } from "@lorenz/prompt";
import {
  errorMessage,
  type AgentExecutor,
  type AgentSession,
  type AgentUpdate,
  type HookExecutionMessage,
  type Issue,
  type Settings,
  type WorkflowDefinition,
} from "@lorenz/domain";

const workerSetupTimeoutGraceMs = 1_000;
const workspaceCreateStage = "workspace.create_for_issue";
const beforeRunHookStage = "workspace.run_before_run_hook";
const afterRunHookStage = "workspace.run_after_run_hook";

interface SetupStageSignalOptions {
  abortSignal?: AbortSignal | undefined;
  hookName?: HookExecutionMessage["hookName"] | undefined;
  onHookEvent?: ((message: HookExecutionMessage) => void) | undefined;
}

export interface RunAgentAttemptAdapters {
  createWorkspaceForIssue(
    settings: Settings,
    issue: Issue,
    env: NodeJS.ProcessEnv,
    options: {
      slotIndex: number;
      ensembleSize: number;
      workerHost: string | null;
      forceSlotSuffix?: boolean;
      abortSignal?: AbortSignal | undefined;
      onHookEvent?: ((message: HookExecutionMessage) => void) | undefined;
    },
  ): Promise<string>;
  runHook(
    command: string,
    workspace: string,
    hooks: Settings["hooks"],
    env: NodeJS.ProcessEnv,
    workerHost: string | null,
    options?: SetupStageSignalOptions,
    issue?: Issue,
  ): Promise<void>;
  executorFactory(
    settings: Settings,
    env: NodeJS.ProcessEnv,
  ): Promise<AgentExecutor> | AgentExecutor;
}

/**
 * The executor `startSession` input EXTENDED with the optional per-run
 * `mcpEndpoint` lease. The base is the shared `AgentExecutor.startSession`
 * parameter (so every required field stays in lockstep with the interface); the
 * extra optional `mcpEndpoint` is carried through to the acp executor's widened
 * input. Building the call argument as this type keeps the value assignable to
 * the narrower interface param without an excess-property error on a fresh
 * literal.
 */
type StartSessionInput = Parameters<AgentExecutor["startSession"]>[0] & {
  mcpEndpoint?: AgentMcpEndpointLease | null;
};

export interface RunResult {
  workspace: string;
  turnCount: number;
  updates: AgentUpdate[];
  agentKind: string;
  finalIssue?: Issue | undefined;
}

export interface RunAgentAttemptInput {
  issue: Issue;
  workflow: WorkflowDefinition;
  /**
   * Process environment threaded from the composition root. Passed to the workspace,
   * hook, and executor adapters so none of them read `process.env` directly.
   */
  env: NodeJS.ProcessEnv;
  settings?: Settings;
  workerHost?: string | null;
  slotIndex?: number;
  attempt?: number | null;
  /**
   * The dispatch coordinator's per-run MCP endpoint lease for THIS run, threaded
   * straight into `executor.startSession`. When present (non-null) the acp executor
   * USES it and skips acquiring/releasing its own endpoint (the coordinator owns
   * the whole lease). Absent / null on the local / non-pool path, where acp
   * acquires AND releases its own endpoint byte-for-byte.
   */
  mcpEndpoint?: AgentMcpEndpointLease | null;
  /**
   * Gated co-residence override for the workspace layout. When `true` the slot
   * suffix is applied UNCONDITIONALLY (so two solo runs of one issue co-residing on
   * one machine get distinct `<issue>/<slotIndex>` dirs instead of sharing the bare
   * path); the coordinator/runtime sets it only when `slotsPerMachine > 1`
   * co-residence is active. Absent / `false` (the default) keeps the single-slot
   * bare layout byte-identical.
   */
  forceSlotSuffix?: boolean;
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
    const workspace = await runSetupStage(
      workspaceCreateStage,
      workspaceCreateTimeoutMs(runtime),
      async ({ abortSignal }) =>
        createWorkspaceForIssue(input.adapters, runtime, issue, input.env, {
          slotIndex,
          ensembleSize: size,
          workerHost,
          // Gated co-residence: force the slot suffix so two solo same-issue runs
          // that co-reside on one machine get distinct dirs. Default false keeps
          // the single-slot bare layout byte-identical.
          forceSlotSuffix: input.forceSlotSuffix ?? false,
          abortSignal,
          onHookEvent: (message) => this.emitHookUpdate(message),
        }),
      input.abortSignal,
    );
    input.onUpdate?.({
      type: "workspace_prepared",
      workspacePath: workspace,
      message: `workspace prepared at ${workspace}`,
    });
    const updates: AgentUpdate[] = [];
    let session: AgentSession | null = null;

    let turnCount = 0;
    let runError: unknown;
    let stopError: unknown;
    try {
      const beforeRun = runtime.hooks.beforeRun;
      if (beforeRun) {
        await runSetupStage(
          beforeRunHookStage,
          hookStageTimeoutMs(runtime),
          async ({ abortSignal }) =>
            runHook(
              input.adapters,
              beforeRun,
              workspace,
              runtime.hooks,
              input.env,
              workerHost,
              {
                abortSignal,
                hookName: "before_run",
                onHookEvent: (message) => this.emitHookUpdate(message),
              },
              issue,
            ),
          input.abortSignal,
        );
      }

      const executor = await executorFor(input.adapters, runtime, input.env);
      // Thread the coordinator's per-run endpoint (or null on the local/non-pool
      // path) into the executor: the acp executor consumes a non-null lease and
      // skips its own acquire+release. Built as a typed value so the optional
      // `mcpEndpoint` field is carried to the executor's widened input without
      // tripping the excess-property check on the narrower `AgentExecutor`
      // interface. The field is a DECLARED optional on `StartSessionInput`, and
      // the executor reads an absent value as null, so the explicit `null` is the
      // deliberate, pinned disabled-path contract (a strict adapter rejecting a
      // declared optional field would be its own bug) - we keep it rather than
      // omit the key.
      const startSessionInput: StartSessionInput = {
        workspace,
        workerHost,
        issue,
        settings: runtime,
        mcpEndpoint: input.mcpEndpoint ?? null,
        onUpdate: (update) => {
          updates.push(update);
          input.onUpdate?.(update);
        },
      };
      session = await executor.startSession(startSessionInput);

      while (turnCount < runtime.agent.maxTurns) {
        throwIfAborted(input.abortSignal);
        const prompt =
          turnCount === 0
            ? await buildPrompt(
                input.workflow.parsedPromptTemplate ?? input.workflow.promptTemplate,
                issue,
                {
                  attempt: input.attempt ?? null,
                  slotIndex,
                  ensembleSize: size,
                },
              )
            : continuationPrompt(turnCount + 1, runtime.agent.maxTurns);
        const turnUpdates = await runTurnWithAbort(
          executor,
          session,
          prompt,
          issue,
          input.abortSignal,
        );
        turnCount += 1;

        // Known seam leak: turn-continuation is decided from ACP event vocabulary here
        // instead of an executor-owned hook. Generalize onto the session contract (a
        // provider-supplied "has more work" classifier) when a second executor lands.
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
    } catch (error) {
      runError = error;
    } finally {
      if (session) {
        try {
          await session.stop();
        } catch (error) {
          stopError = error;
        }
      }
      await this.runAfterRunHook(runtime, workspace, workerHost, issue);
    }

    if (runError) throw toError(runError);
    if (stopError) throw toError(stopError);
    if (!session) throw new Error("agent_runner_session_missing");

    return {
      workspace,
      turnCount,
      updates,
      agentKind: runtime.agent.kind,
      finalIssue: issue,
    };
  }

  private async runAfterRunHook(
    runtime: Settings,
    workspace: string,
    workerHost: string | null,
    issue: Issue,
  ): Promise<void> {
    const input = this.input;
    const afterRun = runtime.hooks.afterRun;
    if (!afterRun) return;
    try {
      await runSetupStage(afterRunHookStage, hookStageTimeoutMs(runtime), async ({ abortSignal }) =>
        runHook(
          input.adapters,
          afterRun,
          workspace,
          runtime.hooks,
          input.env,
          workerHost,
          {
            abortSignal,
            hookName: "after_run",
            onHookEvent: (message) => this.emitHookUpdate(message),
          },
          issue,
        ),
      );
    } catch (error) {
      input.onUpdate?.({
        type: "stderr",
        workspacePath: workspace,
        message: `Ignoring after_run hook failure (${afterRunHookStage}): ${errorMessage(error)}`,
      });
    }
  }

  private emitHookUpdate(message: HookExecutionMessage): void {
    this.input.onUpdate?.({
      type: "hook_execution",
      message,
      workspacePath: message.cwd,
      timestamp: new Date(),
    });
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
  env: NodeJS.ProcessEnv,
): Promise<AgentExecutor> {
  if (adapters?.executorFactory) return adapters.executorFactory(settings, env);
  throw new Error("agent_runner_adapter_missing: executorFactory");
}

function workspaceCreateTimeoutMs(settings: Settings): number {
  const agent = settings.agents[settings.agent.kind];
  if (!agent) throw new Error(`agents.${settings.agent.kind} is required`);
  return agent.stallTimeoutMs;
}

function hookStageTimeoutMs(settings: Settings): number {
  return settings.hooks.timeoutMs + workerSetupTimeoutGraceMs;
}

class SetupStageTimeoutError extends Error {
  constructor(
    readonly stageName: string,
    readonly timeoutMs: number,
  ) {
    super(`agent_runner_timeout: ${stageName} timed out after ${timeoutMs}ms`);
  }
}

async function runSetupStage<T>(
  stageName: string,
  timeoutMs: number,
  fn: (options: { abortSignal: AbortSignal }) => Promise<T>,
  parentAbortSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: SetupStageTimeoutError | undefined;
  let abortError: Error | undefined;
  let onParentAbort: (() => void) | undefined;
  const races: Promise<T>[] = [
    Promise.resolve().then(async () => fn({ abortSignal: controller.signal })),
  ];

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    races.push(
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timeoutError = new SetupStageTimeoutError(stageName, timeoutMs);
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      }),
    );
  }
  if (parentAbortSignal) {
    races.push(
      new Promise<never>((_resolve, reject) => {
        onParentAbort = () => {
          abortError = new Error("agent_run_aborted");
          controller.abort(abortError);
          reject(abortError);
        };
        if (parentAbortSignal.aborted) {
          onParentAbort();
        } else {
          parentAbortSignal.addEventListener("abort", onParentAbort, { once: true });
        }
      }),
    );
  }

  try {
    return await Promise.race(races);
  } catch (error) {
    if (timeoutError) throw timeoutError;
    if (abortError) throw abortError;
    if (error instanceof SetupStageTimeoutError) throw error;
    throw new Error(`agent_runner_setup_crashed: ${stageName}: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onParentAbort) parentAbortSignal?.removeEventListener("abort", onParentAbort);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function backendProfile(settings: Settings): string {
  return JSON.stringify(settings.agents[settings.agent.kind] ?? null);
}

async function createWorkspaceForIssue(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  settings: Settings,
  issue: Issue,
  env: NodeJS.ProcessEnv,
  options: {
    slotIndex: number;
    ensembleSize: number;
    workerHost: string | null;
    forceSlotSuffix?: boolean;
    abortSignal?: AbortSignal | undefined;
    onHookEvent?: ((message: HookExecutionMessage) => void) | undefined;
  },
): Promise<string> {
  if (adapters?.createWorkspaceForIssue)
    return adapters.createWorkspaceForIssue(settings, issue, env, options);
  throw new Error("agent_runner_adapter_missing: createWorkspaceForIssue");
}

async function runHook(
  adapters: Partial<RunAgentAttemptAdapters> | undefined,
  command: string,
  workspacePath: string,
  hooks: Settings["hooks"],
  env: NodeJS.ProcessEnv,
  workerHost: string | null,
  options?: SetupStageSignalOptions,
  issue?: Issue,
): Promise<void> {
  if (adapters?.runHook)
    return adapters.runHook(command, workspacePath, hooks, env, workerHost, options, issue);
  throw new Error("agent_runner_adapter_missing: runHook");
}
