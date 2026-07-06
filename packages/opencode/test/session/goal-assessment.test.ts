import { expect, test } from "bun:test"
import { GoalAssessment } from "@/session/goal-assessment"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"

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

const sessionID = SessionID.make("ses_goal_assessment_policy")

function assistant(index: number, text: string): MessageV2.WithParts {
  const id = MessageID.make(`msg_goal_assessment_assistant_${index}`)
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID: MessageID.make(`msg_goal_assessment_user_${index}`),
      path: { cwd: "/tmp", root: "/tmp" },
      time: { created: index, completed: index + 1 },
      agent: "build",
      mode: "build",
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("test-model"),
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.make(`prt_goal_assessment_text_${index}`),
        messageID: id,
        sessionID,
        type: "text",
        text,
      },
    ],
  }
}

test("detects repeated assistant response fingerprints without exposing content", () => {
  const text =
    "I will inspect the same files again and then apply the same fix if the diagnostics point to it."
  const current = assistant(2, text)

  const result = GoalAssessment.repeatedAssistantResponse({
    messages: [assistant(1, text), current],
    assistant: current,
  })

  expect(result).toEqual({ count: 2, threshold: 2 })
})

test("ignores short repeated acknowledgements", () => {
  const current = assistant(2, "ok")

  expect(
    GoalAssessment.repeatedAssistantResponse({
      messages: [assistant(1, "ok"), current],
      assistant: current,
    }),
  ).toBeUndefined()
})
