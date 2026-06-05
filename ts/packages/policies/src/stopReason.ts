import type { StopReason } from "@symphony/domain";

export type StopReasonAction = "continue" | "retry" | "cancel";

export function actionForStopReason(stopReason: StopReason): StopReasonAction {
  if (
    stopReason === "end_turn" ||
    stopReason === "max_tokens" ||
    stopReason === "max_turn_requests"
  ) {
    return "continue";
  }
  if (stopReason === "cancelled") return "cancel";
  return "retry";
}
