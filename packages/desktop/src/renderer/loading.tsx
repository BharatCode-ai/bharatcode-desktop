import { MetaProvider } from "@solidjs/meta"
import { render } from "solid-js/web"
import "@opencode-ai/app/index.css"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { Progress } from "@opencode-ai/ui/progress"
import "./styles.css"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { InitStep, RecoveryAction, RecoveryStatus, SqliteMigrationProgress } from "../preload/types"
import { availableRecoveryActions } from "./loading-recovery"

const root = document.getElementById("root")!
const lines = ["Just a moment...", "Migrating your BharatCode database", "This may take a couple of minutes"]
const delays = [3000, 9000]

render(() => {
  const [step, setStep] = createSignal<InitStep | null>(null)
  const [line, setLine] = createSignal(0)
  const [percent, setPercent] = createSignal(0)
  const [recovery, setRecovery] = createSignal<RecoveryStatus | null>(null)
  const [inFlight, setInFlight] = createSignal(false)

  const phase = createMemo(() => step()?.phase)
  const sourceChoices = createMemo(() => {
    const current = recovery()
    return current?.state === "choose-source" ? current.sources : []
  })
  const recoveryActions = createMemo(() => availableRecoveryActions(recovery()))

  const value = createMemo(() => {
    if (phase() === "done") return 100
    return Math.max(25, Math.min(100, percent()))
  })

  window.api.awaitInitialization((next) => setStep(next as InitStep)).catch(() => undefined)
  window.api
    .inspectRecovery()
    .then(setRecovery)
    .catch(() => setRecovery({ state: "blocked", reason: "corrupt" }))

  const runRecovery = async (action: RecoveryAction) => {
    if (inFlight()) return
    setInFlight(true)
    try {
      setRecovery(await window.api.runRecovery(action))
    } catch {
      setRecovery({ state: "blocked", reason: "corrupt" })
    } finally {
      setInFlight(false)
    }
  }

  onMount(() => {
    setLine(0)
    setPercent(0)

    const timers = delays.map((ms, i) => setTimeout(() => setLine(i + 1), ms))

    const listener = window.api.onSqliteMigrationProgress((progress: SqliteMigrationProgress) => {
      if (progress.type === "InProgress") setPercent(Math.max(0, Math.min(100, progress.value)))
      if (progress.type === "Done") {
        setPercent(100)
        setStep({ phase: "done" })
      }
    })

    onCleanup(() => {
      listener()
      timers.forEach(clearTimeout)
    })
  })

  createEffect(() => {
    if (phase() !== "done") return

    const timer = setTimeout(() => window.api.loadingWindowComplete(), 1000)
    onCleanup(() => clearTimeout(timer))
  })

  const status = createMemo(() => {
    const current = recovery()
    if (current?.state === "choose-source") return "Choose existing data to migrate"
    if (current?.state === "retry") return "Finish the interrupted migration"
    if (current?.state === "start-fresh") return "No existing data was selected"
    if (current?.state === "marker-repair") return "The database marker needs repair"
    if (current?.state === "blocked") return "BharatCode recovery needs attention"
    if (phase() === "done") return "All done"
    if (phase() === "sqlite_waiting") return lines[line()]
    return "Just a moment..."
  })

  return (
    <MetaProvider>
      <div class="w-screen h-screen bg-background-base flex items-center justify-center">
        <Font />
        <div class="flex flex-col items-center gap-11">
          <Splash class="w-20 h-25 opacity-15" />
          <div class="w-60 flex flex-col items-center gap-4" aria-live="polite">
            <span class="w-full overflow-hidden text-center text-ellipsis whitespace-nowrap text-text-strong text-14-normal">
              {status()}
            </span>
            <Show
              when={recovery() && recovery()?.state !== "ready"}
              fallback={
                <Progress
                  value={value()}
                  class="w-20 [&_[data-slot='progress-track']]:h-1 [&_[data-slot='progress-track']]:border-0 [&_[data-slot='progress-track']]:rounded-none [&_[data-slot='progress-track']]:bg-surface-weak [&_[data-slot='progress-fill']]:rounded-none [&_[data-slot='progress-fill']]:bg-icon-warning-base"
                  aria-label="Database migration progress"
                  getValueLabel={({ value }) => `${Math.round(value)}%`}
                />
              }
            >
              <div class="flex w-full flex-col gap-2">
                <Show when={recoveryActions().includes("choose-source")}>
                  <For each={sourceChoices()}>
                    {(source) => (
                      <button
                        type="button"
                        disabled={inFlight()}
                        onClick={() =>
                          runRecovery({
                            type: "choose-source",
                            id: source.id,
                            contentFingerprint: source.contentFingerprint,
                          })
                        }
                      >
                        Choose Source · {source.label}
                      </button>
                    )}
                  </For>
                </Show>
                <Show when={recoveryActions().includes("retry")}>
                  <button
                    type="button"
                    disabled={inFlight()}
                    onClick={() => {
                      const current = recovery()
                      if (current?.state === "retry")
                        void runRecovery({ type: "retry", operationID: current.operationID })
                    }}
                  >
                    Retry
                  </button>
                </Show>
                <Show when={recoveryActions().includes("repair-marker")}>
                  <button
                    type="button"
                    disabled={inFlight()}
                    onClick={() => runRecovery({ type: "repair-marker", confirmed: true })}
                  >
                    Repair Database Marker
                  </button>
                </Show>
                <Show when={recoveryActions().includes("start-fresh")}>
                  <button
                    type="button"
                    disabled={inFlight()}
                    onClick={() => runRecovery({ type: "start-fresh", confirmed: true })}
                  >
                    Start Fresh
                  </button>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </MetaProvider>
  )
}, root)
