import { checkSlotsPerMachineGate, type DispatchCoordinator } from "@lorenz/dispatch-coordinator";
import {
  errorMessage,
  withDerivedMaxInFlight,
  type RuntimeTrackerClient,
  type WorkerPoolSettings,
  type WorkflowDefinition,
} from "@lorenz/domain";
import { workflowFileChanged, workflowStampsEqual } from "@lorenz/workflow";
import type { Orchestrator } from "@lorenz/orchestrator";

type RuntimeReloadOrchestrator = Pick<Orchestrator, "settings">;

export interface RuntimeWorkflowReloaderOptions {
  workflow(): WorkflowDefinition;
  reloadWorkflow?: (() => Promise<WorkflowDefinition>) | undefined;
  clientWasInjected(): boolean;
  clientFactory?: ((settings: WorkflowDefinition["settings"]) => RuntimeTrackerClient) | undefined;
  setWorkflow(workflow: WorkflowDefinition): void;
  setClient(client: RuntimeTrackerClient): void;
  orchestrator: RuntimeReloadOrchestrator;
  coordinator?: DispatchCoordinator | undefined;
  addEvent(type: "workflow_reloaded" | "workflow_reload_failed", message: string): void;
}

export class RuntimeWorkflowReloader {
  constructor(private readonly options: RuntimeWorkflowReloaderOptions) {}

  async reloadIfConfigured(): Promise<void> {
    if (!this.options.reloadWorkflow) return;
    const current = this.options.workflow();
    const prevWorkerPool = current.settings.worker.workerPool;
    try {
      if (!(await workflowFileChanged(current))) return;
      const workflow = await this.options.reloadWorkflow();
      if (workflow === current || workflowStampsEqual(current.stamp, workflow.stamp)) return;
      const gateMessage = checkSlotsPerMachineGate(
        workflow.settings.worker.workerPool,
        this.options.coordinator?.capabilities,
      );
      if (gateMessage !== null) throw new Error(gateMessage);
      if (this.options.coordinator) {
        const next =
          workflow.settings.worker.workerPool ?? disabledWorkerPoolSettings(prevWorkerPool);
        if (next) await this.options.coordinator.reconcile(next);
      }
      this.options.setWorkflow(workflow);
      this.options.orchestrator.settings = workflow.settings;
      if (!this.options.clientWasInjected() && this.options.clientFactory) {
        this.options.setClient(this.options.clientFactory(workflow.settings));
      }
      this.options.addEvent("workflow_reloaded", workflow.path);
    } catch (error) {
      this.options.addEvent("workflow_reload_failed", errorMessage(error));
    }
  }
}

function disabledWorkerPoolSettings(
  prev: WorkerPoolSettings | undefined,
): WorkerPoolSettings | undefined {
  if (!prev) return undefined;
  const { maxInFlight: _maxInFlight, ...rest } = prev;
  return withDerivedMaxInFlight({ ...rest, enabled: false });
}
