import { createComputed, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionGoal, SessionGoalUpdate } from "@opencode-ai/sdk/v2/client"

export const goalTextLimit = 4000

export function goalSetCommand(draft: string): SessionGoalUpdate | undefined {
  const text = draft.trim()
  if (!text || text.length > goalTextLimit) return
  return { action: "set", text }
}

export function goalToggleCommand(goal?: SessionGoal): SessionGoalUpdate | undefined {
  if (goal?.status === "active") return { action: "pause" }
  if (goal?.status === "paused") return { action: "resume" }
}

export function goalElapsed(goal: SessionGoal, now: number) {
  return (
    goal.accumulated +
    (goal.status === "active" && goal.activeSince !== undefined ? Math.max(0, now - goal.activeSince) : 0)
  )
}

export function formatGoalElapsed(ms: number) {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}h ${minutes % 60}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

export function createSessionGoalController(input: {
  key: () => string
  goal: () => SessionGoal | undefined
  update: (command: SessionGoalUpdate) => Promise<void>
}) {
  const initial = () => ({ editing: false, draft: "", pending: false, error: false, expanded: false })
  const [state, setState] = createStore(initial())
  let generation = 0
  createComputed(() => {
    input.key()
    generation++
    setState(initial())
  })
  onCleanup(() => generation++)

  const run = async (command?: SessionGoalUpdate) => {
    if (!command || state.pending) return
    const attempt = generation
    setState({ pending: true, error: false })
    try {
      await input.update(command)
      if (attempt !== generation) return
      setState({ editing: false, draft: "", expanded: false })
    } catch {
      // Neither transport payloads nor local paths belong in the renderer error.
      if (attempt === generation) setState("error", true)
    } finally {
      if (attempt === generation) setState("pending", false)
    }
  }

  return {
    state,
    run,
    save: () => run(goalSetCommand(state.draft)),
    edit: () => {
      if (!state.pending) setState({ editing: true, draft: input.goal()?.text ?? "", error: false })
    },
    cancel: () => {
      if (!state.pending) setState({ editing: false, error: false })
    },
    setDraft: (draft: string) => {
      if (!state.pending) setState("draft", draft)
    },
    toggleExpanded: () => setState("expanded", !state.expanded),
  }
}
