import type { InitStep, ServerReadyData } from "../preload/types"

export function startLoadingInitialization(input: {
  wait: (send: (step: InitStep) => void) => Promise<ServerReadyData>
  update: (step: InitStep) => void
  complete: () => void
  failed: (message: string) => void
}) {
  let disposed = false
  void input
    .wait((step) => {
      if (!disposed) input.update(step)
    })
    .then(
      () => {
        if (disposed) return
        input.update({ phase: "done" })
        input.complete()
      },
      () => {
        if (!disposed)
          input.failed("BharatCode could not finish starting. Close this window and reopen the app to retry.")
      },
    )
  return () => {
    disposed = true
  }
}
