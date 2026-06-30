import type { GoalStatus } from "./session"

export namespace GoalAssessment {
  export function shouldRequest(input: {
    goalStatus?: GoalStatus
    lastAssistantFinishedNormally: boolean
    hasToolCalls: boolean
  }) {
    return input.goalStatus === "active" && input.lastAssistantFinishedNormally && !input.hasToolCalls
  }
}
