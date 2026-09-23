import type {
  BharatCodeCapabilitySnapshot,
  BharatCodeCapabilityState,
  BharatCodeCapabilityChange,
} from "@opencode-ai/sdk/v2"
import { createEffect, on, onCleanup, untrack, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

export function createMarketplaceController<Scope>(options: {
  scope: Accessor<Scope>
  read: (scope: Scope, signal: AbortSignal) => Promise<BharatCodeCapabilitySnapshot>
  change: (
    scope: Scope,
    id: string,
    action: BharatCodeCapabilityChange["action"],
    signal: AbortSignal,
  ) => Promise<BharatCodeCapabilityState>
  reload: (scope: Scope, signal: AbortSignal) => Promise<unknown>
}) {
  const [state, setState] = createStore<{
    snapshot?: BharatCodeCapabilitySnapshot
    busy?: string
    error?: "load" | "change" | "reload"
    reloadRequired: boolean
    uncertain: boolean
  }>({ reloadRequired: false, uncertain: false })
  let generation = 0
  let active: AbortController | undefined
  let disposed = false
  createEffect(
    on(options.scope, () => {
      generation++
      active?.abort()
      setState({ snapshot: undefined, busy: undefined, error: undefined, reloadRequired: false, uncertain: false })
    }),
  )
  onCleanup(() => {
    disposed = true
    generation++
    active?.abort()
  })

  async function run<T>(
    busy: string,
    operation: (scope: Scope, signal: AbortSignal) => Promise<T>,
    success: (value: T) => void,
    error: "load" | "change" | "reload",
  ) {
    if (disposed || state.busy) return
    const scope = untrack(options.scope)
    const attempt = ++generation
    active = new AbortController()
    const signal = AbortSignal.any([active.signal, AbortSignal.timeout(30_000)])
    const current = () => !disposed && generation === attempt && scope === untrack(options.scope)
    setState({ busy, error: undefined })
    try {
      const value = await operation(scope, signal)
      if (current()) success(value)
    } catch {
      if (!current()) return
      setState("error", error)
      // A failed response may follow successful durable publication. Do not
      // replay it; require an authoritative read before any further mutation.
      if (error !== "load") setState({ uncertain: true, reloadRequired: true })
    } finally {
      if (current()) setState("busy", undefined)
    }
  }

  const refresh = () => run("refresh", options.read, (snapshot) => setState({ snapshot, uncertain: false }), "load")
  const change = (id: string, action: BharatCodeCapabilityChange["action"]) => {
    if (!state.snapshot || state.uncertain) return Promise.resolve()
    return run(
      id,
      (scope, signal) => options.change(scope, id, action, signal),
      (result) => {
        setState("snapshot", "state", result)
        setState("reloadRequired", true)
      },
      "change",
    )
  }
  const reload = () => {
    if (!state.snapshot || state.uncertain) return Promise.resolve()
    return run("reload", options.reload, () => setState("reloadRequired", false), "reload")
  }
  return { state, refresh, change, reload }
}
