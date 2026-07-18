/** Wire shapes for the ops view come straight from the server's presenter package. */
export type {
  OpsStatePayload as OpsState,
  RunningEntryPayload as OpsRunningEntry,
  RetryEntryPayload as OpsRetryEntry,
  ExhaustedEntryPayload as OpsExhaustedEntry,
  BlockedEntryPayload as OpsBlockedEntry,
} from "@lorenz/presenter";
