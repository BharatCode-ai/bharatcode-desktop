import { test, expect, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "./utils/mock-server"
import { fixture } from "./performance/timeline/session-timeline-stress.fixture"
import { installStressSessionTabs, stressSessionHref } from "./performance/timeline/timeline-test-helpers"

const routeKey = "opencode.desktop.window.browser.last-active-url"
const saved = (page: Page) => page.evaluate((key) => localStorage.getItem(key), routeKey)
const href = (newLayout: boolean, id: string) =>
  newLayout ? stressSessionHref(id) : `/${base64Encode(fixture.directory)}/session/${id}`

async function setup(page: Page, newLayout = true, initial = href(newLayout, fixture.sourceID), omitSelected = false) {
  if (!newLayout) await page.clock.setFixedTime(new Date("2026-09-13T12:00:00Z"))
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.fallback() : route.abort(),
  )
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: omitSelected ? fixture.sessions.filter((session) => session.id !== fixture.sourceID) : fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages: (id) => ({
      items: (fixture.messages[id as keyof typeof fixture.messages] ?? []).slice(0, 2).map((message) => ({
        info: message.info,
        parts: [
          {
            id: `prt_restore_${message.info.id}`,
            type: "text",
            messageID: message.info.id,
            sessionID: id,
            text: `Preserved ${message.info.role} message for ${id}`,
          },
        ],
      })),
    }),
  })
  await installStressSessionTabs(page)
  await page.addInitScript(
    ({ newLayout, initial, key }) => {
      localStorage.setItem("default.dat:app-version.v1", JSON.stringify({ version: "1.18.31" }))
      localStorage.setItem("default.dat:settings.v3", JSON.stringify({ general: { newLayoutDesigns: newLayout } }))
      if (!localStorage.getItem("startup-fixture-seeded")) {
        localStorage.setItem(key, initial)
        localStorage.setItem("startup-fixture-seeded", "yes")
      }
    },
    { newLayout, initial, key: routeKey },
  )
}

for (const newLayout of [false, true]) {
  test(`actual desktop router restores older selected conversation and messages in ${newLayout ? "new" : "legacy"} layout`, async ({
    page,
  }) => {
    await setup(page, newLayout)
    await page.goto("/e2e/reproduction/startup/index.html")
    await expect(page.locator("html")).toHaveAttribute("data-route", href(newLayout, fixture.sourceID))
    await expect(page.getByText(`Preserved assistant message for ${fixture.sourceID}`, { exact: true })).toBeVisible()
    // Navigate to a different conversation and let the actual Desktop
    // router listener persist it. Seeding does not run again on reload.
    await page.evaluate(
      (path) => window.dispatchEvent(new CustomEvent("fixture:navigate", { detail: path })),
      href(newLayout, fixture.targetID),
    )
    await expect(page.locator("html")).toHaveAttribute("data-route", href(newLayout, fixture.targetID))
    await expect.poll(() => saved(page)).toBe(href(newLayout, fixture.targetID))
    await page.evaluate(
      (path) => window.dispatchEvent(new CustomEvent("fixture:navigate", { detail: path })),
      href(newLayout, fixture.sourceID),
    )
    await expect.poll(() => saved(page)).toBe(href(newLayout, fixture.sourceID))
    await page.reload()
    await expect(page.locator("html")).toHaveAttribute("data-route", href(newLayout, fixture.sourceID))
    await expect(page.getByText(`Preserved assistant message for ${fixture.sourceID}`, { exact: true })).toBeVisible()
    expect(await saved(page)).toBe(href(newLayout, fixture.sourceID))
  })
}

test("saved Home is preserved, rather than replaced by a recent tab", async ({ page }) => {
  await setup(page)
  await page.goto("/e2e/reproduction/startup/index.html")
  await expect(page.locator('[data-component="session-turn"]').first()).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture:navigate", { detail: "/" })))
  await expect.poll(() => saved(page)).toBe("/")
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-route", "/")
  await expect(page.locator('[data-component="session-turn"]')).toHaveCount(0)
  expect(await saved(page)).toBe("/")
})

test("separate Desktop window IDs restore independent routes", async ({ page }) => {
  await setup(page)
  await page.addInitScript(
    (path) => {
      const key = "opencode.desktop.window.second.last-active-url"
      if (localStorage.getItem(key) === null) localStorage.setItem(key, path)
    },
    href(true, fixture.targetID),
  )
  await page.goto("/e2e/reproduction/startup/index.html?window=second")
  await expect(page.locator("html")).toHaveAttribute("data-route", href(true, fixture.targetID))
  await expect(page.getByText(`Preserved assistant message for ${fixture.targetID}`, { exact: true })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("fixture:navigate", { detail: "/" })))
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("opencode.desktop.window.second.last-active-url")))
    .toBe("/")
  expect(await saved(page)).toBe(href(true, fixture.sourceID))
  await page.goto("/e2e/reproduction/startup/index.html")
  await expect(page.locator("html")).toHaveAttribute("data-route", href(true, fixture.sourceID))
  await expect(page.getByText(`Preserved assistant message for ${fixture.sourceID}`, { exact: true })).toBeVisible()
})

test("a failed session lookup does not overwrite the Desktop route; reload retries it", async ({ page }) => {
  await setup(page, true, href(true, fixture.sourceID), true)
  let failing = true
  await page.route(`**/session/${fixture.sourceID}`, (route) =>
    failing
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "Synthetic lookup unavailable" }),
        })
      : route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(fixture.sessions.find((session) => session.id === fixture.sourceID)),
        }),
  )
  await page.goto("/e2e/reproduction/startup/index.html")
  await expect(page.locator("html")).toHaveAttribute("data-route", href(true, fixture.sourceID))
  await expect(page.getByText("Something went wrong", { exact: true })).toBeVisible()
  expect(await saved(page)).toBe(href(true, fixture.sourceID))
  failing = false
  await page.reload()
  await expect(page.locator('[data-component="session-turn"]').first()).toBeVisible()
  expect(await saved(page)).toBe(href(true, fixture.sourceID))
})
