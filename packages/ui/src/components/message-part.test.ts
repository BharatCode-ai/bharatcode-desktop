import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { renderable } from "./message-part-rendering"
import { readPartText } from "./message-part-text"

function toolPart(tool: string): ToolPart {
  return {
    id: `${tool}-part`,
    sessionID: "ses_test",
    messageID: "msg_test",
    type: "tool",
    tool,
    callID: `${tool}-call`,
    state: {
      status: "completed",
      input: {},
      output: "ok",
      title: tool,
      time: {
        start: 1,
        end: 2,
      },
    },
  } as ToolPart
}

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("renderable", () => {
  test("hides Goal Mode control tools while keeping normal tools visible", () => {
    expect(renderable(toolPart("mcp_goal_set"))).toBe(false)
    expect(renderable(toolPart("mcp_goal_complete"))).toBe(false)
    expect(renderable(toolPart("mcp_goal_blocker"))).toBe(false)
    expect(renderable(toolPart("bash"))).toBe(true)
  })
})
