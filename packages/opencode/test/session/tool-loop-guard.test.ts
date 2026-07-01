import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ToolLoopGuard } from "../../src/session/tool-loop-guard"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const sessionID = SessionID.make("session-tool-loop-guard")

function assistantMessage(index: number, input: Record<string, unknown>, error = "exit status 1"): MessageV2.WithParts {
  const messageID = MessageID.make(`msg_assistant-tool-loop-${index}`)
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      path: { cwd: "/tmp", root: "/tmp" },
      time: { created: 0, completed: 1 },
      parentID: MessageID.make(`msg_user-tool-loop-${index}`),
      agent: "build",
      mode: "build",
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("test"),
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: PartID.make(`prt_tool-loop-${index}`),
        messageID,
        sessionID,
        type: "tool",
        callID: `call_${index}`,
        tool: "bash",
        state: {
          status: "error",
          input,
          error,
          time: { start: 0, end: 1 },
        },
      },
    ],
  }
}

describe("ToolLoopGuard", () => {
  test("detects repeated failed calls without exposing raw input", () => {
    const result = ToolLoopGuard.repeatedFailure({
      messages: [
        assistantMessage(1, { command: "secret-token command", workdir: "/repo" }),
        assistantMessage(2, { workdir: "/repo", command: "secret-token command" }),
        assistantMessage(3, { command: "secret-token command", workdir: "/repo" }),
      ],
      tool: "bash",
      input: { workdir: "/repo", command: "secret-token command" },
    })

    expect(result?.count).toBe(3)
    expect(result?.inputFingerprint).toBe(ToolLoopGuard.inputFingerprint({ command: "secret-token command", workdir: "/repo" }))
    expect(ToolLoopGuard.message(result!)).not.toContain("secret-token")
    expect(ToolLoopGuard.message(result!)).toContain("bash")
  })

  test("ignores different inputs and non-error tool calls", () => {
    const messageID = MessageID.make("msg_assistant-tool-loop-completed")
    const completed: MessageV2.WithParts = {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        path: { cwd: "/tmp", root: "/tmp" },
        time: { created: 0, completed: 1 },
        parentID: MessageID.make("msg_user-tool-loop-completed"),
        agent: "build",
        mode: "build",
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test"),
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: PartID.make("prt_tool-loop-completed"),
          messageID,
          sessionID,
          type: "tool",
          callID: "call_completed",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "pwd" },
            output: "ok",
            title: "bash",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        },
      ],
    }

    expect(
      ToolLoopGuard.repeatedFailure({
        messages: [
          assistantMessage(1, { command: "pwd" }),
          assistantMessage(2, { command: "ls" }),
          completed,
        ],
        tool: "bash",
        input: { command: "pwd" },
      }),
    ).toBeUndefined()
  })
})
