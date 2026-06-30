import type { Goal, Info } from "./session"

const MAX_GOAL_TEXT = 4000
const MAX_REPORT_TEXT = 4000

type TokenUsage = NonNullable<Info["tokens"]>

function bounded(input: string, fallback: string, max: number) {
  const text = input.trim() || fallback
  return text.length > max ? text.slice(0, max) : text
}

function safeNumber(value: number | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value)
}

function formatElapsed(ms: number) {
  const total = Math.floor(Math.max(0, ms) / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function account(goal: Goal, at: number): Goal {
  if (goal.status !== "active" || goal.activeSince === undefined) return { ...goal }
  return {
    ...goal,
    accumulated: goal.accumulated + Math.max(0, at - goal.activeSince),
  }
}

export namespace GoalState {
  export type SetInput = { text: string }
  export type CompleteInput = { report: string }
  export type BlockInput = { blocker: string; attempted?: string }
  export type UpdateInput =
    | { action: "set"; text: string }
    | { action: "pause" }
    | { action: "resume" }
    | { action: "clear" }

  export function isActive(goal: Goal | null | undefined): goal is Goal & { status: "active" } {
    return goal?.status === "active"
  }

  export function isPaused(goal: Goal | null | undefined): goal is Goal & { status: "paused" } {
    return goal?.status === "paused"
  }

  export function isTerminal(goal: Goal | null | undefined): goal is Goal & { status: "completed" | "blocked" } {
    return goal?.status === "completed" || goal?.status === "blocked"
  }

  export function set(current: Goal | undefined, input: SetInput, at: number): Goal {
    const previous = current && !isTerminal(current) ? account(current, at) : undefined
    return {
      text: bounded(input.text, "Continue working toward the user's stated objective.", MAX_GOAL_TEXT),
      status: "active",
      created: previous?.created ?? at,
      updated: at,
      accumulated: previous?.accumulated ?? 0,
      activeSince: at,
    }
  }

  export function pause(current: Goal, at: number): Goal {
    const goal = account(current, at)
    return {
      ...goal,
      status: "paused",
      updated: at,
      activeSince: undefined,
    }
  }

  export function resume(current: Goal, at: number): Goal {
    return {
      ...current,
      status: "active",
      updated: at,
      activeSince: at,
      completed: undefined,
      report: undefined,
    }
  }

  export function complete(current: Goal, input: CompleteInput, at: number): Goal {
    const goal = account(current, at)
    return {
      ...goal,
      status: "completed",
      updated: at,
      completed: at,
      activeSince: undefined,
      report: bounded(input.report, "Goal completed.", MAX_REPORT_TEXT),
    }
  }

  export function block(current: Goal, input: BlockInput, at: number): Goal {
    const report = [
      bounded(input.blocker, "Goal blocked.", MAX_REPORT_TEXT),
      input.attempted?.trim() ? `Tried: ${input.attempted.trim()}` : undefined,
    ]
      .filter(Boolean)
      .join("\n")
    const goal = account(current, at)
    return {
      ...goal,
      status: "blocked",
      updated: at,
      completed: at,
      activeSince: undefined,
      report: bounded(report, "Goal blocked.", MAX_REPORT_TEXT),
    }
  }

  export function update(current: Goal | undefined, input: UpdateInput, at: number) {
    if (input.action === "set") return { goal: set(current, { text: input.text }, at), shouldRun: true }
    if (input.action === "pause") {
      if (!isActive(current)) return { goal: undefined, shouldRun: false }
      return { goal: pause(current, at), shouldRun: false }
    }
    if (input.action === "resume") {
      if (!isPaused(current)) return { goal: undefined, shouldRun: false }
      return { goal: resume(current, at), shouldRun: true }
    }
    return { goal: null, shouldRun: false }
  }

  export function elapsed(goal: Goal, at = Date.now()) {
    return account(goal, at).accumulated
  }

  export function formatMetrics(goal: Goal, tokens: TokenUsage) {
    const input = safeNumber(tokens.input)
    const output = safeNumber(tokens.output)
    const reasoning = safeNumber(tokens.reasoning)
    const cacheRead = safeNumber(tokens.cache.read)
    const cacheWrite = safeNumber(tokens.cache.write)
    const total = input + output + reasoning + cacheRead + cacheWrite

    return [
      "Goal Mode metrics:",
      `- Elapsed: ${formatElapsed(elapsed(goal))}`,
      `- Tokens: ${formatNumber(total)} total (` +
        `${formatNumber(input)} input, ` +
        `${formatNumber(output)} output, ` +
        `${formatNumber(reasoning)} reasoning, ` +
        `${formatNumber(cacheRead)} cache read, ` +
        `${formatNumber(cacheWrite)} cache write)`,
    ].join("\n")
  }
}
