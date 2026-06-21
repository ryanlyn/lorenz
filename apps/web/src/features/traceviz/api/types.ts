export type {
  DisplayEvent,
  ThoughtDisplayEvent as ThoughtEvent,
  MessageDisplayEvent as MessageEvent,
  ToolCallDisplayEvent as ToolCallEvent,
  TurnCompletedDisplayEvent as TurnCompletedEvent,
  TurnFailedDisplayEvent as TurnFailedEvent,
  NotificationDisplayEvent as NotificationEvent,
  UnknownDisplayEvent as UnknownEvent,
} from "@lorenz/traceviz-server";

export type { TicketInfo, TraceStats as Stats } from "@lorenz/traceviz-server";

/** Mirrors IssueRecord from @lorenz/server — kept local to avoid a Node.js dependency in the browser bundle. */
export interface IssueRecord {
  issueId: string;
  issueIdentifier: string;
  title: string | null;
  url: string | null;
  updatedAt: number;
}
