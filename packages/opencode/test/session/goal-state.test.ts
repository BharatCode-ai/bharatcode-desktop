import { expect, test } from "bun:test"
import { GoalState } from "@/session/goal-state"

test("set creates an active bounded goal with server timestamps", () => {
  const goal = GoalState.set(undefined, { text: "  Build release checklist  " }, 100)
  expect(goal).toEqual({
    text: "Build release checklist",
    status: "active",
    created: 100,
    updated: 100,
    accumulated: 0,
    activeSince: 100,
  })
})

test("pause accounts active elapsed time once", () => {
  const active = GoalState.set(undefined, { text: "Build release checklist" }, 100)
  const paused = GoalState.pause(active, 160)
  expect(paused.status).toBe("paused")
  expect(paused.accumulated).toBe(60)
  expect(paused.activeSince).toBeUndefined()
})

test("resume does not double count paused time", () => {
  const active = GoalState.set(undefined, { text: "Build release checklist" }, 100)
  const paused = GoalState.pause(active, 160)
  const resumed = GoalState.resume(paused, 220)
  const complete = GoalState.complete(resumed, { report: "Validated with tests." }, 250)
  expect(complete.status).toBe("completed")
  expect(complete.accumulated).toBe(90)
  expect(complete.completed).toBe(250)
  expect(complete.report).toBe("Validated with tests.")
})

test("blocker report includes attempted work when provided", () => {
  const active = GoalState.set(undefined, { text: "Deploy beta" }, 100)
  const blocked = GoalState.block(active, { blocker: "Missing release token", attempted: "Checked repo secrets" }, 130)
  expect(blocked.status).toBe("blocked")
  expect(blocked.report).toBe("Missing release token\nTried: Checked repo secrets")
})

test("text and reports are bounded before persistence or prompt injection", () => {
  const longText = "x".repeat(10_000)
  const goal = GoalState.set(undefined, { text: longText }, 100)
  expect(goal.text.length).toBe(4000)

  const completed = GoalState.complete(goal, { report: "y".repeat(10_000) }, 200)
  expect(completed.report?.length).toBe(4000)
})

test("formats elapsed time and token metrics for final tool output", () => {
  const active = GoalState.set(undefined, { text: "Ship release" }, 1_000)
  const completed = GoalState.complete(active, { report: "Done." }, 91_000)
  const metrics = GoalState.formatMetrics(completed, {
    input: 1_000,
    output: 200,
    reasoning: 30,
    cache: { read: 40, write: 50 },
  })

  expect(metrics).toBe(
    [
      "Goal Mode metrics:",
      "- Elapsed: 1m 30s",
      "- Tokens: 1,320 total (1,000 input, 200 output, 30 reasoning, 40 cache read, 50 cache write)",
    ].join("\n"),
  )
})
