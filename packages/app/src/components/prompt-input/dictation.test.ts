import { describe, expect, test } from "bun:test"

import { audioExtensionForMimeType, dictationInsertionText, preferredDictationMimeType } from "./dictation"

describe("prompt dictation helpers", () => {
  test("chooses the first MediaRecorder mime type supported by the browser", () => {
    const supported = new Set(["audio/ogg;codecs=opus", "audio/webm"])

    expect(preferredDictationMimeType((mime) => supported.has(mime))).toBe("audio/webm")
  })

  test("maps recorder mime types to upload filename extensions", () => {
    expect(audioExtensionForMimeType("audio/webm;codecs=opus")).toBe("webm")
    expect(audioExtensionForMimeType("audio/mp4")).toBe("m4a")
    expect(audioExtensionForMimeType("audio/ogg")).toBe("ogg")
    expect(audioExtensionForMimeType("")).toBe("webm")
  })

  test("adds spacing when inserting a transcript inside existing prompt text", () => {
    expect(
      dictationInsertionText({
        textBeforeCursor: "fix",
        transcript: "the flaky tests",
        textAfterCursor: "please",
      }),
    ).toBe(" the flaky tests ")

    expect(
      dictationInsertionText({
        textBeforeCursor: "fix ",
        transcript: "the flaky tests.",
        textAfterCursor: "",
      }),
    ).toBe("the flaky tests.")
  })
})
