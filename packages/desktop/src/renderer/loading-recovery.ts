import type { RecoveryAction, RecoveryStatus } from "../preload/types"

export type RecoveryView = {
  status: RecoveryStatus | null
  busy: RecoveryAction["type"] | "inspect" | null
  error: string | null
}

// Keep transport errors out of the renderer: their payloads can contain private paths.
// Re-inspection after failure reflects a journal that may have advanced before IPC failed.
export function createRecoveryController(input: {
  inspect: () => Promise<RecoveryStatus>
  run: (action: RecoveryAction) => Promise<RecoveryStatus>
  update: (view: RecoveryView) => void
}) {
  let view: RecoveryView = { status: null, busy: null, error: null }
  function update(next: Partial<RecoveryView>) {
    view = { ...view, ...next }
    input.update(view)
  }
  return {
    async inspect() {
      if (view.busy) return
      update({ busy: "inspect", error: null })
      try {
        update({ status: await input.inspect() })
      } catch {
        update({ error: "Could not check recovery status. Close other BharatCode windows, then select Check again." })
      } finally {
        update({ busy: null })
      }
    },
    async run(action: RecoveryAction) {
      if (view.busy) return
      update({ busy: action.type, error: null })
      try {
        update({ status: await input.run(action) })
      } catch {
        try {
          update({ status: await input.inspect() })
        } catch {
          // Preserve the last known choices when the status check also fails.
        }
        update({
          error:
            action.type === "start-fresh"
              ? "Start Fresh did not finish. Check free disk space and write access, then Retry or select Start Fresh again."
              : "Recovery did not finish. Close other BharatCode windows and check free disk space and write access. Try the action again, or select another source.",
        })
      } finally {
        update({ busy: null })
      }
    },
  }
}

export type AvailableRecoveryAction = "choose-source" | "retry" | "start-fresh" | "repair-marker"

export function availableRecoveryActions(status: RecoveryStatus | null): readonly AvailableRecoveryAction[] {
  if (!status || status.state === "ready") return []
  if (status.state === "choose-source") return ["choose-source", "start-fresh"]
  if (status.state === "retry") return ["retry", "start-fresh"]
  if (status.state === "marker-repair") return ["repair-marker", "start-fresh"]
  return ["start-fresh"]
}
