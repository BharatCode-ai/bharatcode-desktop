import { test, expect } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "./utils/mock-server"
import { fixture } from "./performance/timeline/session-timeline-stress.fixture"
import { installStressSessionTabs, stressSessionHref } from "./performance/timeline/timeline-test-helpers"

for (const newLayoutDesigns of [false, true]) {
  test(`model markdown remains sanitized in ${newLayoutDesigns ? "new" : "legacy"} layout`, async ({ page }) => {
    if (!newLayoutDesigns) await page.clock.setFixedTime(new Date("2026-09-13T12:00:00Z"))
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const user = structuredClone(fixture.messages[fixture.sourceID].find((message) => message.info.role === "user")!)
    const assistant = structuredClone(
      fixture.messages[fixture.sourceID].find((message) => message.info.role === "assistant")!,
    )
    const messages = [
      user,
      {
        info: { ...assistant.info, parentID: user.info.id, summary: false },
        parts: [
          {
            id: "prt_sanitizer",
            type: "text",
            messageID: assistant.info.id,
            sessionID: fixture.sourceID,
            text: `Safe markdown sentinel.

<a href="https://example.test/safe" target="_blank">Safe external link</a>
<a href="javascript:window.__markdownInjected=true">Unsafe link target</a>
<img src="/missing-sanitizer-fixture.png" onerror="window.__markdownInjected=true">
<svg onload="window.__markdownInjected=true"><path d="M0 0"></path></svg>
<script>window.__markdownInjected=true</script>
<style>body { display: none }</style>
<iframe src="https://example.test/frame"></iframe>`,
          },
        ],
      },
    ]
    await page.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1" ? route.fallback() : route.abort(),
    )
    await mockOpenCodeServer(page, {
      protocol: "v1",
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages: (id) => ({ items: id === fixture.sourceID ? messages : [] }),
    })
    await installStressSessionTabs(page)
    await page.addInitScript((enabled) => {
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.31" }))
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: enabled } }))
    }, newLayoutDesigns)
    await page.goto(
      newLayoutDesigns
        ? stressSessionHref(fixture.sourceID)
        : `/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`,
    )
    await expect(page.getByText("Safe markdown sentinel.", { exact: true })).toBeVisible()
    const markdown = page.locator('[data-component="markdown"]').filter({ hasText: "Safe markdown sentinel." })
    await expect(markdown.locator("script, style, iframe, [onload], [onerror], [href^='javascript:']")).toHaveCount(0)
    const safe = markdown.getByRole("link", { name: "Safe external link", exact: true })
    await expect(safe).toHaveAttribute("href", "https://example.test/safe")
    await expect(safe).toHaveAttribute("rel", /noopener/)
    await expect(safe).toHaveAttribute("rel", /noreferrer/)
    await expect(markdown.getByText("Unsafe link target", { exact: true })).not.toHaveAttribute("href")
    expect(await page.evaluate(() => Reflect.get(window, "__markdownInjected"))).toBeUndefined()
    expect(errors).toEqual([])
  })
}
