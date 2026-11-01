import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptInputV2Attachments, largePaste } from "./attachments"
import type { PromptInputV2Prompt } from "./types"

function setup() {
  let prompt: PromptInputV2Prompt = [{ type: "text", content: "", start: 0, end: 0 }]
  const inserted: PromptInputV2Prompt[number][] = []
  const stored: File[] = []
  const attachments = createRoot(() =>
    createPromptInputV2Attachments({
      directory: () => "/",
      isDialogActive: () => false,
      warn: () => {},
      duplicate: () => {},
      onError: () => {},
      store: async (file) => {
        stored.push(file)
        return { id: `blob-${stored.length}`, url: `blob:${stored.length}` }
      },
      capture: () => ({
        current: () => prompt,
        cursor: () => 0,
        set: (next) => {
          prompt = next
        },
      }),
      // Only consulted for the cursor when capture() has none, so it never needs to be a real node.
      editor: () => ({}) as HTMLElement,
      focusEditor: () => {},
      addPart: (part) => {
        inserted.push(part)
        return true
      },
      setDraggingType: () => {},
    }),
  )
  const paste = (text: string) =>
    attachments.handlePaste({
      clipboardData: { items: [], getData: () => text },
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as ClipboardEvent)
  return { paste, prompt: () => prompt, inserted, stored }
}

describe("prompt input v2 large paste", () => {
  test("attaches a large paste as a text file instead of inserting it", async () => {
    const { paste, prompt, inserted, stored } = setup()
    const text = "The quick brown fox jumps over the lazy dog.\n".repeat(500)

    await paste(text)

    expect(inserted).toHaveLength(0)
    expect(stored).toHaveLength(1)
    expect(await stored[0].text()).toBe(text)
    expect(prompt().filter((part) => part.type === "image")).toEqual([
      expect.objectContaining({ filename: "pasted-text.txt", mime: "text/plain" }),
    ])
  })

  test("still inserts a short multi-line paste into the editor", async () => {
    const { paste, inserted, stored } = setup()

    await paste("first line\nsecond line")

    expect(stored).toHaveLength(0)
    expect(inserted).toEqual([expect.objectContaining({ type: "text", content: "first line\nsecond line" })])
  })

  test("counts a paste as large from 8,000 characters or 120 line breaks", () => {
    expect(largePaste("x".repeat(7_999))).toBe(false)
    expect(largePaste("x".repeat(8_000))).toBe(true)
    expect(largePaste("\n".repeat(119))).toBe(false)
    expect(largePaste("\n".repeat(120))).toBe(true)
  })
})
