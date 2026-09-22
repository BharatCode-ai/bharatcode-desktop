import { describe, expect, test } from "bun:test"
import { FileSystem } from "../src/filesystem"
import { Schema } from "effect"
import { SessionGoal } from "../src/session-goal"
import { SessionV1 } from "../src/session-v1"

describe("schema compatibility", () => {
  test("Goal Mode has one canonical schema across current storage and V1", () => {
    expect(SessionV1.SessionGoal).toBe(SessionGoal.Info)
    expect(SessionV1.SessionGoalStatus).toBe(SessionGoal.Status)
    const goal = { text: "Complete work", status: "paused" as const, created: 1, updated: 2, accumulated: 3 }
    expect(Schema.encodeSync(SessionGoal.Info)(goal)).toEqual(goal)
    expect(Schema.encodeSync(SessionGoal.Info)(goal)).not.toHaveProperty("activeSince")
  })
  test("moved class schemas remain constructible", () => {
    const input = new FileSystem.FindInput({ query: "src" })
    expect(input).toBeInstanceOf(FileSystem.FindInput)
    expect(input.query).toBe("src")
  })
})
