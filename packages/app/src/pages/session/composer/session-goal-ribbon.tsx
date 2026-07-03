import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { IconButton } from "@opencode-ai/ui/icon-button"
import type { SessionGoal, SessionGoalUpdate } from "@opencode-ai/sdk/v2"

export type { SessionGoal, SessionGoalUpdate } from "@opencode-ai/sdk/v2"

export const GOAL_TEXT_COLLAPSED_MAX_HEIGHT = 96

export function goalElapsed(goal: SessionGoal, now = Date.now()) {
  if (goal.status !== "active" || goal.activeSince === undefined) return goal.accumulated
  return goal.accumulated + Math.max(0, now - goal.activeSince)
}

export function formatGoalElapsed(value: number) {
  const total = Math.floor(Math.max(0, value) / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function createGoalSetCommand(text: string): SessionGoalUpdate | undefined {
  const next = text.trim()
  if (!next) return undefined
  return { action: "set", text: next }
}

export function createGoalToggleCommand(goal: SessionGoal | undefined): SessionGoalUpdate | undefined {
  if (goal?.status === "active") return { action: "pause" }
  if (goal?.status === "paused") return { action: "resume" }
  return undefined
}

export function goalToggleLabel(goal: SessionGoal | undefined) {
  if (goal?.status === "active") return "Pause"
  if (goal?.status === "paused") return "Resume"
  return undefined
}

export function visibleGoal(goal: SessionGoal | undefined) {
  return goal?.status === "completed" ? undefined : goal
}

export function createGoalClearCommand(): SessionGoalUpdate {
  return { action: "clear" }
}

export function goalTextOverflowState(input: { expanded: boolean; overflow: boolean }) {
  return {
    showToggle: input.overflow,
    collapsed: input.overflow && !input.expanded,
  }
}

export function SessionGoalRibbon(props: {
  goal?: SessionGoal
  disabled?: boolean
  onUpdate: (goal: SessionGoalUpdate) => void | Promise<void>
}) {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
  const [goalExpanded, setGoalExpanded] = createSignal(false)
  const [goalOverflow, setGoalOverflow] = createSignal(false)
  let timer: number | undefined
  let goalText: HTMLParagraphElement | undefined
  let goalTextObserver: ResizeObserver | undefined

  const displayGoal = createMemo(() => visibleGoal(props.goal))
  const active = createMemo(() => displayGoal()?.status === "active")
  const visible = createMemo(() => !!displayGoal() || editing())
  const toggleLabel = createMemo(() => goalToggleLabel(displayGoal()))
  const status = createMemo(() => {
    const goal = displayGoal()
    if (!goal) return "Ready"
    if (goal.status === "active") return "Active"
    if (goal.status === "paused") return "Paused"
    if (goal.status === "blocked") return "Blocked"
    return "Complete"
  })
  const elapsed = createMemo(() => (displayGoal() ? formatGoalElapsed(goalElapsed(displayGoal()!, now())) : "0s"))
  const textOverflow = createMemo(() =>
    goalTextOverflowState({
      expanded: goalExpanded(),
      overflow: goalOverflow(),
    }),
  )

  const measureGoalText = () => {
    if (!goalText || !displayGoal() || editing()) {
      setGoalOverflow(false)
      return
    }
    setGoalOverflow(goalText.scrollHeight > GOAL_TEXT_COLLAPSED_MAX_HEIGHT + 1)
  }

  const setGoalTextRef = (el: HTMLParagraphElement) => {
    goalText = el
    goalTextObserver?.disconnect()
    goalTextObserver = new ResizeObserver(measureGoalText)
    goalTextObserver.observe(el)
    window.requestAnimationFrame(measureGoalText)
  }

  createEffect(() => {
    if (editing()) return
    setDraft(displayGoal()?.text ?? "")
  })

  createEffect((previous?: string) => {
    const goal = displayGoal()
    const key = goal ? `${goal.status}:${goal.text}` : ""
    if (key !== previous) setGoalExpanded(false)
    return key
  })

  createEffect(() => {
    const goal = displayGoal()
    if (!goal || editing()) {
      setGoalOverflow(false)
      return
    }
    goal.text
    window.requestAnimationFrame(measureGoalText)
  })

  createEffect(() => {
    if (timer !== undefined) {
      window.clearInterval(timer)
      timer = undefined
    }
    if (!active()) return
    setNow(Date.now())
    timer = window.setInterval(() => setNow(Date.now()), 1000)
  })

  onCleanup(() => {
    if (timer !== undefined) window.clearInterval(timer)
    goalTextObserver?.disconnect()
  })

  const submit = () => {
    const command = createGoalSetCommand(draft())
    if (!command) return
    void props.onUpdate(command)
    setEditing(false)
  }

  const toggle = () => {
    const command = createGoalToggleCommand(displayGoal())
    if (!command) return
    void props.onUpdate(command)
  }

  const clear = () => {
    void props.onUpdate(createGoalClearCommand())
    setEditing(false)
    setDraft("")
  }

  return (
    <Show
      when={visible()}
      fallback={
        <div class="mb-2 flex justify-end pointer-events-auto">
          <Button size="small" variant="ghost" icon="plus-small" disabled={props.disabled} onClick={() => setEditing(true)}>
            Goal Mode
          </Button>
        </div>
      }
    >
      <DockTray data-component="session-goal-ribbon" class="mb-2">
        <div class="px-3 py-2 flex flex-col gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <div class="size-2 rounded-full bg-icon-success-base shrink-0" data-active={active() ? "true" : "false"} />
            <div class="min-w-0 flex-1 flex items-center gap-2">
              <span class="text-13-medium text-text-strong shrink-0">Goal Mode</span>
              <span class="text-12-regular text-text-weak shrink-0">{status()}</span>
              <Show when={displayGoal()}>
                <span class="text-12-regular text-text-weak shrink-0">{elapsed()}</span>
              </Show>
            </div>
            <Show when={!editing() && displayGoal()}>
              <Button size="small" variant="ghost" disabled={props.disabled} onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Show when={toggleLabel()} keyed>
                {(label) => (
                  <Button size="small" variant="secondary" disabled={props.disabled} onClick={toggle}>
                    {label}
                  </Button>
                )}
              </Show>
              <IconButton
                icon="trash"
                size="normal"
                variant="ghost"
                disabled={props.disabled}
                onClick={clear}
                aria-label="Clear Goal Mode objective"
              />
            </Show>
          </div>

          <Show
            when={editing()}
            fallback={
              <Show when={displayGoal()}>
                <div class="min-w-0">
                  <p
                    ref={setGoalTextRef}
                    class="text-13-regular text-text-base whitespace-pre-wrap break-words overflow-hidden"
                    style={{
                      "max-height": textOverflow().collapsed
                        ? `${GOAL_TEXT_COLLAPSED_MAX_HEIGHT}px`
                        : undefined,
                    }}
                  >
                    {displayGoal()?.text}
                  </p>
                  <Show when={textOverflow().showToggle}>
                    <div class="mt-1 flex justify-end">
                      <IconButton
                        icon="chevron-down"
                        size="small"
                        variant="ghost"
                        disabled={props.disabled}
                        classList={{ "rotate-180": goalExpanded() }}
                        onClick={() => setGoalExpanded((value) => !value)}
                        aria-label={goalExpanded() ? "Collapse Goal Mode objective" : "Expand Goal Mode objective"}
                      />
                    </div>
                  </Show>
                </div>
              </Show>
            }
          >
            <textarea
              class="min-h-18 w-full resize-none rounded-md border border-border-weak-base bg-background-base px-3 py-2 text-13-regular text-text-strong outline-none focus:border-border-strong-base"
              value={draft()}
              disabled={props.disabled}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit()
                if (event.key === "Escape") {
                  setDraft(displayGoal()?.text ?? "")
                  setEditing(false)
                }
              }}
            />
            <div class="flex justify-end gap-2">
              <Button
                size="small"
                variant="ghost"
                disabled={props.disabled}
                onClick={() => {
                  setDraft(displayGoal()?.text ?? "")
                  setEditing(false)
                }}
              >
                Cancel
              </Button>
              <Button size="small" variant="secondary" disabled={props.disabled || !draft().trim()} onClick={submit}>
                Save
              </Button>
            </div>
          </Show>
        </div>
      </DockTray>
    </Show>
  )
}
