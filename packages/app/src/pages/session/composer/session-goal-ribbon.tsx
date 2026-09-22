import { Show, createEffect, createUniqueId, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { useLanguage } from "@/context/language"
import type { SessionGoal, SessionGoalUpdate } from "@opencode-ai/sdk/v2/client"
import {
  createSessionGoalController,
  formatGoalElapsed,
  goalElapsed,
  goalSetCommand,
  goalTextLimit,
  goalToggleCommand,
} from "./session-goal-state"

export function SessionGoalRibbon(props: {
  sessionKey: string
  goal?: SessionGoal
  disabled?: boolean
  onUpdate: (command: SessionGoalUpdate) => Promise<void>
}) {
  const language = useLanguage()
  const id = createUniqueId()
  const controller = createSessionGoalController({
    key: () => props.sessionKey,
    goal: () => props.goal,
    update: (command) => props.onUpdate(command),
  })
  const [clock, setClock] = createStore({ now: Date.now() })
  const goal = () => (props.goal?.status === "completed" ? undefined : props.goal)
  const disabled = () => props.disabled || controller.state.pending
  createEffect(() => {
    if (goal()?.status !== "active") return
    setClock("now", Date.now())
    const timer = setInterval(() => setClock("now", Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const save = () => {
    if (!disabled()) void controller.save()
  }

  return (
    <section class="mb-2" aria-label={language.t("session.goal.title")} aria-busy={controller.state.pending}>
      <Show
        when={goal() || controller.state.editing}
        fallback={
          <Button variant="ghost" size="small" disabled={disabled()} onClick={controller.edit}>
            {language.t("session.goal.title")}
          </Button>
        }
      >
        <DockTray class="px-3 py-2">
          <div class="flex flex-wrap items-center gap-2 text-12-medium text-text-weak">
            <span class="text-text-strong">{language.t("session.goal.title")}</span>
            <Show when={goal()}>
              {(current) => (
                <>
                  <span>{language.t(`session.goal.status.${current().status}`)}</span>
                  <span class="tabular-nums">{formatGoalElapsed(goalElapsed(current(), clock.now))}</span>
                </>
              )}
            </Show>
            <Show when={!controller.state.editing}>
              <div class="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="small" disabled={disabled()} onClick={controller.edit}>
                  {language.t("common.edit")}
                </Button>
                <Show when={goalToggleCommand(goal())}>
                  {(command) => (
                    <Button
                      variant="ghost"
                      size="small"
                      disabled={disabled()}
                      onClick={() => void controller.run(command())}
                    >
                      {language.t(goal()?.status === "active" ? "session.goal.pause" : "session.goal.resume")}
                    </Button>
                  )}
                </Show>
                <Button
                  variant="ghost"
                  size="small"
                  disabled={disabled()}
                  onClick={() => void controller.run({ action: "clear" })}
                >
                  {language.t("session.goal.clear")}
                </Button>
              </div>
            </Show>
          </div>
          <Show
            when={controller.state.editing}
            fallback={
              <>
                <p
                  id={id}
                  class="mt-1 text-14-regular text-text-base whitespace-pre-wrap break-words overflow-auto"
                  classList={{ "max-h-24": !controller.state.expanded }}
                >
                  {goal()?.text}
                </p>
                <Show when={(goal()?.text.length ?? 0) > 140}>
                  <Button
                    variant="ghost"
                    size="small"
                    aria-expanded={controller.state.expanded}
                    aria-controls={id}
                    onClick={controller.toggleExpanded}
                  >
                    {language.t(controller.state.expanded ? "session.goal.collapse" : "session.goal.expand")}
                  </Button>
                </Show>
                <Show when={goal()?.report}>
                  <p class="mt-1 text-12-regular text-text-weak whitespace-pre-wrap break-words max-h-24 overflow-auto">
                    {goal()?.report}
                  </p>
                </Show>
              </>
            }
          >
            <textarea
              aria-label={language.t("session.goal.objective")}
              class="mt-2 w-full min-h-20 resize-y rounded-md border border-border-weak-base bg-background-base px-3 py-2 text-14-regular text-text-base focus-visible:outline-2 focus-visible:outline-border-active"
              rows={3}
              maxLength={goalTextLimit}
              disabled={disabled()}
              value={controller.state.draft}
              ref={(el) =>
                queueMicrotask(() => {
                  if (el.isConnected) el.focus()
                })
              }
              onInput={(event) => controller.setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.isComposing) return
                if (event.key === "Escape") {
                  event.preventDefault()
                  controller.cancel()
                }
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  save()
                }
              }}
            />
            <div class="mt-2 flex justify-end gap-2">
              <Button variant="ghost" size="small" disabled={disabled()} onClick={controller.cancel}>
                {language.t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="small"
                disabled={disabled() || !goalSetCommand(controller.state.draft)}
                onClick={save}
              >
                {language.t("common.save")}
              </Button>
            </div>
          </Show>
        </DockTray>
      </Show>
      <Show when={controller.state.pending}>
        <p role="status" class="mt-1 text-12-regular text-text-weak">
          {language.t("session.goal.updating")}
        </p>
      </Show>
      <Show when={controller.state.error}>
        <p role="alert" class="mt-1 text-12-regular text-text-weak">
          {language.t("session.goal.error")}
        </p>
      </Show>
    </section>
  )
}
