/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ACCESS_DENIAL_MESSAGE } from "@opencode-ai/core/util/access-denial"
import { AccessDenial } from "../../../src/cli/cmd/tui/component/access-denial"

test("TUI renders both access paragraphs with readable link destinations", async () => {
  const app = await testRender(() => <AccessDenial message={ACCESS_DENIAL_MESSAGE} fg={RGBA.fromHex("#aaaaaa")} />, {
    width: 100,
    height: 12,
  })
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("BharatCode App requires Pro or student access.")
    expect(frame).toContain("https://bharatcode.ai/subscribe")
    expect(frame).toContain("help@bharatcode.ai")
    expect(frame).toContain("https://chat.bharatcode.ai")
    expect(frame).toContain("is free for everyone.")
  } finally {
    app.renderer.destroy()
  }
})

test("TUI preserves unrelated error text", async () => {
  const app = await testRender(() => <AccessDenial message="Heavy-tier Pro required" fg={RGBA.fromHex("#aaaaaa")} />, {
    width: 60,
    height: 4,
  })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Heavy-tier Pro required")
    expect(app.captureCharFrame()).not.toContain("Subscribe")
  } finally {
    app.renderer.destroy()
  }
})
