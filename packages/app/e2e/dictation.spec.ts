import { test, expect } from "@playwright/test"
import { mockOpenCodeServer } from "./utils/mock-server"
import { fixture, pageMessages } from "./performance/timeline/session-timeline-stress.fixture"
import { installStressSessionTabs, stressSessionHref } from "./performance/timeline/timeline-test-helpers"
import { base64Encode } from "@opencode-ai/core/util/encode"

for (const newLayoutDesigns of [false, true]) {
  test(`dictation inserts text and recovers errors in ${newLayoutDesigns ? "new" : "legacy"} composer`, async ({
    page,
  }) => {
    if (!newLayoutDesigns) await page.clock.setFixedTime(new Date("2026-09-13T12:00:00Z"))
    const failures: string[] = []
    page.on("pageerror", (error) => failures.push(error.message))
    await page.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1" ? route.fallback() : route.abort(),
    )
    await mockOpenCodeServer(page, {
      sessions: structuredClone(fixture.sessions),
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
    })
    await installStressSessionTabs(page)
    await page.addInitScript((enabled) => {
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.31" }))
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: enabled } }))
      Object.defineProperty(navigator, "mediaDevices", {
        value: {
          getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
        },
      })
      class Recorder {
        static isTypeSupported() {
          return true
        }
        state = "inactive"
        mimeType = "audio/webm"
        onstop?: () => void
        ondataavailable?: (event: { data: Blob }) => void
        start() {
          this.state = "recording"
        }
        stop() {
          this.state = "inactive"
          this.ondataavailable?.({ data: new Blob(["synthetic-audio"], { type: this.mimeType }) })
          this.onstop?.()
        }
      }
      Object.defineProperty(window, "MediaRecorder", { value: Recorder })
    }, newLayoutDesigns)
    let requests = 0
    let available = true
    await page.route("**/account/dictation**", async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: { available, maxBytes: 1000 } })
      requests++
      expect(route.request().postDataJSON()).toEqual({ audio: btoa("synthetic-audio"), mimeType: "audio/webm" })
      if (requests === 1) return route.fulfill({ status: 503, json: { message: "secret-token=/private/audio" } })
      return route.fulfill({ json: { text: "<script>literal transcript</script>" } })
    })
    await page.goto(
      newLayoutDesigns
        ? stressSessionHref(fixture.sourceID)
        : `/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`,
    )
    await expect(page.getByRole("heading", { name: fixture.expected.sourceTitle, exact: true })).toBeVisible()
    const editor = page.locator('[contenteditable="true"][role="textbox"]')
    await expect(editor).toBeEditable()
    await editor.fill("Keep my draft")
    await editor.press("End")
    const start = page.getByRole("button", { name: "Dictate", exact: true })
    await expect(start).toBeEnabled()
    await start.click()
    await page.getByRole("button", { name: "Stop recording", exact: true }).click()
    await expect(page.getByRole("alert")).toHaveText(
      "Could not transcribe audio. Check Account settings or try recording again.",
    )
    await expect(editor).toHaveText("Keep my draft")
    await expect(page.locator("body")).not.toContainText("secret-token")
    await start.click()
    await page.getByRole("button", { name: "Stop recording", exact: true }).click()
    await expect(editor).toHaveText("Keep my draft <script>literal transcript</script>")
    await expect(editor.locator("script")).toHaveCount(0)
    await expect(page.getByRole("alert")).toHaveCount(0)
    await page.screenshot({ path: `/tmp/bc-dictation-${newLayoutDesigns ? "new" : "legacy"}.png` })
    await start.click()
    await page.keyboard.press("Escape")
    await expect(start).toBeEnabled()
    expect(requests).toBe(2)
    available = false
    await page.reload()
    await expect(page.getByRole("heading", { name: fixture.expected.sourceTitle, exact: true })).toBeVisible()
    await expect(start).toHaveCount(0)
    expect(failures).toEqual([])
  })
}
