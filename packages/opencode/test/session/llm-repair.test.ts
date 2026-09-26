import { describe, expect, test } from "bun:test"
import { modelMessageSchema } from "ai"
import { repairMessages } from "../../src/session/llm/repair"

const validAll = (messages: unknown) => modelMessageSchema.array().safeParse(messages).success

describe("repairMessages", () => {
  test("returns valid history untouched", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        providerOptions: { openaiCompatible: { reasoning_content: "thought" } },
      },
    ] as any
    const result = repairMessages(messages)
    expect(result.messages).toBe(messages)
    expect(result.issues).toEqual([])
  })

  test("repairs malformed provider metadata and null optional fields instead of failing the turn", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "file", data: "https://x/a.png", mediaType: "image/png", filename: null }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: { bharatcode: "not-a-record" } },
          { type: "text", text: "hello", providerOptions: { openaiCompatible: { value: undefined, fn: () => 1 } } },
        ],
      },
      { role: "user", content: [{ type: "text", text: "whats wrong" }] },
    ] as any
    expect(validAll(messages)).toBe(false)

    const result = repairMessages(messages)
    expect(validAll(result.messages)).toBe(true)
    expect(result.messages).toHaveLength(4)
    expect(result.issues.map((issue) => [issue.index, issue.action])).toEqual([
      [1, "repaired"],
      [2, "repaired"],
    ])
    expect((result.messages[2] as any).content.map((part: any) => part.text)).toEqual(["thinking", "hello"])
  })

  test("drops unrepairable parts, and tool results whose call was dropped", () => {
    const messages = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool-call", toolCallId: 42, toolName: "glob", input: {} },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "42", toolName: "glob", output: { type: "text", value: "x" } }],
      },
      { role: "bogus", content: "?" },
    ] as any

    const result = repairMessages(messages)
    expect(validAll(result.messages)).toBe(true)
    expect(result.messages.map((msg) => msg.role)).toEqual(["user", "assistant"])
    expect(result.issues.find((issue) => issue.index === 3)?.action).toBe("dropped")
  })
})
