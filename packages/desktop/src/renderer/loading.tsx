import { MetaProvider } from "@solidjs/meta"
import { render } from "solid-js/web"
import "@opencode-ai/app/index.css"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { Progress } from "@opencode-ai/ui/progress"
import { Button } from "@opencode-ai/ui/button"
import "./styles.css"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { InitStep, RecoveryAction, SqliteMigrationProgress } from "../preload/types"
import { availableRecoveryActions, createRecoveryController, type RecoveryView } from "./loading-recovery"
import { startLoadingInitialization } from "./loading-initialization"

const root = document.getElementById("root")!
const lines = ["Just a moment...", "Migrating your BharatCode database", "This may take a couple of minutes"]
const delays = [3000, 9000]

render(() => {
  const [step, setStep] = createSignal<InitStep | null>(null)
  const [line, setLine] = createSignal(0)
  const [percent, setPercent] = createSignal(0)
  const [view, setView] = createSignal<RecoveryView>({ status: null, busy: null, error: null })
  const [confirmFresh, setConfirmFresh] = createSignal(false)
  const recovery = () => view().status
  const inFlight = () => view().busy !== null
  const controller = createRecoveryController({
    inspect: () => window.api.inspectRecovery(),
    run: (action) => window.api.runRecovery(action),
    update: setView,
  })

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

  onCleanup(
    startLoadingInitialization({
      wait: (send) => window.api.awaitInitialization(send),
      update: setStep,
      complete: () => window.api.loadingWindowComplete(),
      failed: (error) => setView((current) => ({ ...current, error })),
    }),
  )
  void controller.inspect()
  const runRecovery = (action: RecoveryAction) => {
    if (inFlight()) return
    setConfirmFresh(false)
    return controller.run(action)
  }

  onMount(() => {
    setLine(0)
    setPercent(0)

    const timers = delays.map((ms, i) => setTimeout(() => setLine(i + 1), ms))

    const listener = window.api.onSqliteMigrationProgress((progress: SqliteMigrationProgress) => {
      if (progress.type === "InProgress") setPercent(Math.max(0, Math.min(100, progress.value)))
      if (progress.type === "Done") {
        setPercent(100)
      }
    })

    onCleanup(() => {
      listener()
      timers.forEach(clearTimeout)
    })
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
      <div class="recovery-shell bg-background-base">
        <Font />
        <div class="recovery-content">
          <Splash class="w-12 h-15 opacity-30 shrink-0" />
          <div class="recovery-panel" aria-live="polite" aria-busy={inFlight()}>
            <h1 class="recovery-heading text-text-strong">{status()}</h1>
            <Show when={view().error}>
              <p role="alert" class="recovery-message text-text-strong">
                {view().error}
              </p>
            </Show>
            <Show when={inFlight()}>
              <p role="status" class="text-text-base text-14-normal">
                {view().busy === "inspect" ? "Checking recovery…" : "Working… Please keep this window open."}
              </p>
            </Show>
            <Show
              when={(recovery() && recovery()?.state !== "ready") || view().error}
              fallback={
                <Progress
                  value={value()}
                  class="w-20 [&_[data-slot='progress-track']]:h-1 [&_[data-slot='progress-track']]:border-0 [&_[data-slot='progress-track']]:rounded-none [&_[data-slot='progress-track']]:bg-surface-weak [&_[data-slot='progress-fill']]:rounded-none [&_[data-slot='progress-fill']]:bg-icon-warning-base"
                  aria-label="Database migration progress"
                  getValueLabel={({ value }) => `${Math.round(value)}%`}
                />
              }
            >
              <div class="recovery-actions">
                <Show when={recoveryActions().includes("choose-source")}>
                  <For each={sourceChoices()}>
                    {(source) => (
                      <Button
                        variant="primary"
                        size="large"
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
                        Continue with {source.label}
                      </Button>
                    )}
                  </For>
                </Show>
                <Show when={recoveryActions().includes("retry")}>
                  <Button
                    variant="primary"
                    size="large"
                    type="button"
                    disabled={inFlight()}
                    onClick={() => {
                      const current = recovery()
                      if (current?.state === "retry")
                        void runRecovery({ type: "retry", operationID: current.operationID })
                    }}
                  >
                    Retry
                  </Button>
                </Show>
                <Show when={recoveryActions().includes("repair-marker")}>
                  <Button
                    variant="primary"
                    size="large"
                    type="button"
                    disabled={inFlight()}
                    onClick={() => runRecovery({ type: "repair-marker", confirmed: true })}
                  >
                    Repair Database Marker
                  </Button>
                </Show>
                <Show when={recoveryActions().includes("start-fresh")}>
                  <Show
                    when={confirmFresh()}
                    fallback={
                      <Button
                        type="button"
                        size="large"
                        variant="secondary"
                        disabled={inFlight()}
                        onClick={() => setConfirmFresh(true)}
                      >
                        Start Fresh
                      </Button>
                    }
                  >
                    <p class="recovery-message text-text-base">
                      Start with empty BharatCode data? Existing source data stays unchanged; incomplete destination
                      data is kept in recovery quarantine.
                    </p>
                    <Button
                      type="button"
                      size="large"
                      variant="primary"
                      disabled={inFlight()}
                      onClick={() => runRecovery({ type: "start-fresh", confirmed: true })}
                    >
                      Confirm Start Fresh
                    </Button>
                    <Button
                      type="button"
                      size="large"
                      variant="secondary"
                      disabled={inFlight()}
                      onClick={() => setConfirmFresh(false)}
                    >
                      Keep recovery choices
                    </Button>
                  </Show>
                </Show>
                <Show when={view().error}>
                  <Button
                    type="button"
                    size="large"
                    variant="secondary"
                    disabled={inFlight()}
                    onClick={() => controller.inspect()}
                  >
                    Check again
                  </Button>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </MetaProvider>
  )
}, root)
