import type { RecoveryStatus } from "../preload/types"

export type AvailableRecoveryAction = "choose-source" | "retry" | "start-fresh" | "repair-marker"

export function availableRecoveryActions(status: RecoveryStatus | null): readonly AvailableRecoveryAction[] {
  if (!status || status.state === "ready") return []
  if (status.state === "choose-source") return ["choose-source", "start-fresh"]
  if (status.state === "retry") return ["retry", "start-fresh"]
  if (status.state === "marker-repair") return ["repair-marker", "start-fresh"]
  return ["start-fresh"]
}
