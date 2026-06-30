import { describe, expect, test } from "bun:test"
import type { SessionGoal } from "@opencode-ai/sdk/v2"
import {
  createGoalClearCommand,
  createGoalSetCommand,
  createGoalToggleCommand,
  goalToggleLabel,
  formatGoalElapsed,
  goalElapsed,
} from "./session-goal-ribbon"

const goal = (status: SessionGoal["status"], activeSince?: number): SessionGoal => ({
  text: "Ship Goal Mode",
  status,
  created: 1,
  updated: 1,
  accumulated: 30_000,
  activeSince,
})

describe("SessionGoalRibbon helpers", () => {
  test("builds public session goal update commands", () => {
    expect(createGoalSetCommand("  Ship Goal Mode  ")).toEqual({ action: "set", text: "Ship Goal Mode" })
    expect(createGoalSetCommand(" ")).toBeUndefined()
    expect(createGoalClearCommand()).toEqual({ action: "clear" })
  })

  test("toggles active and paused goals", () => {
    expect(createGoalToggleCommand(goal("active"))).toEqual({ action: "pause" })
    expect(createGoalToggleCommand(goal("paused"))).toEqual({ action: "resume" })
    expect(createGoalToggleCommand(goal("completed"))).toBeUndefined()
    expect(createGoalToggleCommand(undefined)).toBeUndefined()
    expect(goalToggleLabel(goal("active"))).toBe("Pause")
    expect(goalToggleLabel(goal("paused"))).toBe("Resume")
    expect(goalToggleLabel(goal("completed"))).toBeUndefined()
    expect(goalToggleLabel(goal("blocked"))).toBeUndefined()
  })

  test("formats elapsed active goal time", () => {
    expect(goalElapsed(goal("active", 10_000), 100_000)).toBe(120_000)
    expect(goalElapsed(goal("paused", 10_000), 100_000)).toBe(30_000)
    expect(formatGoalElapsed(120_000)).toBe("2m 0s")
  })
})
