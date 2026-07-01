import { describe, expect, test } from "bun:test"

import {
  audioExtensionForMimeType,
  dictationInsertionText,
  dictationShortcutLabel,
  dictationStatusLabel,
  isDictationCancelShortcut,
  preferredDictationMimeType,
} from "./dictation"

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

  test("formats dictation keyboard shortcut labels per platform", () => {
    expect(dictationShortcutLabel("MacIntel")).toBe("Cmd+Shift+M")
    expect(dictationShortcutLabel("Win32")).toBe("Ctrl+Shift+M")
    expect(dictationShortcutLabel("Linux x86_64")).toBe("Ctrl+Shift+M")
  })

  test("detects Escape as the dictation cancel shortcut", () => {
    expect(isDictationCancelShortcut({ key: "Escape" })).toBe(true)
    expect(isDictationCancelShortcut({ key: "Esc" })).toBe(true)
    expect(isDictationCancelShortcut({ key: "Enter" })).toBe(false)
  })

  test("labels active dictation states for the recording indicator", () => {
    expect(dictationStatusLabel("recording")).toBe("Recording...")
    expect(dictationStatusLabel("transcribing")).toBe("Transcribing...")
    expect(dictationStatusLabel("idle")).toBe("")
  })
})
