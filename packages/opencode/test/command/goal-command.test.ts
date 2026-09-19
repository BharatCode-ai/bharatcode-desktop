import { describe, expect, test } from "bun:test"
import { Command } from "@/command"
import PROMPT_GOAL from "@/command/template/goal.txt"

describe("goal slash command", () => {
  test("ships a built-in command template that passes user arguments to Goal Mode", () => {
    expect(Command.Default.GOAL).toBe("goal")
    expect(PROMPT_GOAL).toContain("$ARGUMENTS")
    expect(PROMPT_GOAL).toContain("mcp_goal_set")
    expect(Command.hints(PROMPT_GOAL)).toContain("$ARGUMENTS")
  })
})
