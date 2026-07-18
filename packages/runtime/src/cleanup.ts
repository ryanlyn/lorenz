import { isTerminalState } from "@lorenz/issue";
import {
  errorMessage,
  type Issue,
  type RuntimeTrackerClient,
  type WorkflowDefinition,
} from "@lorenz/domain";

export type RuntimeWorkspaceRemover = (input: {
  settings: WorkflowDefinition["settings"];
  issueIdentifier?: string | null | undefined;
  workerHost?: string | null | undefined;
  issue?: Issue | undefined;
}) => Promise<void>;

export interface RuntimeStartupCleanerOptions {
  workflow(): WorkflowDefinition;
  client(): RuntimeTrackerClient;
  listIssueWorkspaces?:
    | ((settings: WorkflowDefinition["settings"]) => Promise<string[]>)
    | undefined;
  removeIssueWorkspaces: RuntimeWorkspaceRemover;
  addEvent(
    type: "startup_workspace_cleanup" | "startup_workspace_cleanup_failed",
    message: string,
  ): void;
}

export class RuntimeStartupCleaner {
  private done = false;

  constructor(private readonly options: RuntimeStartupCleanerOptions) {}

  async cleanupTerminalWorkspacesOnce(): Promise<void> {
    if (this.done) return;
    this.done = true;
    if (!this.options.listIssueWorkspaces) return;
    const workflow = this.options.workflow();
    try {
      const identifiers = await this.options.listIssueWorkspaces(workflow.settings);
      if (identifiers.length === 0) return;
      const issues = await this.options.client().fetchIssuesByIds(identifiers);
      let cleaned = 0;
      for (const issue of issues) {
        if (!isTerminalState(issue.state, workflow.settings.tracker.terminalStates)) continue;
        await this.options.removeIssueWorkspaces({
          settings: workflow.settings,
          issueIdentifier: issue.identifier,
          issue,
        });
        cleaned += 1;
      }
      if (cleaned > 0) this.options.addEvent("startup_workspace_cleanup", `terminal=${cleaned}`);
    } catch (error) {
      this.options.addEvent("startup_workspace_cleanup_failed", errorMessage(error));
    }
  }
}
