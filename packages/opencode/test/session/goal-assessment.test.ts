import { expect, test } from "bun:test"
import { GoalAssessment } from "@/session/goal-assessment"

test("requests an assessment after a normal assistant stop with an active goal", () => {
  expect(
    GoalAssessment.shouldRequest({
      goalStatus: "active",
      lastAssistantFinishedNormally: true,
      hasToolCalls: false,
    }),
  ).toBe(true)
})

test("requests another assessment even when the last user message is already an assessment", () => {
  expect(
    GoalAssessment.shouldRequest({
      goalStatus: "active",
      lastAssistantFinishedNormally: true,
      hasToolCalls: false,
    }),
  ).toBe(true)
})

test("does not request assessment when the model produced tool calls", () => {
  expect(
    GoalAssessment.shouldRequest({
      goalStatus: "active",
      lastAssistantFinishedNormally: true,
      hasToolCalls: true,
    }),
  ).toBe(false)
})

test("does not inspect assistant text or use keyword matching", () => {
  expect(
    GoalAssessment.shouldRequest({
      goalStatus: "active",
      lastAssistantFinishedNormally: true,
      hasToolCalls: false,
    }),
  ).toBe(true)
})
