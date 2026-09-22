import { test, expect } from "@playwright/test"
import { mockOpenCodeServer } from "./utils/mock-server"
import { fixture, pageMessages } from "./performance/timeline/session-timeline-stress.fixture"
import { installStressSessionTabs, stressSessionHref } from "./performance/timeline/timeline-test-helpers"
import type { SessionGoal } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"

for (const newLayoutDesigns of [false, true]) {
  test(`Goal Mode persists and recovers failed edits in ${newLayoutDesigns ? "new" : "legacy"} layout`, async ({
    page,
  }) => {
    // Upstream retires the legacy layout on September 14; exercise it before that boundary.
    if (!newLayoutDesigns) await page.clock.setFixedTime(new Date("2026-09-13T12:00:00Z"))
    const failures: string[] = []
    page.on("pageerror", (error) => failures.push(error.message))
    const sessions = structuredClone(fixture.sessions) as Array<
      (typeof fixture.sessions)[number] & { goal?: SessionGoal }
    >
    const current = sessions.find((session) => session.id === fixture.sourceID)!
    current.goal = { text: "Finish the local catch-up", status: "paused", created: 1, updated: 2, accumulated: 60000 }
    await page.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1" ? route.fallback() : route.abort(),
    )
    await mockOpenCodeServer(page, {
      sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
    })
    await installStressSessionTabs(page)
    await page.addInitScript((enabled) => {
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.31" }))
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: enabled } }))
    }, newLayoutDesigns)
    let requests = 0
    let release!: () => void
    let hold = true
    await page.route(`**/session/${fixture.sourceID}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback()
      requests++
      if (requests === 1) return route.fulfill({ status: 503, json: { message: "secret-token=/private/credential" } })
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      const { goal } = route.request().postDataJSON()
      current.time.updated = Date.now()
      if (goal.action === "clear") delete current.goal
      else
        current.goal = {
          ...current.goal!,
          text: goal.text ?? current.goal!.text,
          status: goal.action === "pause" ? "paused" : "active",
          updated: current.time.updated,
        }
      await route.fulfill({ json: current })
    })
    await page.goto(
      newLayoutDesigns
        ? stressSessionHref(fixture.sourceID)
        : `/${base64Encode(fixture.directory)}/session/${fixture.sourceID}`,
    )
    await expect(page.getByRole("heading", { name: fixture.expected.sourceTitle, exact: true })).toBeVisible()
    const ribbon = page.getByRole("region", { name: "Goal Mode", exact: true })
    await expect(ribbon).toContainText("Finish the local catch-up")
    await expect(ribbon.getByRole("button", { name: "Resume", exact: true })).toBeEnabled()
    await ribbon.getByRole("button", { name: "Edit", exact: true }).click()
    const objective = ribbon.getByRole("textbox", { name: "Goal Mode objective", exact: true })
    await objective.fill("Complete <script>literal text</script> safely")
    await ribbon.getByRole("button", { name: "Save", exact: true }).click()
    await expect(ribbon.getByRole("alert")).toHaveText(
      "Could not confirm the goal update. Check your connection, then try again.",
    )
    await expect(objective).toHaveValue("Complete <script>literal text</script> safely")
    await expect(ribbon).not.toContainText("secret-token")
    await ribbon.getByRole("button", { name: "Save", exact: true }).click()
    await expect.poll(() => requests).toBe(2)
    await expect(ribbon.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
    await expect(ribbon.getByRole("status")).toHaveText("Updating goal…")
    hold = false
    release()
    await expect(objective).toHaveCount(0)
    await expect(ribbon).toContainText("Complete <script>literal text</script> safely")
    await expect(ribbon.getByRole("button", { name: "Pause", exact: true })).toBeEnabled()
    await page.screenshot({ path: `/tmp/bc-goal-${newLayoutDesigns ? "new" : "legacy"}.png` })
    await page.reload()
    await expect(ribbon).toContainText("Complete <script>literal text</script> safely")
    await ribbon.getByRole("button", { name: "Pause", exact: true }).click()
    await expect(ribbon.getByRole("button", { name: "Resume", exact: true })).toBeEnabled()
    await ribbon.getByRole("button", { name: "Resume", exact: true }).click()
    await expect.poll(() => requests).toBe(4)
    await expect.poll(() => current.goal?.status).toBe("active")
    await expect(ribbon.getByRole("button", { name: "Pause", exact: true })).toBeEnabled()
    await ribbon.getByRole("button", { name: "Clear", exact: true }).click()
    await expect(ribbon.getByRole("button", { name: "Goal Mode", exact: true })).toBeEnabled()
    await page.reload()
    await expect(ribbon.getByRole("button", { name: "Goal Mode", exact: true })).toBeEnabled()
    expect(requests).toBe(5)
    expect(failures).toEqual([])
  })
}
