import { describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"

mock.module("@opencode-ai/ui/message-part", () => ({
  groupParts: (refs: { part: Part }[]) => refs.map((ref) => ({ key: ref.part.id, refs: [ref] })),
  renderable: (part: Part) => part.type === "text",
}))

const { Timeline } = await import("./message-timeline.data")

const idle = "idle" as SessionStatus["type"]

function user(id: string): UserMessage {
  return {
    id,
    role: "user",
    sessionID: "ses_test",
    time: { created: 1 },
  } as UserMessage
}

function assistant(input: { id: string; parentID: string; summary?: boolean }): AssistantMessage {
  return {
    id: input.id,
    role: "assistant",
    parentID: input.parentID,
    sessionID: "ses_test",
    summary: input.summary,
    time: { created: 2, completed: 3 },
  } as AssistantMessage
}

function part(input: Partial<Part> & { id: string; messageID: string; type: Part["type"] }): Part {
  return {
    sessionID: "ses_test",
    time: { start: 1 },
    ...input,
  } as Part
}

describe("session message timeline rows", () => {
  test("hides compaction summary assistant text from the visible chat timeline", () => {
    const parts = new Map<string, Part[]>([
      ["msg_compact", [part({ id: "part_compact", messageID: "msg_compact", type: "compaction", auto: true })]],
      [
        "msg_summary",
        [
          part({
            id: "part_summary",
            messageID: "msg_summary",
            type: "text",
            text: "## Goal\n- Preserve this for model context, not chat display.",
          }),
        ],
      ],
    ])

    const rows = Timeline.constructMessageRows(
      user("msg_compact"),
      (messageID) => parts.get(messageID) ?? [],
      [assistant({ id: "msg_summary", parentID: "msg_compact", summary: true })],
      0,
      true,
      idle,
      false,
    )

    expect(rows.some((row) => row._tag === "TurnDivider" && row.label === "compaction")).toBe(true)
    expect(rows.some((row) => row._tag === "AssistantPart")).toBe(false)
  })
})
