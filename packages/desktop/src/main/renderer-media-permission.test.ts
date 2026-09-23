import { expect, test } from "bun:test"
import { allowMicrophonePermission } from "./renderer-media-permission"

test("microphone permission is audio-only and bound to the trusted main window", () => {
  const trusted = { ownerID: 7, senderID: 7, trusted: true, isMainFrame: true }
  expect(allowMicrophonePermission({ ...trusted, mediaTypes: ["audio"] })).toBe(true)
  expect(allowMicrophonePermission({ ...trusted, mediaType: "audio" })).toBe(true)
  for (const override of [
    { senderID: 8 },
    { senderID: undefined },
    { trusted: false },
    { isMainFrame: false },
    { mediaTypes: [] },
    { mediaTypes: ["video"] },
    { mediaTypes: ["audio", "video"] },
  ])
    expect(allowMicrophonePermission({ ...trusted, mediaTypes: ["audio"], ...override })).toBe(false)
  for (const mediaType of [undefined, "video", "unknown"])
    expect(allowMicrophonePermission({ ...trusted, mediaType })).toBe(false)
})
