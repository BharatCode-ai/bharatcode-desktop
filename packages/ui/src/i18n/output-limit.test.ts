import { describe, expect, test } from "bun:test"
import { outputLimitKey } from "./output-limit"
import { dict } from "./en"

describe("output-limit notice", () => {
  test("distinguishes partial answers, reasoning, unfinished tools and unknown output", () => {
    const cases = [
      [[{ type: "text", text: "Partial answer" }], "ui.message.outputLimit.partial"],
      [[{ type: "reasoning", text: "Still thinking" }], "ui.message.outputLimit.reasoning"],
      [
        [
          { type: "text", text: "Starting" },
          { type: "tool", state: { status: "pending" } },
        ],
        "ui.message.outputLimit.tool",
      ],
      [[], "ui.message.outputLimit"],
    ] as const
    for (const [parts, key] of cases) {
      const before = JSON.stringify(parts)
      expect(outputLimitKey({ finish: "length" }, parts)).toBe(key)
      expect(dict[key]).toContain("output limit")
      expect(JSON.stringify(parts)).toBe(before)
    }
  })
  test("does not mask errors, interruptions, successful responses or tool turns", () => {
    for (const finish of [undefined, "stop", "tool-calls", "unknown"]) {
      expect(outputLimitKey({ finish }, [])).toBeUndefined()
    }
    expect(outputLimitKey({ finish: "length", error: { name: "MessageAbortedError" } }, [])).toBeUndefined()
  })
})
