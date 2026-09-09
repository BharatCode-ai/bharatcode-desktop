import { describe, expect, test } from "bun:test"
import { accessDenialParagraphs, ACCESS_DENIAL_MESSAGE, accessDenialPlainLink } from "./access-denial"

const message =
  "BharatCode App requires Pro or student access. Subscribe to Pro (https://bharatcode.ai/subscribe), or sign in with your student email. Need verification? Contact help@bharatcode.ai.\n\nBharatCode Chat (https://chat.bharatcode.ai) is free for everyone."

describe("general access denial presentation", () => {
  test("matches the agreed two-paragraph plain transport exactly", () => {
    expect(ACCESS_DENIAL_MESSAGE).toBe(message)
    const paragraphs = accessDenialParagraphs(message)!
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs.map((parts) => parts.map(accessDenialPlainLink).join("")).join("\n\n")).toBe(message)
    expect(
      paragraphs
        .flat()
        .filter((part) => part.href)
        .map((part) => part.href),
    ).toEqual(["https://bharatcode.ai/subscribe", "mailto:help@bharatcode.ai", "https://chat.bharatcode.ai"])
  })

  test("unknown, modified, heavy-tier and hostile messages never gain links", () => {
    for (const value of [
      "Heavy tier requires Pro",
      message + " ",
      message.replace("https://bharatcode.ai/subscribe", "https://evil.invalid"),
      "<a href='javascript:alert(1)'>Subscribe</a>",
      "\u001b]8;;https://evil.invalid\u0007click",
      message.replace("help@bharatcode.ai", "help@evil.invalid"),
    ]) {
      expect(accessDenialParagraphs(value)).toBeUndefined()
    }
  })
})
