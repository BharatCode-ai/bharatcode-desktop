import { createHash } from "node:crypto"
import { MessageV2 } from "./message-v2"
import type { GoalStatus } from "./session"

const REPEATED_ASSISTANT_THRESHOLD = 2
const REPEATED_ASSISTANT_MIN_LENGTH = 40
const RECENT_MESSAGES = 80

export namespace GoalAssessment {
  export function shouldRequest(input: {
    goalStatus?: GoalStatus
    lastAssistantFinishedNormally: boolean
    hasToolCalls: boolean
  }) {
    return input.goalStatus === "active" && input.lastAssistantFinishedNormally && !input.hasToolCalls
  }

  export function progressPolicy() {
    return [
      "Meaningful progress means new verified state: a code/doc/config change, a new test or command result, a new inspected artifact, a new concrete decision, or a validated completion report.",
      "If the next step repeats prior reasoning, diagnosis, wording, or the same tool/action signature, either choose a materially different concrete action now or call mcp_goal_blocker.",
      "Repeated same tool/action signatures, repeated same assistant-response fingerprints, tool-loop guards, and user-aborted command context are blocker signals unless there is a clearly different next path.",
    ]
  }

  export function repeatedAssistantResponse(input: {
    messages: MessageV2.WithParts[]
    assistant: MessageV2.WithParts
    threshold?: number
    recentMessages?: number
  }) {
    const threshold = input.threshold ?? REPEATED_ASSISTANT_THRESHOLD
    const current = assistantText(input.assistant)
    if (!current || current.length < REPEATED_ASSISTANT_MIN_LENGTH) return
    const fingerprint = textFingerprint(current)
    const count = input.messages
      .slice(-(input.recentMessages ?? RECENT_MESSAGES))
      .filter((message) => message.info.role === "assistant")
      .map(assistantText)
      .filter((text) => text && textFingerprint(text) === fingerprint).length
    if (count < threshold) return
    return { count, threshold }
  }

  export function hasUserAbortedTool(input: { messages: MessageV2.WithParts[]; recentMessages?: number }) {
    return input.messages.slice(-(input.recentMessages ?? RECENT_MESSAGES)).some((message) =>
      message.parts.some((part) => {
        if (part.type !== "tool") return false
        if (part.state.status === "error") return isAbortText(part.state.error)
        if (part.state.status === "completed") return isAbortText(part.state.output)
        return false
      }),
    )
  }

  export function assessmentNotes(input: { messages: MessageV2.WithParts[]; assistant?: MessageV2.WithParts }) {
    const notes: string[] = []
    if (input.assistant) {
      const repeated = repeatedAssistantResponse({ messages: input.messages, assistant: input.assistant })
      if (repeated) {
        notes.push(
          `Current blocker signal: the assistant has repeated substantially the same response ${repeated.count} times. Do not repeat that response again.`,
        )
      }
    }
    if (hasUserAbortedTool({ messages: input.messages })) {
      notes.push(
        "Current blocker signal: A recent tool or command was user-aborted. Respect that interruption; do not retry the same action unless you have a clearly different path.",
      )
    }
    return notes
  }
}

function assistantText(message: MessageV2.WithParts) {
  return message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
}

function textFingerprint(input: string) {
  return createHash("sha256").update(input.toLowerCase()).digest("hex").slice(0, 16)
}

function isAbortText(input: string) {
  return /user aborted|tool execution aborted|aborted the command/i.test(input)
}
