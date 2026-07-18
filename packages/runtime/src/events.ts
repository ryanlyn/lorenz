import {
  redactDiagnosticText,
  systemClock,
  type ClockPort,
  type WorkflowDefinition,
} from "@lorenz/domain";
import type { RuntimeEvent, RuntimeEventType } from "@lorenz/runtime-events";

type RuntimeLogAppender = (logFile: string, event: Record<string, unknown>) => Promise<void>;

export interface RuntimeEventLogOptions {
  clock?: ClockPort | undefined;
  getWorkflow(): WorkflowDefinition;
  appendLogEvent?: RuntimeLogAppender | undefined;
  recordEvent(event: RuntimeEvent): void;
  emit(): void;
}

export class RuntimeEventLog {
  private readonly clock: ClockPort;

  constructor(private readonly options: RuntimeEventLogOptions) {
    this.clock = options.clock ?? systemClock;
  }

  add(type: RuntimeEventType, message: string): void {
    const safeMessage = redactDiagnosticText(message);
    const event = { type, message: safeMessage, at: this.clock.now().toISOString() };
    this.options.recordEvent(event);
    void this.appendLogEvent(this.options.getWorkflow().settings.logging.logFile, {
      at: event.at,
      event: type,
      message: safeMessage,
    }).catch((error) => {
      process.stderr.write(`appendLogEvent failed: ${error}\n`);
    });
    this.options.emit();
  }

  private async appendLogEvent(
    logFile: string | null | undefined,
    event: Record<string, unknown>,
  ): Promise<void> {
    if (!logFile) return;
    if (this.options.appendLogEvent) return this.options.appendLogEvent(logFile, event);
  }
}
